# OpenCode Claude Code Plugin — ACP Integration

**Built on Anthropic's official Claude Agent SDK.** Anthropic's [current guidance explicitly permits SDK and third-party app usage with Claude plans](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). This plugin is independent, not Anthropic-endorsed; account eligibility and policies still apply, so no “ban-free” guarantee is possible.

Use **Claude Code in OpenCode's terminal, desktop app, and web UI** with your Claude Code sign-in. `opencode-claude-acp` connects through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/)—no Anthropic API key needs to be added to OpenCode.

## Features

- **Claude model picker:** discovers available Opus, Sonnet, Haiku, Fable, and older models, with per-model effort levels.
- **Streaming and attachments:** text, available thought output, tool activity, screenshots, and source files.
- **OpenCode tools and MCP:** reuses your connected tools, permissions, and plugin hooks through a local relay.
- **Session continuity:** follow-ups, saved-session reloads, cancellation, and checkpoint recovery.
- **Usage reports:** `/claude-usage` shows reported tokens, context, and cost without sending a Claude request.

## Install

Requires **OpenCode V2**, **Node.js 22+**, npm, and Git. Tested with OpenCode **2.0.27** and Claude ACP adapter **0.89.1**. Install on the machine running the OpenCode server, as the same OS user. The plugin is built locally, not published to npm.

### 1. Clone, build, and sign in

Run in a terminal or PowerShell 7, choosing a permanent checkout location:

```sh
git clone https://github.com/AeriumChris/opencode-claude-acp.git
cd opencode-claude-acp
npm ci
npm run build
node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli auth status
```

If login is needed:

```sh
node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli auth login
```

### 2. Add the plugin to OpenCode

From the checkout, generate an entry with your actual directory and Node paths:

```sh
node -e 'const {pathToFileURL}=require("node:url"); console.log(JSON.stringify({package:pathToFileURL(process.cwd()).href,options:{nodeExecutable:process.execPath}},null,2))'
```

Append that object to the `plugins` array in `~/.config/opencode/opencode.json(c)`, preserving existing settings. Use `opencode debug paths config` to find a custom config location. Example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "file:///YOUR/ABSOLUTE/PATH/opencode-claude-acp",
      "options": {
        "nodeExecutable": "/YOUR/ABSOLUTE/PATH/TO/node"
      }
    }
  ]
}
```

Use the generated values, especially on Windows. Point to the **checkout directory**, not `dist/index.js`; configure `opencode.json(c)`, not `cli.json`.

### 3. Restart and select Claude

After active work finishes:

```sh
opencode service restart
opencode models
```

Open `/models` in the TUI or the desktop/web model picker, then choose **Claude Code (ACP)** and a model. Discovery may take a moment. Select an advertised effort level if desired.

For assisted setup, use the [copy-paste setup prompt](GUIDE.md#gui-setup-prompt).

## Integration modes and billing

| Mode | Behavior |
| --- | --- |
| **`native` — default** | Preserves Claude Code's instructions and native tools alongside OpenCode's tool relay. Native tools use Claude permissions; relayed tools use OpenCode permissions and hooks. |
| **`opencode` — opt-in** | Uses Build, Plan, Orchestrator, or custom-agent instructions and host-only tools. Enable with `options.integrationMode: "opencode"`. |

**Keep native mode for the confirmed working setup.** OpenCode mode triggered a third-party extra-usage error in a user session; restoring native mode resolved it. Subscription billing compatibility for OpenCode mode is unverified. The plugin cannot determine or guarantee which billing pool is charged. [Billing details](GUIDE.md#authentication-and-billing).

Keep OpenCode's `question` tool enabled for native-mode approvals. `options.permissionMode: "allow"` automatically approves ACP requests; relayed tools still follow OpenCode's permissions.

## Update and troubleshoot

From the configured checkout, preserve any local edits, then:

```sh
git pull --ff-only
npm ci
npm run build
opencode service restart
```

Restart after active work finishes, then refresh connected clients.

- **Provider missing:** check the configured path, build, server, and **Manage models** visibility.
- **Missing newer models:** update the plugin and Claude Code, then restart. Models come from your runtime and account; the plugin selects a newer installed CLI when available.
- **Login or startup fails:** use the server's OS user and an absolute `nodeExecutable` path.
- **Extra-usage error:** restore `integrationMode: "native"`; if it persists, check Anthropic's current guidance and contact support.

## Reference and development

[Full guide](GUIDE.md) · [All options](GUIDE.md#configuration-options) · [Troubleshooting](GUIDE.md#troubleshooting) · [Limitations](GUIDE.md#current-limitations) · [Example config](opencode.example.json)

Claude still owns its internal model requests and history; this is not a drop-in replacement for every direct Anthropic API feature. See the guide for MCP compatibility, attachments, compaction, and background-task behavior.

```sh
npm run check
npm run build
npm test
```

Tests use a protocol fixture with the real OpenCode host and HTTP server; they do not call your Claude account.
