#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import type { ResultRecord, ReusePolicy, Thresholds, Verification } from './domain.js';
import { RecallEngine } from './engine.js';
import { assertNoSymlinkComponents, git, secretDetected } from './safety.js';
import { defaultThresholds, validateThresholds } from './scoring.js';
import { RepositoryStore } from './store.js';
import { prepareReuse, provenance } from './reuse.js';
import { recordResult, verifyProject } from './verification.js';

const program = new Command().name('coderecall').description("Don't regenerate. Recall and reuse.").version('0.1.0-alpha.1')
  .option('--home <directory>', 'Local memory directory', process.env.CODERECALL_HOME ?? path.join(homedir(), '.coderecall'));
const print = (value: unknown): void => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); };
async function withEngine<T>(operation: (engine: RecallEngine) => T | Promise<T>): Promise<T> {
  const directory = path.resolve(String(program.opts().home));
  await assertNoSymlinkComponents(directory);
  const store = new RepositoryStore(directory);
  try { return await operation(new RecallEngine(store)); } finally { store.close(); }
}
interface MatchOptions { requirements?: string; thresholds?: string }
async function inputRequirements(prompt: string | undefined, options: MatchOptions): Promise<unknown> {
  if (prompt && options.requirements) throw new Error('Provide either a prompt or --requirements, not both.');
  if (options.requirements) return readFile(options.requirements, 'utf8');
  if (!prompt) throw new Error('Provide a quoted prompt or --requirements <file>.');
  return prompt;
}
async function thresholds(options: MatchOptions): Promise<Thresholds> {
  return options.thresholds ? validateThresholds(JSON.parse(await readFile(options.thresholds, 'utf8'))) : defaultThresholds;
}
function matchingOptions(command: Command): Command {
  return command.option('--requirements <file>', 'Text or structured JSON requirements').option('--thresholds <file>', 'JSON thresholds for all five decision gates');
}

program.command('init').description('Create a local SQLite memory').action(async () => print(await withEngine(engine => ({ home: engine.store.directory, schemaVersion: 1 }))));
program.command('index <repository>').description('Index one local Git root; never executes project code')
  .option('--permission <policy>', 'unknown, owned, permitted or denied')
  .option('--owner <name>', 'Owner of the reusable source')
  .option('--attestation <text>', 'Your statement that reuse rights permit this operation')
  .action(async (repository: string, options: { permission?: string; owner?: string; attestation?: string }) => {
    let policy: ReusePolicy | undefined;
    if (options.permission || options.owner || options.attestation) {
      if (!['unknown', 'owned', 'permitted', 'denied'].includes(options.permission ?? 'unknown')) throw new Error('Invalid reuse permission.');
      if (secretDetected(JSON.stringify(options))) throw new Error('Permission metadata must not contain secrets.');
      policy = { permission: (options.permission ?? 'unknown') as ReusePolicy['permission'], owner: options.owner ?? null, attestation: options.attestation ?? null, restrictions: [] };
    }
    print(await withEngine(engine => engine.index(repository, policy)));
  });
program.command('list').description('List indexed projects').action(async () => print(await withEngine(engine => engine.store.listProjects().map(project => ({ id: project.id, name: project.name, root: project.root, features: project.features.map(feature => feature.name), verification: project.verification?.status ?? 'unknown' })))));
program.command('inspect <project>').description('Inspect a fingerprint without returning source bodies').action(async (project: string) => print(await withEngine(engine => engine.store.project(project))));
matchingOptions(program.command('match [prompt]').description('Explain candidates and independent compatibility gates'))
  .action(async (prompt: string | undefined, options: MatchOptions) => {
    const input = await inputRequirements(prompt, options);
    const settings = await thresholds(options);
    print(await withEngine(engine => engine.match(input, settings)));
  });
matchingOptions(program.command('plan <project> [prompt]').description('Save an adaptation plan; this does not copy or rewrite source'))
  .action(async (project: string, prompt: string | undefined, options: MatchOptions) => {
    const input = await inputRequirements(prompt, options);
    const settings = await thresholds(options);
    print(await withEngine(engine => engine.plan(project, input, settings)));
  });
program.command('reuse <plan> <destination>').description('Preview eligible files; --apply copies into a nonexistent destination')
  .option('--apply', 'Perform the copy').option('--dry-run', 'Explicitly request a read-only preview')
  .action(async (plan: string, destination: string, options: { apply?: boolean; dryRun?: boolean }) => {
    if (options.apply && options.dryRun) throw new Error('--apply and --dry-run are mutually exclusive.');
    print(await withEngine(engine => prepareReuse(engine.store, plan, destination, !options.apply)));
  });
for (const mode of ['verify', 'record-result'] as const) {
  program.command(`${mode} <subject> [executable...]`).description(mode === 'verify' ? 'Verify an indexed source with an explicitly trusted command' : 'Verify an adapted target and record file-level changes')
    .option('--trust', 'Acknowledge that the selected command executes trusted repository code')
    .option('--timeout <milliseconds>', 'Maximum direct child process duration', '60000')
    .allowUnknownOption(false)
    .action(async (subject: string, executable: string[], options: { trust?: boolean; timeout: string }) => {
      const result = await withEngine<Verification | ResultRecord>(engine => mode === 'verify'
        ? verifyProject(engine.store, subject, executable, Boolean(options.trust), Number(options.timeout))
        : recordResult(engine.store, subject, executable, Boolean(options.trust), Number(options.timeout)));
      print(result);
      const verification = 'verification' in result ? result.verification : result;
      if (verification.status !== 'passed') process.exitCode = 1;
    });
}
program.command('provenance <target> [file]').description('Trace copied bytes, modifications and recorded results')
  .action(async (target: string, file?: string) => print(await withEngine(engine => provenance(engine.store, target, file))));
program.command('doctor').description('Check runtime and local Git availability').action(() => print({ node: process.version, git: git(process.cwd(), ['--version']), sqlite: 'built-in node:sqlite', networkRequired: false }));
program.command('mcp').description('Serve scoped MCP tools over stdio; command execution is never exposed')
  .requiredOption('--allow-root <directories...>', 'Allowed repository/target parent directories')
  .option('--enable-copy', 'Allow prepare_reuse with apply=true')
  .action(async (options: { allowRoot: string[]; enableCopy?: boolean }) => {
    const { startMcp } = await import('./mcp.js');
    await startMcp(path.resolve(String(program.opts().home)), options.allowRoot, Boolean(options.enableCopy));
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  process.stderr.write(JSON.stringify({ error: secretDetected(message) ? 'Operation rejected; potential secret in error details.' : message }) + '\n');
  process.exitCode = 1;
});
