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

### Effort

After selecting a model, use OpenCode's **effort/variant picker** to choose an advertised level. Options are discovered separately for each model from ACP's `thought_level` configuration. Models that do not advertise effort have no effort variants; choices may appear shortly after model discovery finishes.

The selected effort is applied before the next new prompt and restored when a native session reconnects. Clearing the variant (Default) clears the explicit effort override and returns control to Claude's own defaults/settings. An in-progress prompt, including one paused for approval, keeps its original effort.

The same model variants are available to terminal, desktop, and web clients. CLI references can include the advertised variant, for example `claude-acp/opus#high` when `high` is available.

### Web clients

Connect OpenCode web to the server where the plugin and Claude credentials are installed, and open a project covered by that server's plugin configuration. The provider is registered in the server model catalog used by both clients. Files and commands execute in that project's directory **on the server**.

The automated HTTP test verifies model discovery, sessions, approvals, and results across two separate clients. Visual browser verification is still outstanding.

### Screenshots and files

Select **Claude Code (ACP)**, then use **Attach file**, paste a screenshot into the prompt, or drag and drop it. Add your question and send. Multiple images can accompany a prompt. No extra plugin configuration is needed.

- **PNG, JPEG, GIF, WebP:** forwarded as image bytes, with filenames when provided. Claude can inspect the image rather than just seeing its path.
- **UTF-8 text/source files:** OpenCode supplies the filename and decoded contents. This also covers SVG as text.
- **Directories:** OpenCode supplies an immediate directory listing. Ask Claude to inspect files inside using its native tools.
- Use `@` in the terminal to attach project files, or `opencode run --file screenshot.png "Explain this screenshot"`.

OpenCode resolves and processes attachments before the bridge sees them. With a remote server, upload/paste the local file; a `file:` URL refers to the **server's** filesystem. Programmatic clients can send `files: [{ uri: "data:image/png;base64,...", name: "screen.png" }]` or a server-local `file:` URL in `session.prompt`. HTTP/HTTPS attachment URLs are not supported by OpenCode.

Warm follow-ups reuse Claude's native image context without sending the image again. When a new Claude session is bootstrapped from existing OpenCode history, earlier image attachments are now included as historical context too.

OpenCode's upload and image-processing limits and Claude's own limits apply. Unsupported binaries such as audio/video are not made readable by this bridge; convert them to supported images or text. See [OpenCode V2 attachments](https://opencode.ai/v2/docs/attachments) for formats and limits.

### What Claude can access

| Resource | Access through this plugin |
| --- | --- |
| Repository files on the server | Yes, using Claude's native read/search/edit/terminal tools, subject to OS access and Claude permissions. The session's project directory is passed as its working directory. Files are read on demand, not all inserted into the prompt. |
| Screenshots and text files attached in OpenCode | Yes, through the prompt attachment path above. |
| Current conversation | New user turns and attachments are forwarded; existing text/images are supplied when starting a new native session from history. This is not access to all OpenCode sessions. |
| Claude configuration | The adapter loads Claude's user/project/local settings, including native project instructions such as `CLAUDE.md`. |
| OpenCode plugins | They still run in OpenCode, but their custom tools and internal APIs are not exposed to Claude. Host UI/event hooks can still operate; hooks targeting OpenCode tool execution do not intercept Claude's native tools. |
| MCP servers connected in OpenCode | **Not forwarded.** The ACP session is currently created with an empty client-supplied MCP list. OpenCode OAuth sessions are not transferred. Claude-native MCP configuration is separate. |
| OpenCode agents, skills, and plan mode | Their tool/instruction runtime is not mirrored. Explicit skill text present in user messages can reach Claude, but the OpenCode skill tool/catalog and agent modes are not exposed. |

Repository reading was verified with a real Claude request that recovered a random token from a scratch project file using its native tool. MCP/plugin access was checked against the bridge and adapter execution paths; sharing those tools would require an additional integration.

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
- DCP's generated trailing message-ID markers are removed before forwarding to Claude, using the persisted message text to distinguish them from literal markers you typed. This also keeps DCP renumbering from resetting the native conversation.
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
- Token usage/cost reporting, mode selectors, slash-command discovery, in-progress tool rendering, and native edit-review UI are not implemented.
- Images are forwarded when the agent advertises support; text and directory attachments are resolved by OpenCode. Binary documents and direct remote media references are unsupported by the bridge.
- The bridge targets the bundled Claude adapter's ACP configuration-options API. It is not a general compatibility layer for every ACP agent.
- If native session loading fails, the error is surfaced. Prompts already submitted are not automatically replayed. After switching from another provider or changing history, prior text is supplied as historical context to a new Claude session.
- Discovery failures leave the default entry available; submitting a message surfaces startup/authentication errors. Check the bundled CLI directly when troubleshooting login or executable issues.

## Development and verification

```sh
npm ci
npm run build
npm test
```

Tests run a deterministic ACP subprocess through the **real OpenCode host**, covering dynamic models, model-specific effort variants, model/effort switching, resetting effort, streamed output, continuity, allow/deny/custom answers, dismissal, cancellation, session loading, and isolation. A separate test loads the plugin from its directory via an authenticated HTTP server and exercises effort selection and approvals from a second client. These tests do not use a Claude account.

The host test also injects DCP-style compact/XML markers after the ACP context hook, checks that Claude receives the original text, and verifies that user-authored markers, quotes, and whitespace survive unchanged.

The HTTP test uploads a PNG and attaches a server-local text file, checks exact ACP image data and text, verifies a second client sees the attachment, and checks image retention when rebuilding a native session from history.

For an authenticated request through the actual bundled adapter and Claude CLI:

```sh
npm run smoke
```

This sends a small prompt using your Claude account in a temporary project and expects `ACP_READY`. It was verified locally on Windows with OpenCode 2.0.15. Set `OPENCODE_TEST_TMP` to choose the parent directory for temporary verification projects.

To verify an effort supported by the default model, run `npm run smoke -- --effort=high`. This uses the real adapter and CLI with that selected variant.

To also verify actual file-tool execution and its OpenCode tool result:

```sh
npm run smoke -- --tools
```

This asks Claude to create one scratch file, approves only an exact matching write if an approval is requested, checks the file and displayed tool result, then removes the temporary project. This check also passed locally with the real Claude adapter and CLI.

Run `npm run smoke -- --attachments` to verify real image understanding, attached text, and repository reads together. It generates a randomly colored image and random text tokens, asks Claude to identify/read them, checks the answer and native tool result, then removes the scratch project. This check passed locally with the real Claude adapter and CLI.

Source layout:

- `src/index.ts`: provider registration and OpenCode hooks.
- `src/provider.ts`: native model transport and cancellation handling.
- `src/acp.ts`: subprocess lifecycle and ACP session/model negotiation.
- `src/bridge.ts`: conversation cursor, event translation, and approval continuation.
- `src/attachments.ts`: text/image conversion, shared by new prompts and historical context.
- `test/`: real-host and shared HTTP-client integration tests.

References: [OpenCode V2 plugins](https://opencode.ai/v2/docs/build/plugins), [Zed external agents](https://zed.dev/docs/ai/external-agents), and [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp). The adapter is maintained separately and distributed under Apache-2.0.
