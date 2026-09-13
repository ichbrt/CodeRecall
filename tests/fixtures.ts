import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { git, inside } from '../src/safety.js';
import type { ReusePolicy } from '../src/domain.js';

export const policy: ReusePolicy = { permission: 'owned', owner: 'Fixture author', attestation: 'Synthetic test sources authored for this test; reuse permitted.', restrictions: [] };
export const prompt = 'Build a Next.js SaaS booking product with auth, subscriptions and admin.';

export async function write(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf8');
}
export function commit(root: string): void {
  git(root, ['-c', 'core.autocrlf=false', 'add', '--all', '--force']);
  git(root, ['-c', 'core.hooksPath=.disabled-hooks', '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Add synthetic fixture']);
}
export async function repository(root: string, files: Record<string, string>): Promise<string> {
  await mkdir(root, { recursive: true });
  git(root, ['-c', 'init.templateDir=', 'init', '--initial-branch=main']);
  for (const [file, text] of Object.entries(files)) await write(root, file, text);
  commit(root);
  return root;
}

export async function createFixtures(parent: string) {
  const a = await repository(path.join(parent, 'next-saas'), {
    'package.json': JSON.stringify({ name: 'next-saas', private: true, license: 'MIT', scripts: { test: 'node --test tests/core.test.mjs' }, engines: { node: '>=24' }, dependencies: { next: '^16.0.0', react: '^19.0.0' } }, null, 2),
    'LICENSE': 'Synthetic fixture code: permission is hereby granted to use, copy and modify this fixture.\n',
    'src/app/page.tsx': 'export default function Page() { return <main>SaaS workspace</main>; }\n',
    'src/auth/session.mjs': 'export function isAuthenticated(session) { return Boolean(session?.userId); }\n',
    'src/billing/subscriptions.mjs': 'export function hasSubscription(subscription) { return subscription?.status === "active"; }\n',
    'src/admin/dashboard.mjs': 'export function adminSections() { return ["users", "billing"]; }\n',
    'tests/core.test.mjs': 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { isAuthenticated } from "../src/auth/session.mjs";\nimport { hasSubscription } from "../src/billing/subscriptions.mjs";\nimport { adminSections } from "../src/admin/dashboard.mjs";\ntest("auth rejects missing user", () => { assert.equal(isAuthenticated(null), false); assert.equal(isAuthenticated({userId: "u1"}), true); });\ntest("billing requires active subscription", () => { assert.equal(hasSubscription({status: "active"}), true); assert.equal(hasSubscription({status: "cancelled"}), false); });\ntest("admin exposes existing sections", () => assert.deepEqual(adminSections(), ["users", "billing"]));\n',
    '.gitignore': 'node_modules/\ndist/\nlocal-only.txt\n',
    '.coderecallignore': 'internal-notes.md\n',
    '.env': 'DATABASE_PASSWORD=synthetic-private-value\n',
    'local-only.txt': 'Ignored even when tracked.\n',
    'internal-notes.md': 'Not part of reusable code.\n',
    'node_modules/ignored/index.js': 'Not indexed.\n',
  });
  const b = await repository(path.join(parent, 'express-booking'), {
    'package.json': JSON.stringify({ name: 'express-booking', private: true, license: 'MIT', dependencies: { express: '^5.0.0' }, scripts: { test: 'node --test tests/booking.test.mjs' } }),
    'src/booking/appointments.mjs': 'export function createAppointment(start, duration) { if (duration <= 0) throw new Error("Duration must be positive"); return { start, end: start + duration }; }\n',
    'src/booking/availability.mjs': 'export function isAvailable(slots, start) { return slots.includes(start); }\n',
    'src/routes/booking.mjs': 'import express from "express";\nexport const router = express.Router();\nrouter.get("/booking", (_request, response) => response.json([]));\n',
    'tests/booking.test.mjs': 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { createAppointment } from "../src/booking/appointments.mjs";\ntest("booking duration", () => { assert.deepEqual(createAppointment(10, 30), {start:10, end:40}); assert.throws(() => createAppointment(10, 0)); });\n',
  });
  const c = await repository(path.join(parent, 'text-utils'), {
    'package.json': JSON.stringify({ name: 'text-utils', private: true, license: 'MIT' }),
    'src/slug.mjs': 'export function slug(text) { return text.trim().toLowerCase().replaceAll(" ", "-"); }\n',
    'README.md': 'This utility is unrelated. Roadmap buzzwords: auth billing admin booking.\n',
  });
  return { a, b, c };
}

export async function sandbox() {
  // macOS exposes its temporary directory through the /var symlink.
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(parent, 'coderecall-test-'));
  return {
    root,
    async cleanup() {
      const resolved = path.resolve(root);
      if (!inside(parent, resolved) || !path.basename(resolved).startsWith('coderecall-test-') || resolved === parent) throw new Error('Unsafe test cleanup path.');
      await rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    },
  };
}
