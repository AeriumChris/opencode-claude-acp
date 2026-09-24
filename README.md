# opencode-claude-acp

Use **Claude Code (ACP)** from OpenCode's model selector. The plugin runs on the OpenCode server, so terminal and web clients connected to that server share the provider, conversation output, and approval questions.

Built for **OpenCode V2 2.0.15**, with Node.js 22 or newer. This is an initial implementation; the compatibility limits below matter for everyday use.

## Install

Clone this private repository on the machine running the **OpenCode server**, using a GitHub account with access:

```sh
git clone https://github.com/AeriumChris/opencode-claude-acp.git
cd opencode-claude-acp
npm ci
npm run build
```

Authenticate Claude Code as the same OS user that runs that server. The installed ACP adapter includes a Claude CLI; a separate global `claude` installation is optional:

```sh
node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli auth login
```

Add the repository **directory URL** to the server's `opencode.json` or `opencode.jsonc`. Merge this entry into an existing `plugins` array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///C:/Local/opencode-claude-acp",
      "options": {
        "nodeExecutable": "node"
      }
    }
  ]
}
```

On Linux/macOS, use a URL such as `file:///home/you/opencode-claude-acp`. `nodeExecutable` must resolve in the **server's** environment; use an absolute Node executable path if needed. The root `server.js` entrypoint is required for OpenCode's local directory loader.

For all projects, use `~/.config/opencode/opencode.jsonc` (or the corresponding `$XDG_CONFIG_HOME` location). For one project, use its `opencode.jsonc`. Restart the OpenCode service after installation:

```sh
opencode service restart
```

Open the model selector and choose **Claude Code (ACP)**, then its default or an advertised Claude model. Discovery runs asynchronously, so the default entry may appear before the model list. Claude authentication is managed by Claude Code; this provider does not need an OpenCode API key.

### Web clients

Connect OpenCode web to the server where the plugin and Claude credentials are installed, and open a project covered by that server's plugin configuration. The provider is registered in the server model catalog used by both clients. Files and commands execute in that project's directory **on the server**.

The automated HTTP test verifies model discovery, sessions, approvals, and results across two separate clients. Visual browser verification is still outstanding.

## Behavior

The execution path follows Zed's external-agent approach:

```text
OpenCode terminal / web
        ↓ shared server model catalog and session API
OpenCode plugin + native provider transport
        ↓ ACP over subprocess stdin/stdout
@agentclientprotocol/claude-agent-acp
        ↓ Claude Agent SDK
Claude Code CLI
```

- Claude owns the agent loop, its tools, and native project configuration such as `CLAUDE.md`.
- Model choices come from ACP session configuration; Claude model IDs are not hardcoded.
- Desktop/web defaults to recent entries, one per model family. ACP choices therefore use their catalog-registration time and separate families so they appear by default. This timestamp describes the catalog entry, not the underlying Claude model's launch date. Explicit client-side hidden-model preferences still take precedence.
- Each OpenCode session has a separate ACP connection and native session identity. Follow-up messages reuse it; idle connections close after five minutes and reload saved sessions on demand.
- Text and thought chunks stream into OpenCode. Completed/failed Claude tools appear as provider-executed `claude_code` results.
- ACP permission requests become OpenCode **question forms** with **Deny** and **Allow once** choices. These work across clients. Only the exact affirmative answer recorded by the host's tool execution grants permission. Dismissal, interruption, and unexpected answers do not approve the operation.
- Stop cancels the ACP turn. Automatic model retries are disabled to avoid repeating agent-side effects.
- Session IDs and user-message fingerprints are stored through OpenCode plugin storage. Claude retains its own native session history.

OpenCode 2.0.15's public plugin API cannot create native permission requests directly, which is why this release uses its built-in question UI. Keep the `question` tool enabled.

## Options

All options are optional:

| Option | Default | Purpose |
| --- | --- | --- |
| `nodeExecutable` | `node` | Node executable used to launch the bundled adapter. |
| `command` | Bundled adapter via Node | Override the ACP executable. No shell expansion is performed. |
| `args` | `[]` with custom command | Argument array; requires `command`. |
| `env` | Inherited server environment | Extra environment variables for the subprocess. |
| `startupTimeoutMs` | `30000` | Initialization and session creation/load deadline. |
| `idleTimeoutMs` | `300000` | Close completed, inactive ACP connections after this interval. |

To use an existing Claude CLI, set `CLAUDE_CODE_EXECUTABLE` in the server environment or through `options.env`. Use an executable path, not a shell command. The ACP adapter still wraps that CLI.

## Current limits

- OpenCode's agent instructions, plan mode, custom tools, permission rules for those tools, and MCP configuration are **not translated into Claude's runtime**. In particular, selecting OpenCode's plan agent does not put Claude into plan mode. Configure Claude's own behavior and permissions separately; approvals already allowed by Claude's native configuration will not produce an ACP question.
- OpenCode-side compaction and auxiliary generation are unsupported and fail explicitly. Claude manages its own context; start a new OpenCode session if the host reaches its context limit. Host token-limit metadata uses OpenCode defaults, not an ACP-reported model limit.
- Token usage/cost reporting, effort and mode selectors, slash-command discovery, in-progress tool rendering, and native edit-review UI are not implemented.
- Inline images are forwarded when the agent advertises support. Remote media URLs and other attachment types are unsupported.
- The bridge targets the bundled Claude adapter's ACP configuration-options API. It is not a general compatibility layer for every ACP agent.
- If native session loading fails, the error is surfaced. Prompts already submitted are not automatically replayed. After switching from another provider or changing history, prior text is supplied as historical context to a new Claude session.
- Discovery failures leave the default entry available; submitting a message surfaces startup/authentication errors. Check the bundled CLI directly when troubleshooting login or executable issues.

## Development and verification

```sh
npm ci
npm run build
npm test
```

Tests run a deterministic ACP subprocess through the **real OpenCode host**, covering dynamic models, model switching, streamed output, continuity, allow/deny/custom answers, dismissal, cancellation, session loading, and isolation. A separate test loads the plugin from its directory via an authenticated HTTP server and exercises approvals from a second client. These tests do not use a Claude account.

For an authenticated request through the actual bundled adapter and Claude CLI:

```sh
npm run smoke
```

This sends a small prompt using your Claude account in a temporary project and expects `ACP_READY`. It was verified locally on Windows with OpenCode 2.0.15. Set `OPENCODE_TEST_TMP` to choose the parent directory for temporary verification projects.

To also verify actual file-tool execution and its OpenCode tool result:

```sh
npm run smoke -- --tools
```

This asks Claude to create one scratch file, approves only an exact matching write if an approval is requested, checks the file and displayed tool result, then removes the temporary project. This check also passed locally with the real Claude adapter and CLI.

Source layout:

- `src/index.ts`: provider registration and OpenCode hooks.
- `src/provider.ts`: native model transport and cancellation handling.
- `src/acp.ts`: subprocess lifecycle and ACP session/model negotiation.
- `src/bridge.ts`: conversation cursor, event translation, and approval continuation.
- `test/`: real-host and shared HTTP-client integration tests.

References: [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins), [Zed external agents](https://zed.dev/docs/ai/external-agents), and [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp). The adapter is maintained separately and distributed under Apache-2.0.
