import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint, analyzeSource } from '../src/analyzer.js';
import { parseRequirements } from '../src/requirements.js';
import { defaultThresholds, findModules, rankProjects, scoreProject } from '../src/scoring.js';
import { createPlan } from '../src/planner.js';
import { inventory, secretDetected } from '../src/safety.js';
import { createFixtures, commit, policy, prompt, repository, sandbox, write } from './fixtures.js';

test('fingerprints source structure, features, manifests and tracked ignore rules', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const fixtures = await createFixtures(env.root);
  const a = await fingerprint(fixtures.a, policy);
  assert.deepEqual(a.features.map(feature => feature.name), ['admin', 'auth', 'billing']);
  assert.equal(a.technology.frameworks.next, '^16.0.0');
  assert.equal(a.technology.platform, 'web');
  assert.equal(a.license, 'MIT');
  assert.ok(a.structure.functions.includes('isAuthenticated'));
  assert.deepEqual(a.structure.testFiles, ['tests/core.test.mjs']);
  assert.ok(!a.files.some(file => /(?:\.env|node_modules|local-only|internal-notes)/.test(file.path)));
  assert.ok(a.exclusions['default-policy']);
  assert.ok(a.exclusions['ignore-rule']);
  const again = await fingerprint(fixtures.a, policy);
  assert.equal(a.snapshot, again.snapshot);
  assert.equal(a.id, again.id);
  const b = await fingerprint(fixtures.b, policy);
  assert.ok(b.structure.routes.includes('GET /booking'));
  assert.equal((await fingerprint(fixtures.c, policy)).features.length, 0, 'README promises are not implementation evidence');
});

test('AST extracts imports, functions, classes, interfaces and routes', () => {
  const structure = analyzeSource(new Map([['src/api.ts', 'import express from "express"; export interface User {} export class Accounts {} export function session() {} const available = () => true; app.get("/users", handler);']]));
  assert.deepEqual(structure.imports, ['express']);
  assert.deepEqual(structure.classes, ['Accounts']);
  assert.deepEqual(structure.interfaces, ['User']);
  assert.deepEqual(structure.functions, ['available', 'session']);
  assert.deepEqual(structure.routes, ['GET /users']);
});

test('requirements normalize supported synonyms and preserve structured delta', () => {
  const requirements = parseRequirements(prompt);
  assert.deepEqual(requirements.features, ['admin', 'auth', 'billing', 'booking']);
  assert.equal(requirements.frameworks.next, '*');
  assert.equal(requirements.platform, 'web');
  assert.equal(parseRequirements('Next.js 15 auth on Node 22').frameworks.next, '15.x');
  assert.equal(parseRequirements('Next.js 15 auth on Node 22').runtime, 'node 22.x');
  assert.throws(() => parseRequirements('Next.js without auth'), /ambiguous/);
  assert.deepEqual(parseRequirements({ description: 'Barbers', features: ['booking'], changes: [{ feature: 'booking', instruction: 'Use barber-specific durations' }] }).changes, [{ feature: 'booking', instruction: 'Use barber-specific durations' }]);
  assert.throws(() => parseRequirements({ description: 'Contradiction', features: ['auth'], removeFeatures: ['auth'] }), /both required and removed/);
  assert.throws(() => parseRequirements({ description: 'Bad schema', features: [], arbitrary: true }));
});

test('separate scoring gates reject incompatible platforms even with identical features', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const fixtures = await createFixtures(env.root);
  const a = await fingerprint(fixtures.a, policy);
  a.verification = { status: 'passed', command: ['node', '--test'], exitCode: 0, timedOut: false, at: new Date().toISOString(), snapshot: a.snapshot, durationMs: 1, scope: 'user-selected-command' };
  const target = parseRequirements(prompt);
  const good = scoreProject(a, target);
  assert.equal(good.decision, 'project');
  assert.equal(good.scores.semanticSimilarity, 0.75);
  assert.equal(good.scores.technicalCompatibility, 1);
  assert.equal(good.signals.length > 4, true);
  const mobile = structuredClone(a);
  mobile.technology.platform = 'mobile'; mobile.technology.frameworks = { flutter: '^3.0.0' }; mobile.technology.runtime = 'dart';
  const mismatch = scoreProject(mobile, target, { ...defaultThresholds, technical: 0, confidence: 0 });
  assert.equal(mismatch.scores.semanticSimilarity, 0.75);
  assert.notEqual(mismatch.decision, 'project', 'hard incompatibilities cannot be disabled with soft thresholds');
  assert.ok(mismatch.blockers.some(reason => reason.includes('platform')));
  const b = await fingerprint(fixtures.b, policy);
  const c = await fingerprint(fixtures.c, policy);
  assert.equal(rankProjects([c, b, a], target)[0]?.projectId, a.id);
  assert.equal(scoreProject(c, target).decision, 'generate');
  const module = findModules([a, b, c], target, a).find(item => item.projectId === b.id);
  assert.equal(module?.feature, 'booking');
  assert.equal(module?.status, 'review-required');
  assert.ok(module?.reasons.some(reason => reason.includes('Framework mismatch')));
});

