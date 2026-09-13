# Connect CodeRecall to your coding agent

CodeRecall is a local MCP server. The agent calls it to find existing code, review a plan and copy a compatible base. **It does not intercept every generation automatically.** Give your agent the workflow instruction below and keep its existing tool-approval settings.

## 1. Build once and choose your scope

Follow the [README quick start](../README.md#try-the-demo). Use absolute paths in MCP configuration:

- CLI: the built `dist/cli.js` inside your CodeRecall checkout.
- Memory: a private local directory, shared between your CLI and MCP configuration.
- Allowed root: a folder containing the repositories to index and any new target directories.

The allowed root must exist. Memory should be separate from source/target repositories. You can list multiple allowed roots after `--allow-root`. Omit `--enable-copy` to restrict the server to reads, indexing, planning and previews. These examples explicitly enable copying, which still requires `apply: true` and all compatibility/safety gates.

In the examples, replace `/absolute/path/to/CodeRecall`, `/absolute/path/to/memory` and `/absolute/path/to/projects`. On Windows, forward-slash paths such as `C:/Tools/CodeRecall/dist/cli.js` work; quote paths with spaces. If your client cannot find `node`, use its absolute executable path.

## 2. Register the server

### OpenAI Codex

```sh
codex mcp add coderecall -- node "/absolute/path/to/CodeRecall/dist/cli.js" --home "/absolute/path/to/memory" mcp --allow-root "/absolute/path/to/projects" --enable-copy
```

This uses Codex's local stdio MCP command. Start a new agent session if necessary so it picks up the configuration. The command syntax is also available from your installed `codex mcp add --help`.

### Claude Code

```sh
claude mcp add --transport stdio --scope user coderecall -- node "/absolute/path/to/CodeRecall/dist/cli.js" --home "/absolute/path/to/memory" mcp --allow-root "/absolute/path/to/projects" --enable-copy
```

Check the connection with `claude mcp list`. See the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for scopes and client permissions.

### Cursor and other JSON-configured MCP clients

For Cursor, add this entry to `.cursor/mcp.json` for one project or `~/.cursor/mcp.json` for your user. Merge with existing servers instead of replacing the whole file.

```json
{
  "mcpServers": {
    "coderecall": {
      "command": "node",
      "args": [
        "/absolute/path/to/CodeRecall/dist/cli.js",
        "--home", "/absolute/path/to/memory",
        "mcp",
        "--allow-root", "/absolute/path/to/projects",
        "--enable-copy"
      ]
    }
  }
}
```

The [official Cursor MCP documentation](https://cursor.com/docs/mcp) explains configuration locations. Other clients may use a different configuration wrapper; the server command and arguments remain the same.

Protocol initialization and tool calls are covered by automated MCP tests. The configuration recipes follow client documentation; they do not imply every client version has been manually tested.

## 3. Index and verify a source you trust

Use the same memory directory as the server:

```sh
node "/absolute/path/to/CodeRecall/dist/cli.js" --home "/absolute/path/to/memory" index "/absolute/path/to/projects/old-saas" --permission owned --owner "My team" --attestation "We own this source and permit reuse in the new target"
node "/absolute/path/to/CodeRecall/dist/cli.js" --home "/absolute/path/to/memory" verify old-saas --trust -- node --test
```

Replace the verification command with the source project's actual tests. It runs trusted repository code on your machine, not in a sandbox. Indexing does not execute code. A matching feature name, a test filename or permission inferred by an agent is not sufficient evidence for copying.

You may ask the agent to call `index_repository` instead, but supply the ownership/permission statement yourself. Do not let an agent invent reuse rights.

## 4. Give the agent a recall-first instruction

Add [the example instruction](../examples/agent-instructions.md) to the project instructions your client uses, or paste it into the conversation:

> Before generating substantial new code, call CodeRecall's `match_projects` with the target requirements. Inspect the candidate evidence and blockers. If full reuse is permitted, create a plan, preview the copy and use `prepare_reuse` to transfer existing files. Never regenerate KEEP files merely to reproduce them. Read and patch the files needed for the delta. Treat module candidates as review-only. If reuse is blocked, explain why and generate the missing work normally. Run meaningful trusted tests after adaptation and record the result through the CodeRecall CLI.

For ambiguous prose or explicit removals, provide structured requirements like [booking-requirements.json](../examples/booking-requirements.json). An MCP connection does not enforce agent behavior; the instruction and your client's permissions complete the workflow.

## 5. Record the adapted result

After the agent changes the copied target:

```sh
node "/absolute/path/to/CodeRecall/dist/cli.js" --home "/absolute/path/to/memory" record-result "/absolute/path/to/projects/new-saas" --trust -- node --test
node "/absolute/path/to/CodeRecall/dist/cli.js" --home "/absolute/path/to/memory" provenance "/absolute/path/to/projects/new-saas" src/auth/session.mjs
```

Use the real target test command and a real copied file path. The server deliberately has no shell-execution tool; the agent's existing terminal capability or you run this explicit verification step. The result separates unchanged, modified, added and removed eligible files. It does not invent external agent token usage.

## Troubleshooting

- **No candidates:** index sources into the same `--home`; confirm they are inside an allowed root.
- **Full reuse blocked:** inspect individual reasons. Verify meaningful tests, specify the target stack and record genuine reuse permission. Do not lower thresholds merely to force a match.
- **Source changed:** commit the intended source changes, reindex, verify and create a fresh plan.
- **Destination exists:** choose a new path under an allowed root with an existing parent. Empty existing directories are also rejected.
- **Server starts but waits silently:** stdio servers wait for the MCP client; they are not interactive terminal applications.
- **Privacy:** CodeRecall itself makes no cloud/model calls, but a cloud agent can receive tool-returned metadata. Keep private source bodies and secret values out of prompts.
