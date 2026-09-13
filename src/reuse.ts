import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { AdaptationPlan, FileRecord, ReuseRecord } from './domain.js';
import { fingerprint } from './analyzer.js';
import { scoreProject } from './scoring.js';
import { assertNoSymlinkComponents, hash, inside, inventory, secretDetected } from './safety.js';
import { RepositoryStore } from './store.js';

export async function validateDestination(source: string, input: string, memory: string): Promise<string> {
  const destination = path.resolve(input);
  await assertNoSymlinkComponents(destination);
  if (inside(source, destination) || inside(destination, source)) throw new Error('Source and destination must not overlap.');
  const memoryPath = path.resolve(memory);
  if (inside(memoryPath, destination) || inside(destination, memoryPath)) throw new Error('Destination must not overlap the memory directory.');
  try {
    await lstat(destination);
    throw new Error('Destination already exists. Choose a new path; existing directories are never overwritten.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = await realpath(path.dirname(destination));
  if (!(await lstat(parent)).isDirectory()) throw new Error('Destination parent must be a directory.');
  return destination;
}

export async function currentPlanSource(store: RepositoryStore, plan: AdaptationPlan) {
  const stored = store.project(plan.sourceProject);
  const current = await fingerprint(stored.root, stored.policy);
  if (current.snapshot !== plan.sourceSnapshot || current.sourceCommit !== plan.sourceCommit) throw new Error('Source changed since planning. Reindex and create a new plan.');
  current.verification = stored.verification;
  const candidate = scoreProject(current, plan.requirements, plan.thresholds);
  if (candidate.decision !== 'project') throw new Error(`Full-project reuse blocked: ${candidate.blockers.join(' ')}`);
  return current;
}

export async function prepareReuse(store: RepositoryStore, planId: string, input: string, dryRun = true) {
  const plan = store.plan(planId);
  const source = await currentPlanSource(store, plan);
  const destination = await validateDestination(source.root, input, store.directory);
  const preview = {
    dryRun, sourceProject: source.id, sourceCommit: source.sourceCommit, destination,
    files: source.files.map(file => file.path), exclusions: source.exclusions,
    metrics: { filesCopied: source.files.length, linesCopied: source.files.reduce((sum, file) => sum + file.lines, 0), bytesCopied: source.files.reduce((sum, file) => sum + file.bytes, 0), generatedSourceTokens: 0 as const },
    actions: plan.actions,
  };
  if (dryRun) return { ...preview, reuseId: null };
  const buffers = new Map<string, Buffer>();
  for (const file of source.files) {
    const inputPath = path.join(source.root, file.path);
    if (!inside(source.root, inputPath) || path.isAbsolute(file.path)) throw new Error('Unsafe source path.');
    await assertNoSymlinkComponents(inputPath);
    const stat = await lstat(inputPath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Source file changed during copy preparation.');
    const buffer = await readFile(inputPath);
    if (hash(buffer) !== file.hash || secretDetected(buffer.toString('utf8'))) throw new Error('Source changed or contains a potential secret; reindex.');
    buffers.set(file.path, buffer);
  }
  await currentPlanSource(store, plan);
  await validateDestination(source.root, destination, store.directory);
  // mkdir is exclusive: never replace even an empty destination created concurrently.
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const file of source.files) {
      const output = path.join(destination, file.path);
      if (!inside(destination, output)) throw new Error('Unsafe target path.');
      await assertNoSymlinkComponents(output);
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, buffers.get(file.path)!, { flag: 'wx', mode: 0o600 });
      if (file.executable) await chmod(output, 0o700);
    }
    const record: ReuseRecord = {
      schemaVersion: 1, id: randomUUID(), planId, sourceProject: source.id, sourceRoot: source.root,
      sourceCommit: source.sourceCommit, sourceSnapshot: source.snapshot, destination,
      at: new Date().toISOString(), policy: source.policy, license: source.license, files: source.files, metrics: preview.metrics,
    };
    const metadata = path.join(destination, '.coderecall');
    await mkdir(metadata, { mode: 0o700 });
    await writeFile(path.join(metadata, 'provenance.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(metadata, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    store.saveReuse(record);
    return { ...preview, reuseId: record.id };
  } catch (error) {
    // Do not recursively delete a directory another process may have changed.
    throw new Error(`Copy did not complete. Inspect the partial destination before removing it: ${destination}`, { cause: error });
  }
}

export async function loadReuse(store: RepositoryStore, target: string): Promise<ReuseRecord> {
  await assertNoSymlinkComponents(target);
  const root = await realpath(target);
  const metadata = path.join(root, '.coderecall', 'provenance.json');
  await assertNoSymlinkComponents(metadata);
  if ((await lstat(metadata)).size > 16 * 1024 * 1024) throw new Error('Provenance file too large.');
  const local: unknown = JSON.parse(await readFile(metadata, 'utf8'));
  if (!local || typeof local !== 'object' || !('id' in local) || typeof local.id !== 'string') throw new Error('Invalid provenance file.');
  const record = store.reuse(local.id);
  if (path.relative(record.destination, root) !== '') throw new Error('Target moved; provenance destination must be reconciled before recording results.');
  return record;
}

export function compareFiles(original: FileRecord[], current: FileRecord[]) {
  const before = new Map(original.map(file => [file.path, file]));
  const after = new Map(current.map(file => [file.path, file]));
  return {
    unchanged: current.filter(file => before.get(file.path)?.hash === file.hash).map(file => file.path),
    modified: current.filter(file => before.has(file.path) && before.get(file.path)?.hash !== file.hash).map(file => file.path),
    removed: original.filter(file => !after.has(file.path)).map(file => file.path),
    added: current.filter(file => !before.has(file.path)).map(file => file.path),
  };
}

export async function provenance(store: RepositoryStore, target: string, file?: string) {
  const record = await loadReuse(store, target);
  const current = await inventory(record.destination, false);
  const diff = compareFiles(record.files, current.files);
  if (!file) return { ...record, current: diff, results: store.results(record.id) };
  const normalized = file.replaceAll('\\', '/');
  if (!inside(record.destination, path.resolve(record.destination, normalized))) throw new Error('File must be inside target.');
  const source = record.files.find(item => item.path === normalized);
  if (!source) return { path: normalized, reuseType: 'not-reused' };
  return {
    path: normalized, sourceRepository: record.sourceRoot, sourceCommit: record.sourceCommit, sourceFile: source.path,
    sourceHash: source.hash, currentHash: current.files.find(item => item.path === normalized)?.hash ?? null,
    reuseType: diff.unchanged.includes(normalized) ? 'copied-verbatim' : diff.modified.includes(normalized) ? 'copied-and-modified' : 'removed-or-excluded',
  };
}
