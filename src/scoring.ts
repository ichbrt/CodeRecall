import semver from 'semver';
import { z } from 'zod';
import type { ProjectFingerprint, ProjectCandidate, Requirements, Signal, Thresholds, ModuleCandidate } from './domain.js';

export const defaultThresholds: Thresholds = { semantic: 0.7, technical: 0.85, structural: 0.65, health: 0.6, confidence: 0.7 };
const thresholdSchema = z.object({ semantic: z.number().min(0).max(1), technical: z.number().min(0).max(1), structural: z.number().min(0).max(1), health: z.number().min(0).max(1), confidence: z.number().min(0).max(1) }).strict();
export const validateThresholds = (input: unknown): Thresholds => thresholdSchema.parse(input);
const round = (value: number) => Math.round(value * 1000) / 1000;

function versionScore(source: string | undefined, target: string): { score: number; reason: string; blocking: boolean } {
  if (!source) return { score: 0, reason: 'required dependency is absent', blocking: true };
  if (target === '*') return { score: 1, reason: 'present; target does not constrain version', blocking: false };
  const sourceRange = semver.validRange(source);
  const targetRange = semver.validRange(target);
  if (!sourceRange || !targetRange) return { score: 0.35, reason: 'unresolved version specifier requires review', blocking: true };
  if (!semver.intersects(sourceRange, targetRange)) return { score: 0, reason: 'version ranges do not intersect', blocking: true };
  if (!semver.subset(sourceRange, targetRange)) return { score: 0.6, reason: 'partial overlap is not a compatibility guarantee', blocking: true };
  return { score: 1, reason: 'declared source range satisfies target range (not a lockfile audit)', blocking: false };
}