test('dependency ranges, unknown versions, database and missing constraints are conservative', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const fixtures = await createFixtures(env.root);
  const a = await fingerprint(fixtures.a, policy);
  const base = parseRequirements(prompt);
  for (const version of ['^15.0.0', 'workspace:*']) {
    const candidate = scoreProject(a, { ...base, frameworks: { next: version } });
    assert.ok(candidate.blockers.some(reason => reason.startsWith('next:')));
  }
  a.technology.frameworks.next = '>=15 <18';
  assert.ok(scoreProject(a, { ...base, frameworks: { next: '^16.0.0' } }).blockers.some(reason => reason.includes('partial overlap')));
  assert.ok(scoreProject(a, { ...base, database: 'postgresql' }).blockers.some(reason => reason.startsWith('database:')));
  assert.ok(scoreProject(a, parseRequirements('auth billing admin')).blockers.some(reason => reason.includes('Specify a target')));
  assert.throws(() => scoreProject(a, base, { ...defaultThresholds, health: -1 }));
});

test('unknown rights, failed, expired and wrong-snapshot verification prevent full reuse', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const fixtures = await createFixtures(env.root);
  const a = await fingerprint(fixtures.a);
  const requirements = parseRequirements(prompt);
  assert.equal(scoreProject(a, requirements).scores.reuseSafety, 0);
  a.policy = policy;
  assert.notEqual(scoreProject(a, requirements).decision, 'project', 'test presence is not test success');
  const valid = { status: 'passed' as const, command: ['node'], exitCode: 0, timedOut: false, at: new Date().toISOString(), snapshot: a.snapshot, durationMs: 1, scope: 'user-selected-command' as const };
  for (const verification of [{ ...valid, status: 'failed' as const }, { ...valid, at: '2001-01-01T00:00:00Z' }, { ...valid, snapshot: 'other' }]) {
    a.verification = verification;
    assert.notEqual(scoreProject(a, requirements).decision, 'project');
  }
  a.verification = valid; a.policy = { ...policy, restrictions: ['No commercial reuse'] };
  assert.equal(scoreProject(a, requirements).scores.reuseSafety, 0);
});

test('adaptation keeps proven features, adds booking and never invents deletions', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const fixtures = await createFixtures(env.root);
  const a = await fingerprint(fixtures.a, policy);
  const target = parseRequirements(prompt);
  const plan = createPlan(a, target);
  assert.deepEqual(plan.actions.filter(action => action.kind === 'KEEP').map(action => action.feature), ['admin', 'auth', 'billing']);
  assert.deepEqual(plan.actions.filter(action => action.kind === 'ADD').map(action => action.feature), ['booking']);
  assert.equal(plan.actions.some(action => action.kind === 'REMOVE'), false);
  assert.equal(plan.id, createPlan(a, target).id);
  const delta = createPlan(a, { ...target, features: ['admin'], removeFeatures: ['billing'], changes: [{ feature: 'admin', instruction: 'Add barber management' }] });
  assert.equal(delta.actions.find(action => action.feature === 'billing')?.kind, 'REMOVE');
  assert.equal(delta.actions.find(action => action.feature === 'admin')?.kind, 'MODIFY');
  assert.equal(delta.actions.find(action => action.feature === 'auth')?.kind, 'KEEP');
});

test('nested ignores, negations, untracked files, binaries, secrets and links are excluded', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const root = await repository(path.join(env.root, 'safe-source'), {
    'package.json': '{"name":"safe-source"}',
    '.gitignore': '*.tmp\n!keep.tmp\n*.skip\n',
    'keep.tmp': 'retained', 'omit.tmp': 'omitted',
    'src/.gitignore': 'private.ts\n!local.skip\n', 'src/private.ts': 'export const hidden = 1;',
    'src/local.skip': 'Nested negation overrides parent pattern.',
    'src/public.ts': 'export function visible() {}',
    'token-bearing.ts': 'const key = "' + 'ghp_' + 'a'.repeat(36) + '";',
    'binary.bin': '\0binary', '.env.example': 'Exclude environment examples too',
  });
  await write(root, 'untracked.ts', 'do not index me');
  const result = await inventory(root);
  assert.ok(result.content.has('keep.tmp'));
  assert.ok(result.content.has('src/local.skip'));
  for (const excluded of ['omit.tmp', 'src/private.ts', 'token-bearing.ts', 'binary.bin', '.env.example', 'untracked.ts']) assert.equal(result.content.has(excluded), false, excluded);
  assert.equal(JSON.stringify(result).includes('a'.repeat(36)), false);
  assert.equal(result.exclusions['secret-scan'], 1);
  await link(path.join(root, 'src/public.ts'), path.join(root, 'hardlink.ts'));
  commit(root);
  const linked = await inventory(root);
  assert.equal(linked.content.has('hardlink.ts'), false);
  assert.equal(linked.content.has('src/public.ts'), false);
  try {
    await symlink(env.root, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.ok((await inventory(root)).exclusions.symlink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.diagnostic('File-system policy does not permit symlinks; hardlink protection was exercised.');
  }
});

test('secret scanner covers key formats and does not reject ordinary placeholders', () => {
  assert.equal(secretDetected('-----BEGIN PRIVATE KEY-----'), true);
  assert.equal(secretDetected('AKIA' + 'A'.repeat(16)), true);
  assert.equal(secretDetected('password="' + 'a'.repeat(20) + '"'), true);
  assert.equal(secretDetected('const key = process.env.API_KEY;'), false);
});

test('tracked modifications invalidate clean state and snapshot', async t => {
  const env = await sandbox(); t.after(env.cleanup);
  const root = await repository(path.join(env.root, 'changing'), { 'src/index.ts': 'export function value() { return 1; }' });
  const before = await fingerprint(root);
  await writeFile(path.join(root, 'src/index.ts'), (await readFile(path.join(root, 'src/index.ts'), 'utf8')).replace('1', '2'));
  const after = await fingerprint(root);
  assert.equal(after.clean, false);
  assert.notEqual(before.snapshot, after.snapshot);
});
