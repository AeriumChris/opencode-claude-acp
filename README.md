# Claude Code ACP for OpenCode

Use **Claude Code from OpenCode's model picker**, with model-specific effort selection, screenshots, repository access, and OpenCode plugin/MCP tools.

This plugin connects OpenCode to the Claude Code CLI through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/). It uses the Claude adapter used by Zed and runs on the **OpenCode server**, making the same provider available to the TUI, desktop app, and web clients connected to that server.

**Provider:** `claude-acp` · **Display name:** Claude Code (ACP) · **Default model:** `claude-acp/default`

**Compatibility:** built and tested with **OpenCode V2 2.0.15**, **Node.js 22+**, and the pinned Claude ACP adapter **0.81.1**. Live verification was performed on Windows with Node.js 24. This repository is private and installed from a local build; it is not published to npm.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install from a terminal](#install-from-a-terminal)
- [GUI setup prompt](#gui-setup-prompt)
- [Use it in the TUI, desktop, and web](#use-it-in-the-tui-desktop-and-web)
- [Screenshots and file attachments](#screenshots-and-file-attachments)
- [Repository files and AGENTS.md](#repository-files-and-agentsmd)
- [Plugin and MCP compatibility](#plugin-and-mcp-compatibility)
- [Permissions and cancellation](#permissions-and-cancellation)
- [Sessions and history](#sessions-and-history)
- [Usage, cost, and token limits](#usage-cost-and-token-limits)
- [Authentication and billing](#authentication-and-billing)
- [Configuration options](#configuration-options)
- [Update or remove](#update-or-remove)
- [Troubleshooting](#troubleshooting)
- [Current limitations](#current-limitations)
- [How it works](#how-it-works)
- [Development and verification](#development-and-verification)

## Features

| Feature | What you get |
| --- | --- |
| **Model selection** | A Claude Code (ACP) provider in OpenCode's model picker. Available model IDs and names come from Claude, rather than a hardcoded list. |
| **Effort selection** | Each model advertises its supported effort variants. Changes apply to the next new prompt; Default clears the explicit override. |
| **Shared clients** | The TUI, desktop app, and web use the server's provider catalog, conversation output, and approval forms. |
| **Streaming** | Text and available thought chunks stream into the conversation. Completed and failed native tool calls appear as `claude_code` results. |
| **Screenshots and files** | PNG, JPEG, GIF, and WebP images reach Claude as image data. OpenCode-resolved text/source attachments and directory listings are supported. |
| **Repository access** | Claude can read, search, edit, and run commands in the server-side project, subject to tool permissions and OS access. |
| **Repository guidance** | Claude is instructed to read root and applicable nested `AGENTS.md` files. Scoped guidance discovered by OpenCode's read tool reaches the same Claude turn. Native `CLAUDE.md` support remains available. |
| **OpenCode plugin tools** | Tools are exposed to Claude through a session-specific MCP relay and executed by OpenCode, including before/after tool hooks. |
| **Existing MCP connections** | Claude can use available OpenCode MCP tools, including Code Mode discovery/execution. Upstream authentication stays in OpenCode. |
| **Approvals and questions** | Compact ACP approval forms offer one-time approval, adapter-provided persistent choices, and **Allow all (session)**. Set `permissionMode: "allow"` for automatic ACP approval across sessions. Relayed tools retain OpenCode's own permissions and forms. |
| **Conversation continuity** | Follow-ups reuse the native Claude session. Saved sessions reload after idle shutdown; history bootstrap preserves prior text and images. |
| **DCP marker compatibility** | Generated message-ID suffixes are removed without removing literal markers, quotes, or whitespace from your original messages. |
| **Cancellation** | Stop interrupts the active ACP turn and relayed work. Automatic model retries are disabled to avoid replaying agent actions. |
| **Usage reporting** | Reported input, output, and cache tokens populate OpenCode's native counters. `/claude-usage` shows completed-turn totals, context occupancy/capacity, and the latest ACP cost reading without calling Claude. |
| **Context capacity** | The selected model's context limit updates when ACP reports it. Other models retain their own observed limits or the OpenCode fallback. |

Tool compatibility does not mean every OpenCode feature controls Claude's internal agent loop. See [plugin compatibility](#plugin-and-mcp-compatibility) and [current limitations](#current-limitations), especially for DCP, agent instructions, and plan mode.

## Requirements

- **OpenCode V2**, with version 2.0.15 being the tested host version. V1 is not supported by this implementation.
- **Node.js 22 or newer**, npm, and Git on the machine running the OpenCode server.
- GitHub access to **[AeriumChris/opencode-claude-acp](https://github.com/AeriumChris/opencode-claude-acp)** while the repository is private.
- A working Claude Code sign-in for the **same OS user that runs the server**.
- OpenCode's built-in **`question` tool enabled** for ACP approvals.

The adapter includes a Claude CLI, so a separate global `claude` installation is optional. OpenCode's Anthropic API-key provider and this ACP provider have separate authentication paths.

**Install on the server machine.** For a local desktop/TUI setup, that is normally your own computer. If the web or desktop app connects to another machine, the checkout, Node executable, Claude credentials, and project files must be available on that machine. No Vercel deployment or GitHub Pages hosting is required.

## Install from a terminal

Run these commands in a normal terminal or PowerShell window. The `/models` command shown later is entered inside the OpenCode TUI.

### 1. Check prerequisites

```sh
opencode --version
node --version
npm --version
git --version
```

### 2. Clone and build

Choose a permanent location; OpenCode will load the plugin from that checkout.

**Windows — PowerShell 7**

```powershell
New-Item -ItemType Directory -Force "$HOME/code" | Out-Null
Set-Location "$HOME/code"
git clone https://github.com/AeriumChris/opencode-claude-acp.git
Set-Location opencode-claude-acp
npm ci
npm run build
```

**macOS / Linux — Bash or Zsh**

```sh
mkdir -p "$HOME/code"
cd "$HOME/code"
git clone https://github.com/AeriumChris/opencode-claude-acp.git
cd opencode-claude-acp
npm ci
npm run build
```

Use your existing GitHub authentication for the clone. If the checkout already exists, follow [Update or remove](#update-or-remove) instead. Continue only after installation and compilation succeed.

### 3. Check Claude sign-in

From the plugin checkout:

```sh
node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli --version
node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli auth status
```

If you need to sign in, run this interactively and complete the login flow:

```sh
node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli auth login
```

This signs in to Claude Code. It does not require adding an Anthropic API key to OpenCode. See [Authentication and billing](#authentication-and-billing) before sending a model request.

### 4. Generate the plugin entry for your actual paths

Still inside the checkout, this read-only command prints the entry to add. It works in PowerShell 7, Bash, and Zsh, and handles spaces in paths:

```sh
node -e 'const {pathToFileURL}=require("node:url"); console.log(JSON.stringify({package:pathToFileURL(process.cwd()).href,options:{nodeExecutable:process.execPath}},null,2))'
```

The generated `package` points to the **repository directory**, and `nodeExecutable` is the absolute Node executable used to run the command. Use those generated values in the next step.

### 5. Merge it into OpenCode configuration

Find the active user's global config directory:

```sh
opencode debug paths config
```

For all projects, edit the existing `opencode.json` or `opencode.jsonc` in that directory. If neither exists, create `opencode.jsonc`. The usual directory is `~/.config/opencode`, or `$XDG_CONFIG_HOME/opencode` when configured.

For one project only, edit that project's `opencode.jsonc` instead. Preserve existing settings and append the generated entry to its `plugins` array **once**.

Example configuration — replace the paths with the values generated above:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    // Keep your existing plugin entries here.
    {
      "package": "file:///C:/Users/YOU/code/opencode-claude-acp",
      "options": {
        "nodeExecutable": "C:/Program Files/nodejs/node.exe"
      }
    }
  ]
}
```

On macOS/Linux, the directory URL might be `file:///home/you/code/opencode-claude-acp` or `file:///Users/you/code/opencode-claude-acp`. A `file:` URL needs an absolute path, not `~` or `$HOME`.

- Use **`plugins` in `opencode.json(c)`**, not the TUI-only `cli.json`.
- Point to the checkout directory, not `dist/index.js`. The root `server.js` entrypoint is needed by the tested local-directory loader.
- Keep `dist/` and `node_modules/` present. They are generated locally and are not committed.
- Use the local-build route above. `opencode plugin add` manages package/Git installs; it does not replace building this checkout and configuring its local path.

### 6. Restart and check discovery

Finish any active work, then run:

```sh
opencode service restart
opencode service status
opencode models
```

Run the model command from the project where you intend to use the plugin. Look for the `claude-acp` provider/model entries. Discovery is asynchronous: the default entry may appear before individual models and effort variants.

These checks do not send a chat prompt. For a remote server, perform the installation/restart on that server and reconnect your clients to it.

## GUI setup prompt

Paste the following into an **already working OpenCode conversation** in the desktop app or web UI. The assisting model needs filesystem and shell access on the OpenCode server. The prompt asks it to perform the setup and leave interactive sign-in to you.

```text
Install the Claude Code ACP plugin for my OpenCode V2 setup:
https://github.com/AeriumChris/opencode-claude-acp

Read the repository README and follow its current local-build installation instructions.
Install globally for this server user, preserving my existing configuration.

1. Identify the machine and OS user running the OpenCode server. Check OpenCode,
   Node.js, npm, and Git versions. If you only have access to a different machine,
   explain what must be done on the actual server before changing configuration.
2. Use my existing GitHub authentication. Clone the repository into a permanent
   directory under my home folder, or inspect an existing checkout and reuse it
   without overwriting local changes. If access is missing, tell me how to sign in;
   do not ask me to paste a token into chat.
3. Run npm ci and npm run build. Confirm server.js and dist/index.js exist.
4. Locate the global config using opencode debug paths config. Read the existing
   opencode.json or opencode.jsonc, preserve all unrelated settings and comments,
   and add this plugin only once to its plugins array. Use the checkout's absolute
   file URL as package and an absolute Node executable path as options.nodeExecutable.
   Configure it in opencode.json(c), not cli.json.
5. Check the bundled CLI with:
   node node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js --cli auth status
   If login is needed, give me the exact interactive auth login command to run
   from the checkout. Do not collect my credentials or change my billing settings.
6. Verify the config and build. If a service restart would interrupt this conversation,
   give me the restart command to run after your reply; otherwise restart and check
   service status. Inspect the model catalog for claude-acp in my target project.
7. Tell me the install/config paths and how to select Claude Code (ACP) and an
   advertised effort level in a new conversation. State clearly if login or restart
   is still pending.

Do not send live Claude prompts or run account-backed smoke tests during installation.
Do not add an API key, enable paid extra usage, or claim subscription-only billing
is guaranteed. Keep my existing default model unless I ask to change it.
```

After setup, complete any pending sign-in/restart, refresh the web page or reopen the desktop picker, and start a new conversation with **Claude Code (ACP)**.

## Use it in the TUI, desktop, and web

### TUI

Open your project:

```sh
opencode /path/to/your/project
```

Inside the TUI, enter:

```text
/models
```

Select **Claude Code (ACP)** and a discovered model. The `default` entry delegates model choice to Claude's default. Use the effort/variant control when the selected model offers variants.

For a one-shot CLI request, from your project directory:

```sh
opencode run --model claude-acp/default "Explain the structure of this repository"
```

To use a discovered model and effort, append `#variant`. For example, **only if `opus` and `high` appear in your catalog**:

```sh
opencode run --model "claude-acp/opus#high" "Review this function for correctness"
```

These `run` commands send actual Claude requests. Use an interactive client for work that needs approval forms.

### Desktop and web

1. Connect to the OpenCode server where the plugin is installed.
2. Open a project covered by its configuration.
3. Open the model picker and choose **Claude Code (ACP)**, then a model.
4. Choose an available effort level if desired.
5. Send a message, attach files, and answer any permission/question forms in the client.

If the provider is hidden, refresh the client and check **Manage models**. Explicit hidden-model preferences take precedence over the plugin's defaults.

### Effort behavior

- Effort levels are discovered **per model** from ACP's `thought_level` options. Do not assume every model supports `high`, `max`, or any effort selector.
- A model without advertised effort levels has no variants. Discovery may take a moment.
- A new selection is applied before the **next new prompt** and reapplied after reconnecting the native session.
- Clearing the variant to **Default** clears the explicit override and returns control to Claude's defaults/settings.
- An in-progress prompt, including one waiting for approval, retains the effort it started with.

### Optional default model

To use this provider by default for new work, merge this field into the appropriate OpenCode config:

```jsonc
{
  "model": "claude-acp/default"
}
```

Existing session selections take precedence. OpenCode V2's root model default does not retain an effort variant; choose effort in the session or a `run --model ...#variant` command.

## Screenshots and file attachments

In desktop/web, use **Attach file**, paste a screenshot, or drag and drop files onto the prompt. In the TUI, use `@` to attach project files. Multiple images can accompany one message.

For the CLI:

```sh
opencode run --model claude-acp/default --file screenshot.png "Explain what is wrong in this screenshot"
```

| Input | Handling |
| --- | --- |
| PNG, JPEG, GIF, WebP | Forwarded as image data, with filenames when available, when the agent advertises image support. |
| UTF-8 text/source files | OpenCode supplies decoded contents and the filename. SVG is handled as text. |
| Directories | OpenCode supplies an immediate listing; Claude can inspect files through tools. |
| Unsupported binary documents, audio, video | Not made readable by this bridge; provide supported images/text or use an appropriate extraction tool. |

OpenCode resolves attachments before the bridge receives them. With a remote server, upload/paste a local file: a `file:` URL refers to the **server's** filesystem. Programmatic clients can use `session.prompt` attachments such as:

```json
{
  "files": [
    { "uri": "data:image/png;base64,...", "name": "screen.png" }
  ]
}
```

Replace `...` with actual base64 and include the session/prompt fields required by the API. HTTP/HTTPS attachment URLs are not supported by OpenCode's attachment path. OpenCode's image processing and Claude's own size/context limits apply.

Warm follow-ups reuse Claude's native image context without retransmitting it. If a new native session is bootstrapped from OpenCode history, earlier images are included with historical text.

## Repository files and AGENTS.md

The session's project directory is Claude's working directory. Files are read on demand; the plugin does not put the entire repository or every OpenCode conversation into the prompt.

Claude can use OpenCode's relayed file/search/edit/shell tools and its native tools, subject to the respective permissions and OS access. Files and commands run on the **server machine**.

For repository instructions, use **`AGENTS.md`** with that casing on case-sensitive filesystems:

```text
my-project/
├── AGENTS.md             # Repository-wide guidance
└── src/
    ├── AGENTS.md         # Additional guidance scoped to src/
    └── app.ts
```

Claude is instructed to read the root guidance before repository work and check applicable nested files. When the OpenCode `read` tool discovers additional scoped guidance, the bridge includes it with the tool result in the **same active Claude turn**. It does not resend the user prompt to deliver those instructions.

Ask Claude to re-read the applicable files after you change them. This is model-followed guidance, not a filesystem enforcement mechanism. Native `CLAUDE.md` and Claude user/project/local settings continue to load through the Claude adapter.

OpenCode's global system instructions and custom agent system prompts are not automatically imported. Selecting OpenCode's plan agent does not activate Claude's native plan mode.

## Plugin and MCP compatibility

No separate MCP configuration is needed for the relay. The plugin exposes the session's final available OpenCode tool catalog through an authenticated, loopback-only MCP server named **`opencode`**.

Claude is instructed to prefer these tools for operations they support. A call pauses its ACP turn, runs through OpenCode's normal tool engine, and returns the final result to that original turn. Input validation, before/after hooks, tool-specific permission checks, and forms remain in OpenCode. Text, JSON, errors, inline images, and file links are supported.

| Integration | Compatibility |
| --- | --- |
| Plugin-provided tools | Available tools can be called through the relay. |
| `tool.execute.before` / `tool.execute.after` | Run on relayed host tools, including changes to inputs and results. |
| Existing OpenCode MCP tools | Callable through OpenCode's existing connections. Upstream OAuth credentials are not copied to Claude. |
| Code Mode | Claude can use the relayed `execute` tool and its `search` facility to discover/call available tools. |
| Skill and delegation tools | Callable when present in the session catalog. Returned content reaches Claude; this does not mirror OpenCode's agent system prompts. |
| UI and event plugins | Continue running in OpenCode; this bridge does not reproduce their UI inside Claude CLI. |
| RTK-style command rewriting | Applies when the installed integration hooks a **relayed OpenCode shell tool**. Claude's native Bash calls bypass those hooks. |
| DCP | Partial compatibility: generated message-ID suffixes are cleaned up and renumbering does not reset the native conversation. Pruning OpenCode's history does not prune Claude's separate native history. |
| Anthropic HTTP/body rewriting plugins | Do not intercept the model traffic made inside Claude CLI. |
| System-prompt, plan-mode, or compaction plugins | Do not automatically control Claude's native agent loop. |

Hidden or unavailable tools cannot be called through the relay. Each session has its own endpoint and bearer token. Catalog changes are applied on a subsequent user turn by reconnecting and resuming the native session. Parallel MCP calls are serviced through the host tool loop.

For an OpenCode MCP server that needs authentication, complete its sign-in in OpenCode first. Claude-native MCP configuration remains separate. The relay does not automatically enable tools that your host configuration disabled.

## Permissions and cancellation

There are two tool paths:

1. **Relayed OpenCode tools:** OpenCode executes the operation with its existing tool behavior, permission checks, and hooks.
2. **Native Claude tools:** Claude Code executes the operation with its own configuration and permissions. OpenCode tool hooks do not intercept it.

When the adapter asks for ACP permission, the plugin displays an OpenCode **question form** containing only the operation title, followed by the approval choices. For example:

```text
Claude Code requests permission: Write frontend\widgets\AeriumFriendsPanel.cpp
```

The title is limited to 160 characters and normalized to one line. Raw input, file bodies, edit payloads, extra path/command summaries, and follow-up question text are omitted.

- **Deny:** reject this operation.
- **Allow once:** approve this operation, when offered by the adapter.
- **Allow always:** use the adapter's persistent approval choice, when offered. Read its description for the exact scope (for example, edits in the session or commands matching a rule). Multiple adapter choices appear as **Allow always**, **Allow always (2)**, etc.
- **Allow all (session):** approve this and all subsequent ACP permission requests in this OpenCode session, including requests already queued and future turns. This choice is saved across connection/server restarts. It does not apply to other sessions; starting a new session or resetting the bridge by changing provider, directory, or prior history clears that scope.

Only an exact offered choice recorded by the host grants approval. Dismissal, interruption, or an unexpected custom answer does not approve it.

To automatically approve **all ACP permission requests across sessions**, add `permissionMode` to this plugin's existing options in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    {
      "package": "file:///C:/Working%20Projects/opencode-claude-acp",
      "options": {
        "permissionMode": "allow"
      }
    }
  ]
}
```

Preserve any other plugin options and entries, then restart the OpenCode service. The default is `"ask"`. To restore prompting, change it back to `"ask"` and start a new session if you previously selected **Allow all (session)**.

These settings cover ACP approvals. Relayed OpenCode tools still use OpenCode's own permission rules. To also allow those tools by default, add `{ "action": "*", "resource": "*", "effect": "allow" }` to the top-level `permissions` array; later agent rules and policies can still restrict them. Ordinary questions asking for information or decisions still require an answer.

Keep the built-in `question` tool enabled. The tested OpenCode plugin API cannot directly create native permission requests, so the bridge uses this shared question UI. A relayed call can require both an ACP approval and the host tool's own permission/form. Operations already permitted by Claude's native settings may not ask an ACP question.

Use **Stop** to interrupt a turn. Cancellation closes pending relay work and interrupts Claude; individual tool implementations must cooperate with cancellation to stop their underlying operation. Completed side effects are not rolled back.

## Sessions and history

- Each OpenCode session has its own ACP connection and native Claude session identity.
- Follow-up messages reuse the native conversation. Completed inactive connections close after five minutes by default and reload saved sessions on demand.
- The plugin stores session IDs and user-message fingerprints in OpenCode plugin storage; Claude retains its own native history.
- Switching from another provider or changing prior history can bootstrap a new Claude session from existing text and images, supplied as historical context.
- Native session-load errors surface rather than silently replaying already-submitted prompts. Automatic model retries are disabled to avoid repeated agent actions.
- Titles are derived from user text without an extra Claude generation call.
- Generated DCP suffixes are distinguished from literal text using OpenCode's persisted original messages. Your own markers, quotes, and whitespace are preserved.

## Usage, cost, and token limits

With a **Claude ACP model selected**, enter this slash command in the TUI, desktop app, or web conversation:

```text
/claude-usage
```

The plugin renders a local report in that conversation. **The command does not send a prompt to Claude or consume Claude tokens.** If work is running, the report is queued. Reports are excluded from subsequent Claude prompts and history bootstrap.

The report includes:

- **Last completed turn and observed totals:** uncached input, cache reads, cache writes, output, and total tokens. A separate thinking count appears only when supplied; output already includes thinking.
- **Reporting coverage:** how many completed turns supplied token totals. Missing values display as **Not reported**, rather than invented zeros.
- **Context occupancy and capacity:** the latest reported tokens used, window size, percentage, and timestamp. Context occupancy is distinct from cumulative billed tokens.
- **ACP-reported cost:** the latest amount, currency, and timestamp for the native Claude session. Repeated cumulative updates replace the previous reading; they are not added together.

Reports are saved in OpenCode's plugin storage for the session and survive plugin restarts. Accounting begins when this feature observes a turn; it does not reconstruct earlier usage. Interrupted turns may lack final token totals. The pinned Claude adapter's prompt response covers its main agent loop and may exclude subagents or internal calls included in other accounting figures.

Reported tokens also populate OpenCode's ordinary assistant/session token counters. One Claude turn can span several OpenCode tool or permission steps; its token totals are recorded only on the final step, preventing double-counting.

### Cost is not a billing-pool measurement

ACP's cost figure is an adapter-reported value. It does **not** tell the plugin whether your subscription allowance, extra usage, or another billing arrangement was charged. The report retains the latest native-session reading rather than inventing an all-history cost across session replacements.

OpenCode 2.0.15 calculates its standard dollar counter from model price tables and does not expose a provider-reported cost override through this plugin API. This plugin does not invent token prices to force that counter to match ACP. **Use `/claude-usage` for the reported cost; a zero in OpenCode's dollar counter is not evidence that usage was free.** See [Authentication and billing](#authentication-and-billing).

### Model limits

ACP `usage_update.size` updates the **selected model's context limit** in the shared provider catalog. This becomes available after an ordinary turn reports usage, rather than during initial model discovery. The adapter may initially estimate the window and later refine it; the report identifies the value as ACP-supplied, not independently measured.

Until a model reports its capacity, the catalog retains OpenCode's default context limit. The pinned adapter does **not** expose an output-token limit in these reports, so that limit remains OpenCode's fallback. Learning one model's limit does not assign it to every Claude model. Catalog observations are relearned after a plugin restart; stored usage reports retain their last readings.

## Authentication and billing

Claude authentication is handled by the **Claude CLI running as the server user**. Signing into an Anthropic API provider in OpenCode is not the same thing. An existing CLI can be selected with `CLAUDE_CODE_EXECUTABLE`; otherwise the bundled CLI is used.

**This plugin does not select, measure, or guarantee a subscription-only billing pool.** Billing depends on Anthropic's current policy, the authenticated account, and Claude's configuration. Successful functional tests do not prove which allowance was charged. Review the current [Anthropic plan/SDK guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and your account's usage settings.

During development, a combined experiment forwarding OpenCode's full agent instructions and mapping plan mode returned a third-party extra-usage error. That feature was dropped rather than worked around. Ordinary root/nested `AGENTS.md` reads subsequently passed a live test without that error. The failed experiment does not establish that all ACP usage requires extra usage.

If you require plan-only usage and see an extra-usage error, stop the request and check the account/policy. The plugin does not enable extra usage or switch you to an API key to resolve it.

## Configuration options

All options are optional and belong inside the configured plugin entry's `options` object.

| Option | Default | Purpose |
| --- | --- | --- |
| `nodeExecutable` | `node` | Node executable that launches the bundled adapter. An absolute path is useful for GUI/background services with a different `PATH`. |
| `command` | Bundled adapter launched through Node | Override the **ACP executable**, not the Claude executable. No shell expansion is performed. |
| `args` | `[]` with a custom command | Argument array. Requires an explicit `command`. |
| `env` | Inherited server environment | Additional/overridden subprocess environment variables. |
| `startupTimeoutMs` | `30000` | Initialization and session creation/load deadline, in milliseconds. |
| `idleTimeoutMs` | `300000` | Close completed inactive connections after this many milliseconds. |
| `permissionMode` | `"ask"` | `"allow"` automatically approves ACP permission requests; OpenCode tool permissions still apply. |

Timeouts must be positive 32-bit integers. Unknown option names are rejected.

To use an existing Claude executable, set `CLAUDE_CODE_EXECUTABLE` in the server environment or in `options.env`. Example plugin entry:

```jsonc
{
  "package": "file:///home/you/code/opencode-claude-acp",
  "options": {
    "nodeExecutable": "/usr/bin/node",
    "env": {
      "CLAUDE_CODE_EXECUTABLE": "/home/you/.local/bin/claude"
    },
    "startupTimeoutMs": 60000,
    "idleTimeoutMs": 300000
  }
}
```

Replace every path with a real server-side executable/directory. `CLAUDE_CODE_EXECUTABLE` is an executable path, not a shell command. Do not set `command` to bare `claude`: the bridge expects an ACP-speaking process, and the adapter is still needed around the CLI.

## Update or remove

### Update

From the plugin checkout, inspect local changes first:

```sh
git status --short
git pull --ff-only
npm ci
npm run build
```

If you have local edits, preserve/reconcile them before updating. Once the build succeeds and active work has finished:

```sh
opencode service restart
opencode service status
```

Refresh connected clients and start a new Claude ACP conversation to get newly added startup guidance. Local source checkouts are updated with Git and rebuilt; `opencode plugin update` is not a substitute for these steps.

### Remove

Remove only this plugin's entry from the relevant `plugins` array, then restart the service. If you made `claude-acp/default` your configured default model, choose another provider. The checkout can then be removed if you no longer need it. Removing the plugin does not log out Claude or erase its native conversation history.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Provider missing everywhere | Verify the plugin is in server-side `opencode.json(c)`, the directory URL is correct, the build exists, and the server restarted. Inspect `opencode api get /api/plugin` and `opencode models` from the affected project. |
| Present in API/TUI, missing in desktop/web | Refresh the client, confirm it connects to the same server/project, and enable it in **Manage models** if explicitly hidden. |
| Only the default model is shown | Give discovery time. Check bundled CLI sign-in and executable paths. Discovery failures leave the default entry; a submitted prompt will surface startup/auth errors. |
| No effort picker | The selected model may not advertise effort, or discovery is still running. Use only variants returned by the current catalog. |
| Node/adapter fails to start | Use an absolute `nodeExecutable`, ensure Node 22+, and rerun `npm ci`/build. A terminal's `PATH` can differ from the background service's. |
| Login works in a terminal but not in OpenCode | Confirm the server runs as the same OS user and uses the intended Claude executable/environment. |
| Plugin/MCP tool missing | Check the session's available tools and upstream MCP connection/sign-in in OpenCode. Catalog changes apply on a subsequent user turn; try a new session after configuration changes. |
| RTK does not affect a command | Check whether Claude used a native tool or a relayed OpenCode shell tool. Only the latter passes through the OpenCode RTK hook. |
| Approval fails or no form appears | Keep `question` enabled. A host deny rule can reject a relayed tool, and Claude settings can already allow a native action. |
| Huge approval text hides the buttons | Update and rebuild the checkout referenced by the plugin's `package` path in `opencode.json(c)`, then restart the service and retry the operation. Updating a different clone does not update the installed plugin. Current prompts contain only a bounded operation title; existing forms retain their original text. |
| Repeated ACP approval questions | Choose **Allow always** for an adapter-provided rule, **Allow all (session)** for the current session, or set `options.permissionMode` to `"allow"` across sessions. See [Permissions and cancellation](#permissions-and-cancellation). |
| Still prompted after enabling automatic ACP approval | Check whether the prompt is an OpenCode tool permission or an ordinary question. These have separate behavior from ACP approvals. |
| Plan agent still permits native edits | OpenCode plan mode is not mapped to Claude. Its host permissions do not govern Claude-native tools. |
| Context/compaction error | OpenCode-side compaction is unsupported. Start a new OpenCode session and supply the relevant context. |
| An attachment is missing | Use supported image/text formats. Upload local files for a remote server; a server cannot resolve a path on your laptop. |
| Extra-usage error | See [Authentication and billing](#authentication-and-billing). There is no plugin switch that forces plan-only billing. |

Useful non-generating diagnostics:

```sh
opencode service status
opencode api get /api/info
opencode api get /api/plugin
opencode api get /api/provider
opencode api get /api/model
opencode debug paths log
```

Run them from the affected project; catalog/configuration is location-scoped. For an explicitly remote server, use that server's connection context rather than checking an unrelated local service. Do not include credentials or private prompt/file contents when sharing logs.

## Current limitations

- **OpenCode agent system prompts and native plan-mode mapping are not implemented.** Repository `AGENTS.md` reads are the supported narrower guidance path.
- **OpenCode-side compaction and auxiliary generation fail explicitly.** Claude manages its own context; the host can still reach its separate context limit.
- **Usage depends on ACP reporting.** Missing/interrupted-turn totals and historical usage cannot be reconstructed. ACP cost is shown by `/claude-usage`, separately from OpenCode's price-table dollar counter. Context capacity updates when reported; output-token limits remain OpenCode defaults. See [Usage, cost, and token limits](#usage-cost-and-token-limits).
- **Not every plugin applies.** Host HTTP/system/compaction hooks do not control Claude's internal requests/history. Native Claude tools bypass host tool hooks.
- Native mode selectors, slash-command discovery, in-progress native tool rendering, and native edit-review UI are not implemented.
- Unsupported binary documents and direct remote media references are not converted into model-readable content.
- The implementation targets the pinned Claude adapter's configuration-options API, not every ACP agent or arbitrary OpenCode version.
- Desktop/web **shared-server API behavior is integration-tested**. Automated visual browser verification remains outstanding; the user has confirmed model selection works in the installed clients.

## How it works

The external-agent approach is inspired by Zed:

```text
OpenCode TUI / desktop / web
             |
             | Shared server model catalog and session API
             v
OpenCode plugin + native provider transport
             |
             | ACP over subprocess stdin/stdout
             v
@agentclientprotocol/claude-agent-acp
             |
             | Claude Agent SDK
             v
        Claude Code CLI
             |
             | Session-scoped opencode MCP relay
             v
OpenCode tool engine -> plugin tools / connected MCP tools
```

Claude owns its agent loop and native settings. The adapter exposes its model/effort configuration, streamed output, tool activity, and permission requests over ACP. The plugin translates those into OpenCode's server catalog and session events.

The MCP relay keeps tool execution inside OpenCode instead of calling plugin implementations directly. This preserves host hooks and final results while allowing Claude to continue its original prompt. The relay listens only on loopback and uses a separate bearer token per session.

Desktop/web's default visibility filter favors recent entries and groups models by family. ACP supplies rolling choices rather than release dates, so the plugin dates catalog entries at registration and assigns a distinct family per choice. That timestamp is **not the Claude model's launch date**.

## Development and verification

### Build and deterministic integration tests

```sh
npm ci
npm run check
npm run build
npm test
```

The tests use a protocol fixture through the **real OpenCode host and HTTP server**. They do not send requests to a Claude account.

| Test | Coverage |
| --- | --- |
| [`test/host.test.mjs`](test/host.test.mjs) | Model discovery/visibility metadata, model-specific effort, switching/default reset, streaming, continuity, approval/denial/dismissal, cancellation, native reload/isolation, and DCP marker handling. |
| [`test/permissions.test.mjs`](test/permissions.test.mjs) | Bounded approval summaries, omitted file bodies, adapter-specific persistent choice IDs, rejection of unoffered choices, queued/session-wide approvals, reconnect persistence, session isolation, and automatic approval configuration. |
| [`test/http.test.mjs`](test/http.test.mjs) | Loading the configured local plugin directory; shared model/session/approval APIs across two clients; image/text attachment transport and history; native token accounting across approvals, learned context limits, and local usage reports without Claude requests. |
| [`test/usage.test.mjs`](test/usage.test.mjs) | Cache/input mapping, unknown and zero values, repeated cumulative cost readings, persisted totals across reconnects, model changes, and session isolation. |
| [`test/tools.test.mjs`](test/tools.test.mjs) | Before/after hooks, parallel calls, upstream MCP, Code Mode, errors, hidden tools, native host permission denial, forms, cancellation, image results, catalog refresh, and relay authentication/isolation. |
| [`test/instructions.test.mjs`](test/instructions.test.mjs) | Root/nested `AGENTS.md` reads and same-turn scoped guidance, follow-up continuity, and exclusion of unrelated host system instructions. |

The repository includes a [GitHub Actions workflow](.github/workflows/ci.yml) for Windows and Ubuntu with Node.js 24.

### Optional live Claude checks

These commands **send real requests using the authenticated Claude account**. They are not required for installation and do not verify the billing pool. Run only the check you need:

| Command | What it verifies |
| --- | --- |
| `npm run smoke` | A basic real-adapter/CLI reply containing `ACP_READY`. |
| `npm run smoke -- --effort=high` | A request with an advertised effort variant on the default model. |
| `npm run smoke -- --tools` | A scratch-file write and the displayed tool result. |
| `npm run smoke -- --attachments` | Actual image understanding, attached text, and a repository read using random verification values. |
| `npm run smoke -- --plugins` | A real Claude call to an OpenCode plugin, its modified after-hook result, and an existing MCP connection. |
| `node scripts/smoke-agents.mjs` | Root/nested `AGENTS.md` guidance using values known only from those files. |

These checks have passed locally with the bundled adapter/CLI. They use temporary projects and clean up afterward; set `OPENCODE_TEST_TMP` to choose the parent directory. The full-system/plan experiment described under billing was excluded from the shipped feature set.

### Source map

| File | Responsibility |
| --- | --- |
| [`server.js`](server.js) | Local-directory plugin loader entrypoint. |
| [`src/index.ts`](src/index.ts) | Provider registration, model/effort metadata, and OpenCode hooks. |
| [`src/provider.ts`](src/provider.ts) | Native model transport and stream cancellation. |
| [`src/acp.ts`](src/acp.ts) | Subprocess lifecycle, protocol connection, and session/model/effort negotiation. |
| [`src/bridge.ts`](src/bridge.ts) | History tracking, event translation, tool/approval continuation, and scoped guidance. |
| [`src/tool-relay.ts`](src/tool-relay.ts) | Session-scoped MCP server and host-result conversion. |
| [`src/attachments.ts`](src/attachments.ts) | Text/image conversion for new prompts and history. |
| [`src/prompt.ts`](src/prompt.ts) | Removal of verified generated message-ID suffixes. |
| [`src/usage.ts`](src/usage.ts) | Usage validation, native token mapping, persisted observations, and local reports. |
| [`src/options.ts`](src/options.ts) | Plugin option validation and adapter command selection. |
| [`src/queue.ts`](src/queue.ts), [`src/registry.ts`](src/registry.ts) | Event queue and per-plugin bridge lookup. |

### References and acknowledgements

- [OpenCode V2 configuration](https://opencode.ai/v2/docs/config), [plugins](https://opencode.ai/v2/docs/plugins), [plugin API](https://opencode.ai/v2/docs/build/plugins), and [models](https://opencode.ai/v2/docs/models)
- [OpenCode V2 attachments](https://opencode.ai/v2/docs/attachments) and [troubleshooting](https://opencode.ai/v2/docs/troubleshooting)
- [Zed external agents](https://zed.dev/docs/ai/external-agents)
- [Claude ACP adapter](https://github.com/agentclientprotocol/claude-agent-acp), maintained separately and distributed under Apache-2.0
- [Anthropic SDK/plan guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [Zed's subscription-policy updates](https://zed.dev/blog/anthropic-subscription-changes)
