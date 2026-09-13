import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { FileRecord } from './domain.js';

export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const lineCount = (text: string): number => text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 20_000;
const blockedDirs = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.idea', '.vscode', '.coderecall', '__pycache__', 'logs', 'tmp', 'temp', 'customer-data', 'credentials', 'secrets']);
const blockedNames = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.DS_Store|Thumbs\.db|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*(?:credentials?|secrets?)(?:[._-].*)?)$/i;
const blockedExtensions = /\.(?:pem|key|crt|cer|p12|pfx|keystore|log|sqlite|db|csv|parquet|zip|gz|tar|exe|dll|so|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|mp4|mp3|map)$/i;

export function secretDetected(text: string): boolean {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----/.test(text)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,})\b/.test(text)
    || /(?:api[_-]?key|secret|password|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9_+\-/=]{16,}["']/i.test(text)
    || /:\/\/[^\s/:]+:[^\s/@]+@/.test(text);
}

export function git(root: string, args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function assertNoSymlinkComponents(target: string): Promise<void> {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed in operation paths.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** Resolve filesystem aliases without allowing symlinks; only the final component may be absent. */
export async function canonicalOperationPath(target: string): Promise<string> {
  await assertNoSymlinkComponents(target);
  const absolute = path.resolve(target);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(await realpath(path.dirname(absolute)), path.basename(absolute));
  }
}

export async function repositoryRoot(input: string): Promise<string> {
  await assertNoSymlinkComponents(input);
  const root = await realpath(input);
  let actual: string;
  try { actual = await realpath(git(root, ['rev-parse', '--show-toplevel'])); }
  catch { throw new Error('Source must be a local Git repository with a committed HEAD.'); }
  if (path.relative(root, actual) !== '') throw new Error('Index the repository root, not a subdirectory.');
  git(root, ['rev-parse', '--verify', 'HEAD']);
  return root;
}

interface IgnoreScope { base: string; matcher: Ignore; kind: 'git' | 'recall' }
export interface Inventory {
  files: FileRecord[];
  content: Map<string, string>;
  exclusions: Record<string, number>;
  snapshot: string;
}

export async function inventory(root: string, trackedOnly = true): Promise<Inventory> {
  const tracked = new Map<string, string>();
  if (trackedOnly) {
    for (const entry of git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
      const match = /^(\d+) [a-f0-9]+ \d\t([\s\S]*)$/.exec(entry);
      if (match?.[1] && match[2]) tracked.set(match[2], match[1]);
    }
  }
  const files: FileRecord[] = [];
  const content = new Map<string, string>();
  const exclusions: Record<string, number> = {};
  let totalBytes = 0;
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const ignored = (relative: string, scopes: IgnoreScope[]) => {
    const state = { git: false, recall: false };
    for (const scope of scopes) {
      const local = scope.base ? relative.slice(scope.base.length + 1) : relative;
      if (!local) continue;
      const matched = scope.matcher.test(local);
      if (matched.ignored) state[scope.kind] = true;
      else if (matched.unignored) state[scope.kind] = false;
    }
    return state.git || state.recall;
  };

  async function walk(relative: string, scopes: IgnoreScope[]): Promise<void> {
    const absolute = path.join(root, relative);
    const localScopes = [...scopes];
    for (const name of ['.gitignore', '.coderecallignore']) {
      const config = path.join(absolute, name);
      try {
        const stat = await lstat(config);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_FILE_BYTES) {
          localScopes.push({ base: relative, matcher: ignore().add(await readFile(config, 'utf8')), kind: name === '.gitignore' ? 'git' : 'recall' });
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const entries = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name.includes('\\') || [...entry.name].some(character => character.charCodeAt(0) < 32)) { exclude('unsafe-path'); continue; }
      if (entry.isSymbolicLink()) { exclude('symlink'); continue; }
      if (blockedDirs.has(entry.name.toLowerCase()) || blockedNames.test(entry.name) || blockedExtensions.test(entry.name)) { exclude('default-policy'); continue; }
      if (ignored(rel + (entry.isDirectory() ? '/' : ''), localScopes)) { exclude('ignore-rule'); continue; }
      if (entry.isDirectory()) {
        if (tracked.get(rel) === '160000') { exclude('submodule'); continue; }
        try {
          await lstat(path.join(root, rel, '.git'));
          exclude('nested-repository');
          continue;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (trackedOnly && ![...tracked.keys()].some(file => file.startsWith(`${rel}/`))) { exclude('untracked'); continue; }
        await walk(rel, localScopes);
        continue;
      }
      if (!entry.isFile()) { exclude('special-file'); continue; }
      if (trackedOnly && !tracked.has(rel)) { exclude('untracked'); continue; }
      if (tracked.get(rel) === '120000') { exclude('symlink'); continue; }
      const filePath = path.join(root, rel);
      const stat = await lstat(filePath);
      if (stat.isSymbolicLink() || stat.nlink > 1) { exclude('linked-file'); continue; }
      if (stat.size > MAX_FILE_BYTES) { exclude('large-file'); continue; }
      const buffer = await readFile(filePath);
      if (buffer.length > MAX_FILE_BYTES) throw new Error('File changed during inventory.');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { exclude('binary'); continue; }
      if (buffer.includes(0)) { exclude('binary'); continue; }
      if (secretDetected(text)) { exclude('secret-scan'); continue; }
      totalBytes += buffer.length;
      if (files.length >= MAX_FILES || totalBytes > MAX_TOTAL_BYTES) throw new Error('Repository exceeds V0.1 inventory limits (20,000 files / 64 MiB).');
      files.push({ path: rel, hash: hash(buffer), bytes: buffer.length, lines: lineCount(text), executable: trackedOnly ? tracked.get(rel) === '100755' : (stat.mode & 0o111) !== 0 });
      content.set(rel, text);
    }
  }
  await walk('', []);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { files, content, exclusions, snapshot: hash(JSON.stringify(files)) };
}
