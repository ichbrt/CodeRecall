# Contributing

Use Node 24+ and Git. Install pnpm 11.19.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm demo
```

`pnpm check` runs strict type checking, ESLint, Node's test runner through tsx, then emits `dist`. Test fixtures create isolated temporary Git repositories and clean up only their own generated directories. The demo retains its workspace for inspection.

Keep domain logic separate from CLI/MCP presentation. Prefer deterministic extraction, exact copies and small patches. A change that sends reusable source to a model merely to reproduce it violates the product invariant.

Add behavior-focused tests for compatibility decisions, ignore/safety boundaries, provenance and real tool interfaces. Do not represent unknown evidence as a successful verification, license permission or benchmark result. A new analyzer must surface evidence, unsupported cases and its version.

Changes to security policy, ownership semantics, source licensing or automatic execution require explicit maintainer discussion. Include reproduction, behavior change and actual validation in pull requests. This project is licensed under the [MIT License](LICENSE). Contributions are accepted under the same license; submit only code you have the right to contribute.
