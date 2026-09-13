import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RecallEngine } from '../src/engine.js';
import { RepositoryStore } from '../src/store.js';
import { prepareReuse } from '../src/reuse.js';
import { recordResult, verifyProject } from '../src/verification.js';
import { createFixtures, policy, prompt, write } from '../tests/fixtures.js';

await mkdir('.work', { recursive: true });
const root = await mkdtemp(path.resolve('.work/demo-'));
const fixtures = await createFixtures(root);
const store = new RepositoryStore(path.join(root, 'memory'));
try {
  const engine = new RecallEngine(store);
  const projects = [];
  for (const repository of Object.values(fixtures)) projects.push(await engine.index(repository, policy));
  const source = projects[0]!;
  await verifyProject(store, source.id, [process.execPath, '--test', 'tests/core.test.mjs'], true);
  const match = engine.match(prompt);
  if (match.recommendedProject !== source.id) throw new Error('Expected Next.js SaaS as the verified base.');
  const plan = engine.plan(source.id, prompt);
  const target = path.join(root, 'booking-saas');
  const preview = await prepareReuse(store, plan.id, target);
  const reuse = await prepareReuse(store, plan.id, target, false);
  // A fixed synthetic patch stands in for the coding agent, making the boundary measurable.
  await write(target, 'src/booking/appointments.mjs', 'export function book(start, duration) { if (duration <= 0) throw new Error("Invalid duration"); return { start, end: start + duration }; }\n');
  await write(target, 'src/app/page.tsx', 'export default function Page() { return <main>Booking workspace</main>; }\n');
  await write(target, 'tests/booking.test.mjs', 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { book } from "../src/booking/appointments.mjs";\ntest("booking", () => { assert.deepEqual(book(10,30), {start:10,end:40}); assert.throws(() => book(10,0)); });\n');
  const result = await recordResult(store, target, [process.execPath, '--test', 'tests/core.test.mjs', 'tests/booking.test.mjs'], true);
  if (result.verification.status !== 'passed') throw new Error('Adapted fixture verification failed.');
  const report = {
    fixtureOnly: true, prompt, workspace: root, home: store.directory, target,
    candidates: match.candidates.map(candidate => ({ name: candidate.name, scores: candidate.scores, decision: candidate.decision, blockers: candidate.blockers })),
    moduleCandidates: match.moduleCandidates, planId: plan.id, preview, reuse, result,
    benchmark: 'Not an AI savings benchmark. This proves deterministic copying and separates fixture adaptation from engine work.',
  };
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { store.close(); }
