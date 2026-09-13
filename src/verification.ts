import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import type { ResultRecord, Verification } from './domain.js';
import { fingerprint } from './analyzer.js';
import { compareFiles, loadReuse } from './reuse.js';
import { git, inventory, secretDetected } from './safety.js';
import { RepositoryStore } from './store.js';

export async function runVerification(root: string, command: string[], snapshot: string, trusted: boolean, timeoutMs = 60_000): Promise<Verification> {
  if (!trusted) throw new Error('Verification executes repository code. Explicitly trust the command with --trust.');
  if (!command[0]) throw new Error('Provide an executable and arguments after --.');
  if (secretDetected(command.join(' '))) throw new Error('Do not put credentials in verification commands.');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Timeout must be between 1 and 300000 ms.');
  const started = performance.now();
  // A caller running under node:test must not impose its private IPC protocol on this child.
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: root, shell: false, windowsHide: true, stdio: 'ignore', env: environment });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(new Error('Verification executable could not be started.', { cause: error })); });
    child.once('close', code => { clearTimeout(timer); resolve({ exitCode: code, timedOut }); });
  });
  return {
    status: result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed', command,
    exitCode: result.exitCode, timedOut: result.timedOut, at: new Date().toISOString(), snapshot,
    durationMs: Math.round(performance.now() - started), scope: 'user-selected-command',
  };
}

export async function verifyProject(store: RepositoryStore, id: string, command: string[], trusted: boolean, timeoutMs?: number) {
  const saved = store.project(id);
  const before = await fingerprint(saved.root, saved.policy);
  const result = await runVerification(before.root, command, before.snapshot, trusted, timeoutMs);
  const after = await fingerprint(saved.root, saved.policy);
  if (before.snapshot !== after.snapshot || before.sourceCommit !== after.sourceCommit) throw new Error('Source changed during verification; result not accepted.');
  after.verification = result;
  store.saveProject(after);
  return result;
}

export async function recordResult(store: RepositoryStore, target: string, command: string[], trusted: boolean, timeoutMs?: number): Promise<ResultRecord> {
  const reuse = await loadReuse(store, target);
  const before = await inventory(reuse.destination, false);
  const verification = await runVerification(reuse.destination, command, before.snapshot, trusted, timeoutMs);
  const after = await inventory(reuse.destination, false);
  if (before.snapshot !== after.snapshot) throw new Error('Target source changed during verification; result not accepted.');
  const delta = compareFiles(reuse.files, after.files);
  const count = (paths: string[]) => after.files.filter(file => paths.includes(file.path)).reduce((sum, file) => sum + file.lines, 0);
  let targetCommit: string | null = null;
  try {
    if (path.relative(reuse.destination, git(reuse.destination, ['rev-parse', '--show-toplevel'])) === '') targetCommit = git(reuse.destination, ['rev-parse', 'HEAD']);
  } catch { /* Target need not be a Git repository yet. */ }
  const record: ResultRecord = {
    reuseId: reuse.id, targetCommit, verification, ...delta,
    unchangedLines: count(delta.unchanged), modifiedFileLines: count(delta.modified), addedFileLines: count(delta.added),
    excludedFiles: after.exclusions, completeInventory: Object.keys(after.exclusions).length === 0,
    agentUsage: null,
  };
  store.saveResult(record);
  return record;
}
