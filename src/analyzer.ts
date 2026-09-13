import path from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import type { ProjectFingerprint, ReusePolicy, SourceStructure, TechnologyFingerprint } from './domain.js';
import { detectFeatures } from './requirements.js';
import { git, hash, inventory, repositoryRoot } from './safety.js';

const manifestSchema = z.object({
  name: z.string().optional(), license: z.string().optional(),
  packageManager: z.string().optional(), engines: z.object({ node: z.string().optional() }).optional(),
  dependencies: z.record(z.string()).optional(), devDependencies: z.record(z.string()).optional(),
});

const sourceExtension = /\.[cm]?[jt]sx?$/;
const unique = (values: string[]) => [...new Set(values)].sort();

export function analyzeSource(files: Map<string, string>): SourceStructure {
  const result: SourceStructure = { imports: [], exports: [], functions: [], classes: [], interfaces: [], routes: [], testFiles: [], moduleRoots: [] };
  for (const [file, text] of files) {
    if (!sourceExtension.test(file)) continue;
    if (/(?:^|\/)(?:tests?|__tests__)\/|[.](?:test|spec)[.]/.test(file)) result.testFiles.push(file);
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) result.imports.push(node.moduleSpecifier.text);
      if (ts.isFunctionDeclaration(node) && node.name) result.functions.push(node.name.text);
      if (ts.isClassDeclaration(node) && node.name) result.classes.push(node.name.text);
      if (ts.isInterfaceDeclaration(node)) result.interfaces.push(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) result.functions.push(node.name.text);
      if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) result.exports.push((node.name as ts.Identifier).text);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && /^(?:get|post|put|patch|delete)$/.test(node.expression.name.text)
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.routes.push(`${node.expression.name.text.toUpperCase()} ${node.arguments[0].text}`);
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (/(?:^|\/)app\/(?:.*\/)?(?:route|page)\.[jt]sx?$/.test(file)) result.routes.push(file);
    result.moduleRoots.push(path.posix.dirname(file));
  }
  for (const key of Object.keys(result) as (keyof SourceStructure)[]) result[key] = unique(result[key]);
  return result;
}

export const unknownPolicy: ReusePolicy = { permission: 'unknown', owner: null, attestation: null, restrictions: [] };

export async function fingerprint(input: string, policy: ReusePolicy = unknownPolicy): Promise<ProjectFingerprint> {
  const root = await repositoryRoot(input);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']);
  const collected = await inventory(root);
  const rawManifest = collected.content.get('package.json');
  const manifest = rawManifest ? manifestSchema.parse(JSON.parse(rawManifest)) : {};
  const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
  const frameworks = Object.fromEntries(['next', 'express', 'react', 'vue', 'nuxt', 'fastify', '@nestjs/core'].filter(name => dependencies[name]).map(name => [name, dependencies[name]!])) as Record<string, string>;
  const languages = unique(collected.files.flatMap(file => /\.[cm]?tsx?$/.test(file.path) ? ['TypeScript'] : /\.[cm]?jsx?$/.test(file.path) ? ['JavaScript'] : /\.dart$/.test(file.path) ? ['Dart'] : /\.py$/.test(file.path) ? ['Python'] : []));
  const prisma = [...collected.content].find(([file]) => file.endsWith('.prisma'))?.[1] ?? '';
  const provider = /provider\s*=\s*"(postgresql|mysql|sqlite|mongodb)"/.exec(prisma)?.[1];
  const technology: TechnologyFingerprint = {
    languages, frameworks, dependencies,
    runtime: rawManifest ? `node${manifest.engines?.node ? ` ${manifest.engines.node}` : ''}` : null,
    platform: frameworks.next || frameworks.nuxt || frameworks.react || frameworks.vue ? 'web' : frameworks.express || frameworks.fastify || frameworks['@nestjs/core'] ? 'server' : languages.includes('Dart') ? 'mobile' : rawManifest ? 'library' : 'unknown',
    database: provider ?? (dependencies.pg ? 'postgresql' : dependencies['better-sqlite3'] ? 'sqlite' : dependencies.mongoose ? 'mongodb' : null),
    orm: dependencies['@prisma/client'] || dependencies.prisma ? 'prisma' : dependencies['drizzle-orm'] ? 'drizzle' : null,
    packageManager: manifest.packageManager?.split('@')[0] ?? (collected.content.has('pnpm-lock.yaml') ? 'pnpm' : collected.content.has('yarn.lock') ? 'yarn' : collected.content.has('package-lock.json') ? 'npm' : null),
  };
  const structure = analyzeSource(collected.content);
  const evidence = new Map<string, string[]>();
  for (const [file, text] of collected.content) {
    if (!sourceExtension.test(file) || structure.testFiles.includes(file)) continue;
    const perFile = analyzeSource(new Map([[file, text]]));
    // Evidence comes from source paths and syntax, not README promises or comments.
    for (const name of detectFeatures([file, ...perFile.imports, ...perFile.functions, ...perFile.classes, ...perFile.interfaces].join(' '))) {
      evidence.set(name, [...(evidence.get(name) ?? []), file]);
    }
  }
  if (sourceCommit !== git(root, ['rev-parse', 'HEAD'])) throw new Error('HEAD changed during indexing; retry.');
  const clean = git(root, ['diff', '--name-only', 'HEAD', '--']).length === 0;
  return {
    schemaVersion: 1, analyzerVersion: 'ts-static/1', id: hash(root).slice(0, 16), name: manifest.name ?? path.basename(root),
    root, sourceCommit, snapshot: collected.snapshot, clean, indexedAt: new Date().toISOString(),
    technology, features: [...evidence].sort(([a], [b]) => a.localeCompare(b)).map(([name, paths]) => ({ name, paths: unique(paths), confidence: 0.75, basis: 'static-heuristic' })),
    structure, files: collected.files, exclusions: collected.exclusions, license: manifest.license ?? (collected.content.has('LICENSE') ? 'see LICENSE' : null),
    policy, verification: null,
    warnings: [
      'Feature detection is static heuristic evidence, not proof of complete behavior.',
      ...(!clean ? ['Tracked changes are present; commit and reindex before reuse.'] : []),
      ...(Object.keys(collected.exclusions).length ? ['Excluded files are absent from the reusable snapshot; review the copy preview.'] : []),
      ...(languages.some(language => !['TypeScript', 'JavaScript'].includes(language)) ? ['Static structure analysis supports JavaScript and TypeScript only.'] : []),
    ],
  };
}
