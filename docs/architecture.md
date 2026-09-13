# V0.1 architecture and decisions

## Product invariant

**Copying code must not require regenerating code.** Retrieval locates reusable source; filesystem operations transfer bytes; the coding agent modifies the delta. No module in the core calls an LLM or sends source over the network. CLI/MCP return metadata, evidence and paths, not implementation bodies.

## Why this stack

TypeScript provides strict domain types, a mature JavaScript/TypeScript parser and a shared ecosystem for CLI/MCP. Node 24 provides cross-platform filesystem/process APIs and built-in SQLite without a native database addon compilation step. Git gives identity, commit provenance and tracked-file boundaries. SQLite provides local transactional storage with no service to operate.

The SQLite API is isolated in `RepositoryStore`; see [Node 24 SQLite documentation](https://nodejs.org/docs/latest-v24.x/api/sqlite.html). The MCP boundary uses the [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). The TypeScript parser is a runtime dependency because source analysis is a core function.

Tree-sitter would broaden language support but add grammar packaging and native/WASM decisions before the first supported workflow needs it. Embeddings would introduce model downloads and fuzzy ranking without resolving compatibility or ownership. Both are deferred, not architectural prerequisites.

No Vercel deployment, database provider, Redis, hosted vector store or external integration is needed for this CLI product.

## Structure

```text
src/
  domain.ts         Versioned records and distinct score concepts
  safety.ts         Bounded inventory, ignore rules, secret screening, Git reads
  analyzer.ts       Manifest and TypeScript AST fingerprint extraction
  requirements.ts  Validated structured input and limited prose vocabulary
  scoring.ts        Explainable signals, hard gates, project and module candidates
  planner.ts        Deterministic adaptation instructions
  store.ts          SQLite projects, plans, reuse events and verification results
  reuse.ts          Revalidation, preview, exclusive copy, provenance
  verification.ts   Explicit execution boundary and target file comparisons
  engine.ts         Small workflow facade
  cli.ts            Command presentation
  mcp.ts            Scoped protocol adapter
tests/              Unit, integration, CLI and MCP tests; fixture factory
scripts/            Reproducible checks and synthetic demonstration
examples/           Requirements and threshold JSON
docs/               Decisions and benchmark protocol
```

The core domain has no brand-specific provider contracts. The brand appears in the CLI/server identity, package metadata and default memory/target metadata directories. Renaming does not change the matching, storage or reuse model; a future rename should retain old data paths or provide migration.

## Data model and fingerprint

`ProjectFingerprint` is the index unit. It includes versioned analyzer identity, canonical root-derived ID, project name, source commit, accepted-file snapshot hash, tracked cleanliness, timestamp, technology fingerprint, feature evidence, source structure, file hashes/counts, exclusion counts, license metadata, user-attested reuse policy and snapshot-bound verification.

Example shape (values are illustrative, not benchmark claims):

```json
{
  "schemaVersion": 1,
  "analyzerVersion": "ts-static/1",
  "id": "root-derived-id",
  "root": "/projects/next-saas",
  "sourceCommit": "full-git-commit-id",
  "snapshot": "sha256-of-file-records",
  "technology": {
    "languages": ["TypeScript", "JavaScript"],
    "frameworks": { "next": "^16.0.0" },
    "runtime": "node >=24",
    "platform": "web",
    "database": null,
    "orm": null,
    "packageManager": null,
    "dependencies": { "next": "^16.0.0" }
  },
  "features": [
    { "name": "auth", "paths": ["src/auth/session.mjs"], "confidence": 0.75, "basis": "static-heuristic" }
  ]
}
```

Feature evidence comes from source paths, imports and declared functions/classes/interfaces. Tests and README promises do not add production feature evidence. The fixed evidence confidence indicates the analyzer's heuristic tier; it is not a learned probability. Supported fields are extracted from real evidence. Unknown database, runtime or package manager remains `null`.

`Requirements` separates description, required features, platform, language, framework/runtime/dependency ranges, database/ORM, explicit changes and explicit removals. Structured input is authoritative. The prose parser is a convenience for a narrow English vocabulary; it cannot resolve arbitrary negation or business rules.

`ProjectCandidate` contains all score dimensions, individual weighted signals, blockers, matched/missing features and a project/modules/generate decision. `ModuleCandidate` identifies feature-local paths and a conservative module assessment independently from the entire project's score. It always requires review because transitive import closure is not known.

`AdaptationPlan` binds requirements, source commit/snapshot, thresholds, candidate evidence, actions, module candidates and risks. Its content-derived ID makes the persisted plan addressable. `ReuseRecord` preserves exact transferred-file hashes, source root/commit, policy, target, timestamp and transfer metrics. `ResultRecord` binds an explicit verification command to the current target snapshot and file categories. Later success does not yet train confidence or extract patterns.

SQLite stores JSON documents in four small tables with explicit schema versioning. It stores no raw file bodies, remote URLs or Git credentials. On POSIX, newly created memory directories/files use owner-only permissions. Windows uses inherited filesystem ACLs. This is local storage, not encryption.

## Explainable scoring v1

All scores are in `[0, 1]`. Unknown evidence is not assigned perfect compatibility. Each signal has a dimension, score, weight and explanation. Weighted means apply within dimensions.

| Dimension | V0.1 implementation |
| --- | --- |
| Semantic similarity | Required-feature coverage: matched distinct feature names / requested features. No features → zero. This is a lexical/static proxy, not embedding semantics. |
| Technical compatibility | Platform weight 3, runtime family 2, optional runtime range 2, language 2, each framework 4, database 3, ORM 2, each explicitly constrained dependency 1. Unrequested axes do not imply compatibility. |
| Structural compatibility | Named functions/exports weight 1; Next.js routing-tree convention weight 2 when requested. This is a limited architecture proxy. |
| Health | Successful selected command on the same snapshot within 7 days: 1; failed: 0; tests exist but unverified: 0.45; no tests/verification: 0.15. |
| Safety | 1 only for clean tracked source and explicit owned/permitted policy with nonempty owner/attestation and no unresolved restrictions; otherwise 0. |

For constrained versions, a source range wholly contained by the requested range scores 1. Partial overlap scores 0.6 and blocks full reuse; invalid/unresolved specs score 0.35 and block; absence or disjoint ranges score zero and block. An unconstrained target `*` establishes package presence only. Installed resolutions, peer dependencies, breaking changes within a major, lockfile integrity and vulnerabilities are not audited.

Confidence is a weighted geometric mean multiplied by the safety gate:

```text
C = semantic^0.35 × technical^0.30 × structural^0.15 × health^0.20 × safety
```

Multiplication penalizes a weak axis. It does not replace independent gates. Default full-project minimums are semantic 0.70, technical 0.85, structural 0.65, health 0.60 and confidence 0.70. These are initial conservative engineering settings, **not empirically calibrated success probabilities**. Their behavior is tested against compatible/incompatible fixture cases, version boundaries, unknown permissions and missing/expired/failed verification. Calibration requires the benchmark corpus.

Full reuse also requires no hard blocker: absent or incompatible explicit technology constraints, unknown/restricted rights, dirty source, failed current verification, no eligible files or no declared target technology constraint. Lowering soft thresholds cannot override hard blockers. A high domain score cannot make Flutter a Next.js base.

Candidates passing every gate sort ahead of blocked ones, then confidence, semantic coverage and stable ID break ties. `modules` means useful feature paths may deserve review; it never means automatic copy approval. Unsafe modules are not suggested for application. `generate` is an ordinary correct outcome when evidence is unsuitable.

## Copy mechanism

Use a selective filesystem copy of Git-tracked, accepted working-tree bytes after requiring a clean tracked source. Do not use `git clone`: it would carry history and potentially sensitive historical objects. Do not use a worktree: targets need independent repositories. Do not rely on `git archive` alone: it does not provide this application's content screening and ignore policy.

The plan freezes a commit and accepted-file snapshot. Apply recomputes the fingerprint, checks current permission and verification, reruns all gates, checks every buffered file hash and repeats source validation before target creation. No Git hooks run and no source Git configuration or `.git` directories are transferred. The new workspace is not initialized as a Git repository automatically.

Targets must not exist, must have an existing parent, and must not overlap source or memory. Paths may not traverse symbolic links or junctions. Creation is exclusive (`mkdir`, per-file `wx`), with no force-overwrite flag. On an interrupted or failed copy, a partial directory may remain for inspection; the engine will never delete potentially unrelated concurrent writes during rollback. A successful operation writes `.coderecall/provenance.json` and `plan.json`, then the memory record. These two locations are not a distributed transaction; a crash can leave local provenance requiring reconciliation.

Dry-run performs reads and source validation only; it does not create the target or persist a reuse event. Source indexing/plan creation are separate explicit writes to local memory.

## Security and bounded scope

Only tracked files are indexed from source repositories. Default path exclusions always win. Nested Git ignores can refine ancestor Git rules; CodeRecall ignore rules form an additional restriction. Symlinks, junctions, hardlinks, submodules, nested repositories, binaries, credentials, `.env*`, generated files and common secret content are omitted. Exclusion output is aggregated by reason so secret values and excluded filenames do not become index content.

Limits are 1 MiB per file, 20,000 accepted files and 64 MiB accepted text per repository. Oversized files are excluded; total-limit overflow aborts indexing rather than silently returning a complete-looking partial index. This implementation targets ordinary trusted local developer workspaces, not an adversarial filesystem changing links concurrently. Secret detection is best-effort pattern scanning, not a substitute for a dedicated scanner.

Verification runs only the user-selected executable/arguments with an explicit trust acknowledgment. No shell is added, no scripts are autodetected and stdout/stderr are not persisted. The command inherits the local environment and is **not sandboxed**. A timeout kills the direct child; a malicious command could spawn persistent descendants. Hostile repositories must be verified in an external sandbox. A passed no-op proves only that no-op: the operator must select meaningful tests.

## Acceptance criteria and validation mapping

| Criterion | Executable evidence |
| --- | --- |
| Three committed sources indexed, feature/technology evidence extracted | Core fingerprint tests and demo |
| Next.js base selected only after explicit verification | Integration milestone and CLI workflow |
| Express booking candidate flagged for framework/import review | Scoring and integration tests |
| Utility rejected despite README feature words | Fingerprint and scoring tests |
| Explainable gated decision and deterministic adaptation plan | Core scoring, compatibility and planning tests |
| Exact copied bytes, no secrets/history, no overwrite, stale source rejection | Integration and ignore/security tests |
| Agent delta remains distinct from copy operation | Integration modification/addition assertions |
| Tests executed and commit/file provenance recorded | Verification/result/provenance tests |
| First-class CLI and interoperable scoped MCP | CLI integration, in-memory and real stdio MCP tests |
| Build, strict types and lint succeed | `pnpm check` |

## Hardest unresolved problems

Real feature completeness, transitive module coupling, schema/business-rule compatibility, freshness and security of legacy code, version migrations and robust semantic deltas remain substantial engineering work. Naive retrieval confuses shared words with interchangeable architecture, counts test presence as health, trusts repository-supplied rights, deletes omitted features, or pushes complete code back into model context. This vertical slice explicitly avoids those assumptions and exposes its limited evidence rather than pretending they are solved.

V0.1 ships the small project-reuse loop. Universal AST analysis, embeddings, module assembly, automatic code rewriting, pattern learning, distributed indexes, enterprise policy and UI are deliberately excluded.
