import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from '../src/mcp.js';
import { RepositoryStore } from '../src/store.js';
import { RecallEngine } from '../src/engine.js';
import { createFixtures, policy, prompt, sandbox } from './fixtures.js';

const exec = promisify(execFile);
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(cwd, 'src/cli.ts');
const tsx = path.join(cwd, 'node_modules/tsx/dist/cli.mjs');

test('CLI demonstrates index, verification, ranking, plan, dry-run, copy and provenance', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const fixtures = await createFixtures(env.root);
  async function command(args: string[]) {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const output = await exec(process.execPath, [tsx, cli, '--home', path.join(env.root, 'memory'), ...args], { cwd, windowsHide: true, timeout: 30_000, env: environment });
    return JSON.parse(output.stdout) as Record<string, unknown>;
  }
  for (const source of Object.values(fixtures)) await command(['index', source, '--permission', 'owned', '--owner', 'Fixture author', '--attestation', 'I authored these fixtures and permit reuse']);
  const verification = await command(['verify', 'next-saas', '--trust', '--', process.execPath, '--test', 'tests/core.test.mjs']);
  assert.equal(verification.status, 'passed');
  const match = await command(['match', prompt]); assert.ok(match.recommendedProject);
  const plan = await command(['plan', 'next-saas', prompt]);
  const target = path.join(env.root, 'target');
  assert.equal((await command(['reuse', String(plan.id), target, '--dry-run'])).dryRun, true);
  assert.ok((await command(['reuse', String(plan.id), target, '--apply'])).reuseId);
  assert.equal((await command(['provenance', target, 'src/auth/session.mjs'])).reuseType, 'copied-verbatim');
  assert.equal((await command(['record-result', target, '--trust', '--', process.execPath, '--test', 'tests/core.test.mjs'])).targetCommit, null);
  await assert.rejects(command(['reuse', String(plan.id), target, '--apply']));
});

test('MCP exposes six useful tools, respects scope and never exposes shell execution', async t => {
  const env = await sandbox();
  const fixtures = await createFixtures(env.root);
  const store = new RepositoryStore(path.join(env.root, 'memory'));
  const engine = new RecallEngine(store);
  const outside = await engine.index(fixtures.b, policy);
  const server = await createMcpServer(store, [fixtures.a]);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); store.close(); await env.cleanup(); });
  const list = await client.listTools();
  assert.equal(list.tools.length, 6);
  assert.ok(!list.tools.some(tool => /exec|shell|verify/.test(tool.name)));
  // Windows runners may expose TEMP via an 8.3 alias such as RUNNER~1.
  const inputRoot = process.platform === 'win32' ? path.join(tmpdir(), path.basename(env.root)) : env.root;
  const indexed = await client.callTool({ name: 'index_repository', arguments: { path: path.join(inputRoot, 'next-saas'), policy } });
  assert.notEqual(indexed.isError, true);
  assert.equal((await client.callTool({ name: 'index_repository', arguments: { path: fixtures.b } })).isError, true);
  assert.equal((await client.callTool({ name: 'inspect_project', arguments: { project: outside.id } })).isError, true);
  assert.equal((await client.callTool({ name: 'prepare_reuse', arguments: { plan: 'anything', destination: path.join(fixtures.a, 'target'), apply: true } })).isError, true);
  const matched = await client.callTool({ name: 'match_projects', arguments: { requirements: prompt } });
  assert.equal(JSON.stringify(matched).includes('express-booking'), false);
});

test('MCP stdio completes initialization and tool call without stdout contamination', async t => {
  const env = await sandbox();
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, cli, '--home', path.join(env.root, 'memory'), 'mcp', '--allow-root', env.root], cwd, stderr: 'pipe' });
  await client.connect(transport);
  t.after(async () => { await client.close(); await env.cleanup(); });
  assert.equal((await client.listTools()).tools.length, 6);
  const result = await client.callTool({ name: 'match_projects', arguments: { requirements: prompt } });
  assert.notEqual(result.isError, true);
});
