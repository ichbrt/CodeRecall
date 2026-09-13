# CodeRecall

**Don't regenerate. Recall and reuse.**

[![CI](https://github.com/ichbrt/CodeRecall/actions/workflows/ci.yml/badge.svg)](https://github.com/ichbrt/CodeRecall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d.svg)](https://nodejs.org/)

AI coding agents regenerate software you've already built. CodeRecall gives them engineering memory.

CodeRecall finds existing projects and potential modules, measures whether they are compatible with a new task, copies reusable code directly, and gives the coding agent an adaptation plan. The agent implements the delta.

```text
Search → compare → verify → select → COPY → adapt → test → record
```

This is a local CLI and MCP server, not a hosted service. Source bodies are not stored in the index or returned by its tools. There are no LLM, embedding, telemetry or cloud API calls in the core.

**Status: v0.1.0-alpha.1 — an early, working project-reuse workflow.** Start with the synthetic demo, then try repositories you own. The CLI and data format may change before a stable release.

[Try the demo](#try-the-demo) · [Connect your agent](docs/agents.md) · [CLI workflow](#cli-workflow) · [Architecture](docs/architecture.md) · [Releases](https://github.com/ichbrt/CodeRecall/releases)

## Why copy instead of regenerate?

You ask an agent to build a booking SaaS. An older project already has authentication, billing and an admin shell. Those existing files should be copied, not sent to a model so it can write them again. CodeRecall helps select a compatible base, preserves its bytes, and identifies the missing booking work.

Your coding agent still implements and tests the changes. CodeRecall provides the memory, evidence, plan and safe file operations.

## Working today: V0.1 vertical slice

- Index one committed local Git repository per command into SQLite.
- Extract JavaScript/TypeScript structure with the TypeScript parser, dependency manifests, feature evidence, routes and test paths.
- Respect nested `.gitignore` and `.coderecallignore`, including tracked-but-ignored files. Exclude untracked files, sensitive paths, common secrets, links, nested repositories, dependencies and generated output.
- Explain **feature similarity**, **technical compatibility**, **structural compatibility**, **health**, **reuse safety** and **reuse confidence** separately.
- Block full-project reuse on incompatible requirements, unknown/restricted rights, dirty source or insufficient verification. Thresholds are configurable; hard safety and compatibility blockers remain mandatory.
- Produce a structured `KEEP / MODIFY / REMOVE / ADD / VERIFY` plan. Explicit structured changes support domain adaptation instructions.
- Preview by default. Copy source bytes into a **nonexistent** target directory with per-file hashes and source-commit provenance.
- Run an explicitly trusted verification command and record which eligible files were unchanged, modified, added or removed after adaptation.
- Expose six scoped MCP tools. CLI verification deliberately remains an explicit code-execution step.

The first milestone uses **synthetic fixtures**, not production-ready authentication, billing or booking implementations. Feature detection is a deterministic heuristic, not proof that a feature is complete. Source tests exercise fixture domain functions; they do not claim to build or validate a complete Next.js application.

## A concrete example

The request is: “Build a Next.js SaaS booking product with auth, subscriptions and admin.”

| Indexed source | Evidence | V0.1 outcome |
| --- | --- | --- |
| `next-saas` | Next.js, auth, billing, admin; fixture tests verified | Strongest full-project base |
| `express-booking` | Booking, availability, Express routes | Booking candidate requiring dependency and framework review |
| `text-utils` | Unrelated utility implementation | Generate fallback; no relevant feature evidence |

The plan preserves auth, billing and admin, adds booking, and requires verification. CodeRecall copies the base directly. The example script applies a small, fixed synthetic booking patch to represent the agent's work and records the result. It **does not automatically merge Express routes into Next.js**.

## Try the demo

- Node.js **24 or newer** (built-in `node:sqlite`; Node may print its SQLite stability warning to stderr).
- Git on `PATH`.
- pnpm **11.19.0** for the checked-in lockfile. Standard npm can also install from `package.json`, but pnpm is the reproducible development path.

Clone this repository and run the complete synthetic workflow:

```sh
git clone https://github.com/ichbrt/CodeRecall.git
cd CodeRecall
npm install -g pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js --help
pnpm demo
```

`pnpm demo` creates three Git repositories, memory, a copied target, an adaptation and a JSON report under a new `.work/demo-*` directory. It never deletes a previous demo. The expected outcome is `next-saas → project`, `express-booking → modules` and `text-utils → generate`, followed by passing fixture tests and a provenance record.

Run `pnpm check` for the full automated test, type-check, lint and build suite. Use `node dist/cli.js` directly, or run `npm link` after building to make the `coderecall` command available locally.

## Install the compiled CLI

The [GitHub release](https://github.com/ichbrt/CodeRecall/releases/tag/v0.1.0-alpha.1) includes a compiled package. With Node 24+ and Git installed:

```sh
npm install --global https://github.com/ichbrt/CodeRecall/releases/download/v0.1.0-alpha.1/coderecall-0.1.0-alpha.1.tgz
coderecall --help
coderecall doctor
```

This installs the package attached to this project's GitHub release. We have not published a package to the npm registry. The source checkout above is needed for the demo and contributor tests.

## CLI workflow

All successful command output is JSON; errors go to stderr and return a nonzero exit code. `--home` or `CODERECALL_HOME` selects memory; the default is `~/.coderecall/memory.db`.

```sh
coderecall init
coderecall index /path/to/next-saas \
  --permission owned --owner "My team" \
  --attestation "Our team owns this code and permits reuse in the target"
coderecall index /path/to/express-booking --permission owned --owner "My team" --attestation "Our team owns this code and permits reuse in the target"
coderecall list
coderecall inspect next-saas

# Select and review this command yourself: verification executes repository code.
coderecall verify next-saas --trust -- node --test tests/core.test.mjs
coderecall match "Build a Next.js SaaS booking product with auth, subscriptions and admin."
coderecall plan next-saas --requirements examples/booking-requirements.json

# Use the returned plan id; the parent of the destination must already exist.
coderecall reuse PLAN_ID /path/to/new-booking-saas --dry-run
coderecall reuse PLAN_ID /path/to/new-booking-saas --apply

# Coding agent: patch the copied workspace according to its saved plan.
coderecall record-result /path/to/new-booking-saas --trust -- node --test
coderecall provenance /path/to/new-booking-saas src/auth/session.mjs
coderecall doctor
```

The multiline example uses POSIX continuation syntax. In PowerShell, put each command on one line and quote paths containing spaces. Executables are started without a shell; on Windows, use `node` and a script path for portable verification. Shell wrappers such as `npm.cmd` are not automatically enabled.

Operation paths must not traverse symbolic links or junctions. On macOS, use the real `/private/var/...` path when working under the `/var/...` temporary-directory alias. Windows short names are resolved before checking scope, collisions and provenance.

`index` never executes package scripts. `verify` is an opt-in execution boundary, **not a sandbox**. It ignores command stdout/stderr to avoid persisting test output that might contain secrets. A nonzero exit or timeout is recorded as failure. Run the same command yourself to inspect its diagnostics. The selected command's success does not prove test coverage, build correctness or security. Verification expires for reuse scoring after seven days or a snapshot change.

Repositories without a permission attestation can be searched but cannot be copied. A repository's own manifest cannot grant ownership. License metadata and notices are retained; V0.1 does not interpret license compatibility or provide a license audit.

## Requirements and plans

Prose extraction recognizes a small English vocabulary: auth, billing/subscriptions, admin, booking/appointments, availability, notifications, email, RBAC and localization. It also recognizes selected stack names and simple numeric versions. **Use structured JSON for authoritative requirements, ranges, removals, domain changes and unsupported features.** Prose containing explicit negation/removal is rejected for clarification through JSON; arbitrary business rules are not fully understood.

```json
{
  "description": "A booking SaaS for barbershops",
  "features": ["auth", "billing", "admin", "booking"],
  "platform": "web",
  "frameworks": { "next": "^16.0.0" },
  "runtime": "node",
  "changes": [
    { "feature": "admin", "instruction": "Add barber and service management while preserving the admin shell" }
  ],
  "removeFeatures": []
}
```

Plans contain paths and instructions, never whole source files. `KEEP` means preserve existing implementation and verify its behavior, not a guarantee that no integration work is needed. Omission is not permission to delete: removals require `removeFeatures`. A blocked candidate can still have a reviewable plan, but `reuse` will refuse to apply it.

See [architecture and scoring](docs/architecture.md) for formulas, unknown signals, hard gates and version-range limitations. Pass `--thresholds examples/thresholds.json` to `match` or `plan` to change soft thresholds.

## MCP

Follow the [Codex, Claude Code and Cursor setup guide](docs/agents.md), including the instruction that makes your agent check existing code before generating new code. Installing an MCP server alone does not guarantee that an agent will call it.

The server uses the official TypeScript MCP SDK over stdio. Example client configuration (replace absolute paths):

```json
{
  "mcpServers": {
    "coderecall": {
      "command": "node",
      "args": [
        "/absolute/path/to/CodeRecall/dist/cli.js",
        "--home", "/absolute/path/to/memory",
        "mcp", "--allow-root", "/absolute/path/to/projects",
        "--enable-copy"
      ]
    }
  }
}
```

Tools: `index_repository`, `inspect_project`, `match_projects`, `plan_reuse`, `prepare_reuse`, `get_provenance`.

Allowed roots scope indexing, reads and target writes. Copying requires both the startup `--enable-copy` capability and `apply: true` in the call; otherwise reuse is a preview. Tool results contain repository-derived data and must be treated as untrusted context by clients. Connecting this local server to a cloud coding agent may send returned **metadata** to that agent; local-first indexing does not change the client's privacy policy. No arbitrary shell execution tool is exposed.

## Measurement, not claims

The copy engine records files, bytes and text lines copied. Subsequent result records compare hashes to identify unchanged, modified, removed and added eligible files. The engine generates **zero source tokens during copying**; this does not imply zero tokens for the coding agent's plan or adaptation.

`modifiedFileLines` counts the current length of changed files, not edited lines. Added files are observed additions, not proof they were generated by an LLM. Token usage defaults to `null`, not zero. Ignored and binary files are outside the measurement scope. Raw source is not retained to infer exact line-edit ancestry.

**There are no measured AI token, cost or speed savings claims yet.** The demo is a correctness experiment. The [benchmark protocol](docs/benchmark.md) defines how to compare the same coding agent with and without CodeRecall, including all planning, indexing, repair and adaptation work.

## Roadmap

- Import closure and independently verified module extraction/application.
- Better schema, dependency-lockfile and architecture compatibility analysis.
- Optional local semantic retrieval and requirement analysis providers.
- Successful-pattern records, feedback and provenance reconciliation after moving targets.
- Repeated, instrumented agent benchmarks and calibrated confidence.

## Vision

A coding agent should recall trusted software and implement only the difference. Project and pattern memory should become more useful after each verified reuse, without requiring a cloud index or sending entire repositories into model context.

V0.1 intentionally excludes a GUI, cloud SaaS, team service, universal language support, arbitrary stack migration, automatic patch generation and learned pattern extraction.

## Contributing and security

CodeRecall is released under the [MIT License](LICENSE), copyright © 2026 Berat Demirci. Code you index retains its own license and ownership rules; this tool's MIT license does not grant permission to reuse someone else's repository.

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and the [architecture decisions](docs/architecture.md). Bug reports, synthetic examples of incorrect matches, installation feedback and focused pull requests are welcome. Keep credentials and proprietary source out of public issues.