export function scoreProject(project: ProjectFingerprint, target: Requirements, input: Thresholds = defaultThresholds, now = Date.now()): ProjectCandidate {
  const thresholds = validateThresholds(input);
  const signals: Signal[] = [];
  const blockers: string[] = [];
  const signal = (dimension: Signal['dimension'], label: string, score: number, weight: number, explanation: string) => signals.push({ dimension, label, score, weight, explanation });
  const has = new Set(project.features.map(feature => feature.name));
  const matchedFeatures = target.features.filter(feature => has.has(feature));
  const missingFeatures = target.features.filter(feature => !has.has(feature));
  signal('semantic', 'feature coverage', target.features.length ? matchedFeatures.length / target.features.length : 0, 1,
    `${matchedFeatures.length}/${target.features.length} required features have source-path or AST evidence; no embeddings or semantic certainty implied.`);
  const exact = (label: string, required: string | null, actual: string | null, weight: number, dimension: 'technical' | 'structural' = 'technical') => {
    if (!required) return;
    const compatible = required === actual;
    signal(dimension, label, compatible ? 1 : actual ? 0 : 0.25, weight, `Required ${required}; observed ${actual ?? 'unknown'}.`);
    if (!compatible) blockers.push(`${label}: required ${required}, observed ${actual ?? 'unknown'}.`);
  };
  exact('platform', target.platform, project.technology.platform, 3);
  exact('runtime', target.runtime?.split(' ')[0] ?? null, project.technology.runtime?.split(' ')[0] ?? null, 2);
  if (target.runtime?.includes(' ')) {
    const check = versionScore(project.technology.runtime?.split(' ').slice(1).join(' '), target.runtime.split(' ').slice(1).join(' '));
    signal('technical', 'runtime version', check.score, 2, check.reason);
    if (check.blocking) blockers.push(`runtime: ${check.reason}.`);
  }
  if (target.language) exact('language', target.language, project.technology.languages.includes(target.language) ? target.language : project.technology.languages[0] ?? null, 2);
  for (const [name, required] of Object.entries(target.frameworks)) {
    const check = versionScore(project.technology.frameworks[name], required);
    signal('technical', `framework ${name}`, check.score, 4, check.reason);
    if (check.blocking) blockers.push(`${name}: ${check.reason}.`);
  }
  for (const [name, required] of Object.entries(target.dependencies)) {
    const check = versionScore(project.technology.dependencies[name], required);
    signal('technical', `dependency ${name}`, check.score, 1, check.reason);
    if (check.blocking) blockers.push(`${name}: ${check.reason}.`);
  }
  exact('database', target.database, project.technology.database, 3);
  exact('ORM', target.orm, project.technology.orm, 2);
  if (!signals.some(item => item.dimension === 'technical')) {
    signal('technical', 'unspecified stack', 0.4, 1, 'No target stack constraints; compatibility cannot be established.');
    blockers.push('Specify a target platform, runtime, framework, language, database or dependency before full-project reuse.');
  }
  signal('structural', 'analyzable source', project.structure.functions.length + project.structure.exports.length > 0 ? 1 : 0.25, 1, 'Named functions or exports establish a minimal analyzable implementation.');
  if (target.frameworks.next) signal('structural', 'Next.js routing convention', project.files.some(file => /^(?:src\/)?(?:app|pages)\//.test(file.path)) ? 1 : 0, 2, 'Target Next.js requires an app/ or pages/ source tree.');
  const currentVerification = project.verification?.snapshot === project.snapshot && now - Date.parse(project.verification.at) <= 7 * 86400_000 && now >= Date.parse(project.verification.at) ? project.verification : null;
  const health = currentVerification?.status === 'passed' ? 1 : currentVerification?.status === 'failed' ? 0 : project.structure.testFiles.length ? 0.45 : 0.15;
  signal('health', 'verification', health, 1, currentVerification ? `${currentVerification.status}: a user-selected command on this snapshot; not a security audit.` : 'No successful command verified on this snapshot in the last seven days.');
  if (currentVerification?.status === 'failed') blockers.push('Latest verification failed.');
  const permission = ['owned', 'permitted'].includes(project.policy.permission) && Boolean(project.policy.owner?.trim()) && Boolean(project.policy.attestation?.trim()) && project.policy.restrictions.length === 0;
  signal('safety', 'reuse permission', permission ? 1 : 0, 2, permission ? 'User attested reuse rights; license retained for review.' : 'Explicit owner and reuse-rights attestation without unresolved restrictions required.');
  signal('safety', 'committed source', project.clean ? 1 : 0, 1, project.clean ? 'No tracked changes at indexing.' : 'Tracked changes are present.');
  if (!permission) blockers.push('Reuse permission is absent, denied or restricted.');
  if (!project.clean) blockers.push('Source has uncommitted tracked changes.');
  if (project.files.length === 0) blockers.push('No eligible source files.');
  const score = (dimension: Signal['dimension']) => {
    const items = signals.filter(item => item.dimension === dimension);
    return round(items.reduce((sum, item) => sum + item.score * item.weight, 0) / items.reduce((sum, item) => sum + item.weight, 0));
  };
  const semanticSimilarity = score('semantic');
  const technicalCompatibility = score('technical');
  const structuralCompatibility = score('structural');
  const projectHealth = score('health');
  const reuseSafety = permission && project.clean ? 1 : 0;
  // Confidence is a heuristic decision score, not a calibrated probability.
  const reuseConfidence = round(Math.pow(semanticSimilarity, 0.35) * Math.pow(technicalCompatibility, 0.3) * Math.pow(structuralCompatibility, 0.15) * Math.pow(projectHealth, 0.2) * reuseSafety);
  for (const [label, actual, minimum] of [
    ['semantic coverage', semanticSimilarity, thresholds.semantic], ['technical compatibility', technicalCompatibility, thresholds.technical],
    ['structural compatibility', structuralCompatibility, thresholds.structural], ['project health', projectHealth, thresholds.health], ['reuse confidence', reuseConfidence, thresholds.confidence],
  ] as const) if (actual < minimum) blockers.push(`${label} ${actual} is below threshold ${minimum}.`);
  return {
    projectId: project.id, name: project.name,
    scores: { semanticSimilarity, technicalCompatibility, structuralCompatibility, projectHealth, reuseSafety, reuseConfidence },
    signals, blockers, decision: blockers.length === 0 ? 'project' : matchedFeatures.length && permission ? 'modules' : 'generate', matchedFeatures, missingFeatures,
  };
}

export function rankProjects(projects: ProjectFingerprint[], target: Requirements, thresholds = defaultThresholds): ProjectCandidate[] {
  return projects.map(project => scoreProject(project, target, thresholds)).sort((a, b) =>
    Number(b.decision === 'project') - Number(a.decision === 'project') || b.scores.reuseConfidence - a.scores.reuseConfidence || b.scores.semanticSimilarity - a.scores.semanticSimilarity || a.projectId.localeCompare(b.projectId));
}

export function findModules(projects: ProjectFingerprint[], target: Requirements, base?: ProjectFingerprint): ModuleCandidate[] {
  const missing = target.features.filter(feature => !base?.features.some(item => item.name === feature));
  return projects.filter(project => project.id !== base?.id).flatMap(project => {
    if (!['owned', 'permitted'].includes(project.policy.permission) || !project.policy.owner || !project.policy.attestation || project.policy.restrictions.length || !project.clean) return [];
    return project.features.filter(feature => missing.includes(feature.name)).map(feature => {
      const sourceFiles = feature.paths.map(file => project.files.find(item => item.path === file));
      const languageMatch = !target.language || project.technology.languages.includes(target.language);
      const frameworkMatch = Object.keys(target.frameworks).every(name => name in project.technology.frameworks);
      return {
        projectId: project.id, feature: feature.name, paths: feature.paths, status: 'review-required' as const,
        technicalCompatibility: languageMatch ? frameworkMatch ? 0.6 : 0.3 : 0,
        reasons: [
          'Feature-local paths identified; transitive import closure and behavior are not verified.',
          frameworkMatch ? 'Framework names align; module APIs and versions still require review.' : 'Framework mismatch: extract and adapt domain logic; do not copy framework routes blindly.',
          `${sourceFiles.filter(Boolean).length} candidate files; this is discovery, not permission to apply a module.`,
        ],
      };
    });
  });
}
