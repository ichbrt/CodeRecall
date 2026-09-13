export const SCHEMA_VERSION = 1;

export interface FileRecord {
  path: string;
  hash: string;
  bytes: number;
  lines: number;
  executable: boolean;
}

export interface FeatureEvidence {
  name: string;
  paths: string[];
  confidence: number;
  basis: 'static-heuristic';
}

export interface TechnologyFingerprint {
  languages: string[];
  frameworks: Record<string, string>;
  runtime: string | null;
  platform: 'web' | 'server' | 'mobile' | 'library' | 'unknown';
  database: string | null;
  orm: string | null;
  packageManager: string | null;
  dependencies: Record<string, string>;
}

export interface SourceStructure {
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  interfaces: string[];
  routes: string[];
  testFiles: string[];
  moduleRoots: string[];
}

export interface Verification {
  status: 'passed' | 'failed';
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  at: string;
  snapshot: string;
  durationMs: number;
  scope: 'user-selected-command';
}

export interface ReusePolicy {
  permission: 'unknown' | 'owned' | 'permitted' | 'denied';
  owner: string | null;
  attestation: string | null;
  restrictions: string[];
}

export interface ProjectFingerprint {
  schemaVersion: 1;
  analyzerVersion: string;
  id: string;
  name: string;
  root: string;
  sourceCommit: string;
  snapshot: string;
  clean: boolean;
  indexedAt: string;
  technology: TechnologyFingerprint;
  features: FeatureEvidence[];
  structure: SourceStructure;
  files: FileRecord[];
  exclusions: Record<string, number>;
  license: string | null;
  policy: ReusePolicy;
  verification: Verification | null;
  warnings: string[];
}

export interface Requirements {
  description: string;
  features: string[];
  platform: TechnologyFingerprint['platform'] | null;
  language: string | null;
  frameworks: Record<string, string>;
  runtime: string | null;
  database: string | null;
  orm: string | null;
  dependencies: Record<string, string>;
  removeFeatures: string[];
  changes: { feature: string; instruction: string }[];
}

export interface Signal {
  dimension: 'semantic' | 'technical' | 'structural' | 'health' | 'safety';
  label: string;
  score: number;
  weight: number;
  explanation: string;
}

export interface Scores {
  semanticSimilarity: number;
  technicalCompatibility: number;
  structuralCompatibility: number;
  projectHealth: number;
  reuseSafety: number;
  reuseConfidence: number;
}

export interface Thresholds {
  semantic: number;
  technical: number;
  structural: number;
  health: number;
  confidence: number;
}

export interface ProjectCandidate {
  projectId: string;
  name: string;
  scores: Scores;
  signals: Signal[];
  blockers: string[];
  decision: 'project' | 'modules' | 'generate';
  matchedFeatures: string[];
  missingFeatures: string[];
}

export interface ModuleCandidate {
  projectId: string;
  feature: string;
  paths: string[];
  status: 'review-required';
  technicalCompatibility: number;
  reasons: string[];
}

export interface AdaptationAction {
  kind: 'KEEP' | 'MODIFY' | 'REMOVE' | 'ADD' | 'VERIFY';
  feature: string;
  paths: string[];
  reason: string;
  automatic: false;
}

export interface AdaptationPlan {
  schemaVersion: 1;
  id: string;
  sourceProject: string;
  sourceSnapshot: string;
  sourceCommit: string;
  requirements: Requirements;
  candidate: ProjectCandidate;
  thresholds: Thresholds;
  actions: AdaptationAction[];
  moduleCandidates: ModuleCandidate[];
  risks: string[];
  agentInstructions: string[];
}

export interface ReuseRecord {
  schemaVersion: 1;
  id: string;
  planId: string;
  sourceProject: string;
  sourceRoot: string;
  sourceCommit: string;
  sourceSnapshot: string;
  destination: string;
  at: string;
  policy: ReusePolicy;
  license: string | null;
  files: FileRecord[];
  metrics: { filesCopied: number; linesCopied: number; bytesCopied: number; generatedSourceTokens: 0 };
}

export interface ResultRecord {
  reuseId: string;
  targetCommit: string | null;
  verification: Verification;
  unchanged: string[];
  modified: string[];
  removed: string[];
  added: string[];
  unchangedLines: number;
  modifiedFileLines: number;
  addedFileLines: number;
  excludedFiles: Record<string, number>;
  completeInventory: boolean;
  agentUsage: { inputTokens: number; outputTokens: number; toolCalls: number } | null;
}
