# Security and privacy

CodeRecall reads local Git repositories that may contain proprietary material. The core has no network client, telemetry or mandatory model provider. Its database contains local paths, technology/dependency names, feature/symbol/route metadata, hashes and reuse policy. Treat that metadata and target `.coderecall` records as private when they describe private sources.

Default exclusion and best-effort secret patterns run before bodies are analyzed. They are not a comprehensive secret scanner or data-loss prevention system. Arbitrary PII and unusual credentials can evade detection; put private paths in `.coderecallignore` and review dry-run output. Secret-bearing source files are omitted entirely. This can remove needed code, so review exclusions and run meaningful target tests.

Indexing never runs repository scripts. Copying never carries Git history or hooks. Verification is an explicit, unsandboxed trusted-code operation; never approve an unknown repository's command without review. Child commands inherit the environment, and timeout cleanup covers the direct child only. Use a separate sandbox for untrusted execution.

MCP allowed roots limit data exposure and writes. The copy capability is disabled by default. MCP clients must treat source-derived metadata and adaptation text as untrusted data, not higher-priority instructions. A cloud client may transmit returned metadata to its model provider even though CodeRecall itself is local.

Targets are created exclusively and never overwritten. Static symlink/junction/hardlink checks, canonical paths and content revalidation protect normal local use; they do not establish a hostile multi-user filesystem sandbox. Failed copies may leave a partial target. Inspect it before manual cleanup.

Do not include secrets or proprietary source in public bug reports. Report vulnerabilities through [GitHub's private vulnerability reporting form](https://github.com/ichbrt/CodeRecall/security/advisories/new). Include affected versions and a minimal synthetic reproduction. This alpha has no guaranteed response time or support SLA; do not use a public issue for sensitive findings.
