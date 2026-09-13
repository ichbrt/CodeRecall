import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateDestination } from '../src/reuse.js';
import { sandbox } from './fixtures.js';

test('destination boundaries and provenance paths resolve Windows short-name aliases', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const source = path.join(env.root, 'source');
  const memory = path.join(env.root, 'memory');
  await mkdir(source); await mkdir(memory);
  // Keep the OS-provided spelling to exercise 8.3 aliases on Windows runners.
  const inputRoot = process.platform === 'win32' ? path.join(tmpdir(), path.basename(env.root)) : env.root;
  const target = await validateDestination(source, path.join(inputRoot, 'target'), memory);
  assert.equal(target, path.join(await realpath(env.root), 'target'));
  await assert.rejects(validateDestination(source, path.join(inputRoot, 'source', 'nested'), memory), /overlap/);
  await assert.rejects(validateDestination(source, path.join(inputRoot, 'memory', 'nested'), memory), /memory/);
  await assert.rejects(validateDestination(source, path.join(env.root, 'memory', 'nested'), path.join(inputRoot, 'memory')), /memory/);
});

test('canonicalizing destination paths must still reject symbolic links and junctions', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const source = path.join(env.root, 'source');
  const memory = path.join(env.root, 'memory');
  const alias = path.join(env.root, 'alias');
  await mkdir(source); await mkdir(memory);
  try { await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('This filesystem does not permit creating a test symlink.'); return;
  }
  await assert.rejects(validateDestination(source, path.join(alias, 'target'), memory), /Symbolic links/);
});
