import type { ReusePolicy, Thresholds } from './domain.js';
import { fingerprint, unknownPolicy } from './analyzer.js';
import { createPlan } from './planner.js';
import { parseRequirements } from './requirements.js';
import { defaultThresholds, findModules, rankProjects } from './scoring.js';
import { RepositoryStore } from './store.js';

export class RecallEngine {
  constructor(public readonly store: RepositoryStore) {}

  async index(root: string, policy?: ReusePolicy) {
    const project = await fingerprint(root, policy ?? unknownPolicy);
    const previous = this.store.listProjects().find(item => item.id === project.id);
    if (!policy && previous) project.policy = previous.policy;
    this.store.saveProject(project);
    return project;
  }

  match(input: unknown, thresholds: Thresholds = defaultThresholds) {
    const requirements = parseRequirements(input);
    const projects = this.store.listProjects();
    const candidates = rankProjects(projects, requirements, thresholds);
    const selected = candidates.find(candidate => candidate.decision === 'project');
    const base = selected ? projects.find(project => project.id === selected.projectId) : undefined;
    return { requirements, candidates, recommendedProject: selected?.projectId ?? null, moduleCandidates: findModules(projects, requirements, base), freshness: 'Indexed snapshots; prepare_reuse revalidates live source.' };
  }

  plan(projectId: string, input: unknown, thresholds: Thresholds = defaultThresholds) {
    const plan = createPlan(this.store.project(projectId), parseRequirements(input), this.store.listProjects(), thresholds);
    this.store.savePlan(plan);
    return plan;
  }
}
