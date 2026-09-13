import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { readdirSync } from 'node:fs';

const tests = readdirSync('tests').filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
for (const [label, args] of [
  ['Type checking', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['Lint', ['node_modules/eslint/bin/eslint.js', 'src', 'tests', 'scripts']],
  ['Tests', ['node_modules/tsx/dist/cli.mjs', '--test', ...tests]],
  ['Build', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']],
]) {
  process.stdout.write(`\n${label}\n`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
