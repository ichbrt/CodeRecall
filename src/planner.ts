import type { AdaptationAction, AdaptationPlan, ProjectFingerprint, Requirements, Thresholds } from './domain.js';
import { defaultThresholds, findModules, scoreProject } from './scoring.js';
import { hash } from './safety.js';

export function createPlan(source: ProjectFingerprint, target: Requirements, projects: ProjectFingerprint[] = [], thresholds: Thresholds = defaultThresholds): AdaptationPlan {
  const candidate = scoreProject(source, target, thresholds);
  const actions: AdaptationAction[] = [];
  for (const feature of source.features) {
    const change = target.changes.find(item => item.feature === feature.name);
    const kind = target.removeFeatures.includes(feature.name) ? 'REMOVE' : change ? 'MODIFY' : 'KEEP';
    actions.push({ kind, feature: feature.name, paths: feature.paths, automatic: false,
      reason: kind === 'REMOVE' ? 'Explicitly removed by target requirements; check dependents before deleting.' : change?.instruction ?? (target.features.includes(feature.name) ? 'Preserve existing implementation; verify it satisfies target behavior.' : 'Not requested, but omission alone does not authorize deletion. Review whether this is needed.') });
  }
  for (const feature of candidate.missingFeatures) actions.push({ kind: 'ADD', feature, paths: [], automatic: false, reason: 'No implementation evidence in selected base. Review module candidates before generating the missing functionality.' });
  for (const change of target.changes.filter(item => !source.features.some(feature => feature.name === item.feature))) actions.push({ kind: 'MODIFY', feature: change.feature, paths: [], automatic: false, reason: `${change.instruction} (No source path resolved; agent review required.)` });
  actions.push({ kind: 'VERIFY', feature: 'target behavior', paths: source.structure.testFiles, automatic: false, reason: 'Run explicitly trusted tests after adaptation; add tests for changed and added behavior.' });
  const body = {
    schemaVersion: 1 as const, sourceProject: source.id, sourceSnapshot: source.snapshot, sourceCommit: source.sourceCommit,
    requirements: target, candidate, thresholds, actions, moduleCandidates: findModules(projects, target, source),
    risks: [...source.warnings, ...candidate.blockers, 'V0.1 does not infer arbitrary domain renames or remove unspecified features. Provide structured changes.', 'Copying does not apply modifications, removals or module candidates; the coding agent must implement and test the delta.'],
    agentInstructions: [
      'Copy eligible source bytes with prepare_reuse; never regenerate KEEP files from model context.',
      'Review the plan and relevant paths. Read only the source needed to implement MODIFY, REMOVE and ADD actions.',
      'Patch the copied workspace. Preserve unrelated source and license notices.',
      'Run explicitly selected trusted tests, then record the result and inspect provenance.',
    ],
  };
  return { ...body, id: hash(JSON.stringify(body)).slice(0, 24) };
}
