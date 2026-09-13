import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RecallEngine } from './engine.js';
import { createPlan } from './planner.js';
import { parseRequirements, requirementsSchema } from './requirements.js';
import { findModules, rankProjects } from './scoring.js';
import { prepareReuse, provenance } from './reuse.js';
import { assertNoSymlinkComponents, inside, secretDetected } from './safety.js';
import { RepositoryStore } from './store.js';

export async function createMcpServer(store: RepositoryStore, allowedRoots: string[], enableCopy = false): Promise<McpServer> {
  if (!allowedRoots.length) throw new Error('MCP requires at least one allowed root.');
  const roots = await Promise.all(allowedRoots.map(async root => { await assertNoSymlinkComponents(root); return realpath(root); }));
  const inScope = (target: string) => roots.some(root => inside(root, path.resolve(target)));
  const checkScope = async (target: string) => {
    if (!inScope(target)) throw new Error('Path is outside MCP allowed roots.');
    await assertNoSymlinkComponents(target);
  };
  const projects = () => store.listProjects().filter(project => inScope(project.root));
  const project = (id: string) => {
    const result = store.project(id);
    if (!inScope(result.root)) throw new Error('Project is outside MCP allowed roots.');
    return result;
  };
  const engine = new RecallEngine(store);
  const server = new McpServer({ name: 'coderecall', version: '0.1.0-alpha.1' });
  const result = async (operation: () => unknown | Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation()) }] }; }
    catch (error) {
      const message = error instanceof Error ? error.message : 'Operation failed';
      return { isError: true, content: [{ type: 'text' as const, text: secretDetected(message) ? 'Potential secret detected; operation rejected.' : message }] };
    }
  };
  const requirements = z.union([z.string().min(1).max(16_000), requirementsSchema]);
  const localRead = { readOnlyHint: true, openWorldHint: false };
  server.registerTool('index_repository', {
    description: 'Index committed local source metadata without running code or returning source bodies. Reuse rights must have been explicitly granted by the user.',
    inputSchema: { path: z.string(), policy: z.object({ permission: z.enum(['unknown', 'owned', 'permitted', 'denied']), owner: z.string().nullable(), attestation: z.string().nullable(), restrictions: z.array(z.string()) }).strict().optional() },
    annotations: { destructiveHint: false, openWorldHint: false },
  }, args => result(async () => {
    await checkScope(args.path);
    if (secretDetected(JSON.stringify(args.policy))) throw new Error('Permission metadata contains a potential secret.');
    const indexed = await engine.index(args.path, args.policy);
    return { id: indexed.id, name: indexed.name, features: indexed.features, warnings: indexed.warnings };
  }));
  server.registerTool('inspect_project', { description: 'Read a project fingerprint, never source bodies.', inputSchema: { project: z.string() }, annotations: localRead }, args => result(() => project(args.project)));
  server.registerTool('match_projects', { description: 'Rank projects with separate scores and blockers; discover module paths needing review.', inputSchema: { requirements }, annotations: localRead }, args => result(() => {
    const target = parseRequirements(args.requirements);
    const candidates = rankProjects(projects(), target);
    const recommended = candidates.find(candidate => candidate.decision === 'project');
    return { candidates, recommendedProject: recommended?.projectId ?? null, moduleCandidates: findModules(projects(), target, recommended ? project(recommended.projectId) : undefined) };
  }));
  server.registerTool('plan_reuse', { description: 'Save KEEP/MODIFY/REMOVE/ADD/VERIFY instructions; does not rewrite source.', inputSchema: { project: z.string(), requirements }, annotations: { destructiveHint: false, openWorldHint: false } }, args => result(() => {
    const plan = createPlan(project(args.project), parseRequirements(args.requirements), projects());
    store.savePlan(plan);
    return plan;
  }));
  server.registerTool('prepare_reuse', { description: 'Preview by default. With apply=true and server copy capability, copy validated bytes into a new directory.', inputSchema: { plan: z.string(), destination: z.string(), apply: z.boolean().default(false) }, annotations: { destructiveHint: false, openWorldHint: false } }, args => result(async () => {
    if (args.apply && !enableCopy) throw new Error('Copy capability is disabled; start the server with --enable-copy.');
    project(store.plan(args.plan).sourceProject);
    await checkScope(args.destination);
    return prepareReuse(store, args.plan, args.destination, !args.apply);
  }));
  server.registerTool('get_provenance', { description: 'Trace a target file to its source commit and detect changes.', inputSchema: { target: z.string(), file: z.string().optional() }, annotations: localRead }, args => result(async () => {
    await checkScope(args.target);
    const report = await provenance(store, args.target, args.file);
    if ('sourceRoot' in report && typeof report.sourceRoot === 'string' && !inScope(report.sourceRoot)) throw new Error('Source provenance is outside MCP allowed roots.');
    if ('sourceRepository' in report && typeof report.sourceRepository === 'string' && !inScope(report.sourceRepository)) throw new Error('Source provenance is outside MCP allowed roots.');
    return report;
  }));
  return server;
}

export async function startMcp(directory: string, roots: string[], enableCopy: boolean): Promise<void> {
  await assertNoSymlinkComponents(directory);
  const store = new RepositoryStore(directory);
  try {
    const server = await createMcpServer(store, roots, enableCopy);
    server.server.onclose = () => store.close();
    await server.connect(new StdioServerTransport());
  } catch (error) { store.close(); throw error; }
}
