import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type RequestPermissionRequest,
  type RequestPermissionResponse, type SessionConfigOption, type SessionUpdate, type McpServer } from '@agentclientprotocol/sdk';
import { command, type Options } from './options.js';
import { isAuthRequired } from './auth-error.js';

export interface Choice { id: string; name: string }
export interface ModelChoice extends Choice { efforts?: Choice[]; fast?: boolean }
/** Claude ACP exposes Fast mode as a per-session toggle on supporting models. */
export const FAST_SUFFIX = '-fast';
const fastOption = (config: SessionConfigOption[]) => config.find((item) => item.id === 'fast');
export function supportsFast(config: SessionConfigOption[]) { return fastOption(config) !== undefined; }
export function effortChoices(config: SessionConfigOption[]): Choice[] {
  const option = config.find((item) => item.category === 'thought_level' && item.type === 'select');
  if (!option || option.type !== 'select') return [];
  return option.options.flatMap((item) => 'options' in item ? item.options : [item])
    .map((item) => ({ id: item.value, name: item.name }));
}
export function modelChoices(config: SessionConfigOption[]): ModelChoice[] {
  const option = config.find((item) => item.category === 'model' && item.type === 'select');
  if (!option || option.type !== 'select') return [];
  return option.options.flatMap((item) => 'options' in item ? item.options : [item])
    .map((item) => ({ id: item.value, name: item.name,
      ...(item.value === option.currentValue ? { efforts: effortChoices(config), fast: supportsFast(config) } : {}) }));
}

export class AcpConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: ClientConnection;
  sessionID = '';
  config: SessionConfigOption[] = [];
  supportsLoad = false;
  supportsImages = false;
  private initialModel?: string;
  private disposed = false;

  constructor(readonly directory: string, readonly options: Options, handlers: {
    update(update: SessionUpdate): void;
    permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
    close(error: Error): void;
  }) {
    const [exe, args, extraEnv] = command(options);
    // Native background completions can arrive after session/prompt returns,
    // outside OpenCode's tool loop. Keep Claude's tasks in the live ACP turn.
    this.child = spawn(exe, args, { cwd: directory, env: { ...process.env, ...extraEnv, ...options.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
      stdio: 'pipe', shell: false, windowsHide: true });
    // Drain stderr, but never echo prompts, credentials, or source code into host logs.
    this.child.stderr.resume();
    this.connection = client().onNotification('session/update', ({ params: { sessionId, update } }) => {
      if (sessionId !== this.sessionID) return; // Also suppress session/load replay.
      if (update.sessionUpdate === 'config_option_update') this.config = update.configOptions;
      handlers.update(update);
    }).onRequest('session/request_permission', ({ params: request }) => {
      if (request.sessionId !== this.sessionID) return { outcome: { outcome: 'cancelled' } };
      return handlers.permission(request);
    }).connect(ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>));
    this.child.on('error', (error) => { handlers.close(error); this.close(); });
    this.child.on('exit', (code, signal) => {
      if (!this.disposed) handlers.close(new Error(`Claude ACP exited (${signal ?? code}). Check Claude Code authentication on the OpenCode server.`));
      this.close();
    });
    void this.connection.closed.then(() => {
      if (!this.disposed) handlers.close(new Error('Claude ACP connection closed.'));
      this.close();
    });
  }

  async start(savedID?: string, mcpServers: McpServer[] = [], system?: string) {
    // Use the final host instructions in OpenCode mode. Native mode appends
    // integration guidance to Claude's own preset instead.
    const integration = [
      'You are connected to OpenCode through ACP. The opencode MCP server exposes the tools available in this OpenCode session, including plugin and upstream MCP tools.',
      system === undefined ? 'Prefer these tools for supported operations so OpenCode tool hooks and permissions apply. Native Claude tools remain available.'
        : 'Use only the opencode MCP tools for actions, questions, planning, and delegation. OpenCode owns tool permissions and execution. Tool names in the host instructions refer to these MCP tools.',
      'For the opencode execute tool, use search({query, namespace}) inside its code to discover exact tool paths and signatures; search is synchronous.',
      'Only call paths returned by search, and await tool calls. Do not guess tool paths.',
      'Keep dependent work in the active turn. Native background-task callbacks are not delivered after the ACP turn ends. Use foreground shell calls (background: false); do not detach CI watchers or promise to resume from a native background notification.',
      'When asked to monitor a build and then publish a release, poll its status with bounded foreground calls and pauses until it finishes, handle failures, then complete the requested release and verify its published status before ending the turn. A successful build alone does not complete a release task.',
      'Before repository work, read the repository AGENTS.md if present. Before working in a subdirectory, also check for applicable AGENTS.md files along its path. Use the opencode read tool so it can return additional directory instructions.',
      'Follow AGENTS.md guidance within its directory scope; more specific directory guidance takes precedence. Re-read relevant guidance when asked or when it changes.',
    ].join('\n');
    const meta = system !== undefined ? { _meta: {
      systemPrompt: [system, integration].filter(Boolean).join('\n\n'),
      claudeCode: { options: { tools: [], strictMcpConfig: true, allowedTools: ['mcp__opencode__*'] } },
    } } : mcpServers.length ? { _meta: { systemPrompt: { append: integration } } } : {};
    const timeout = setTimeout(() => this.close(), this.options.startupTimeoutMs ?? 30_000);
    timeout.unref();
    try {
      const initialized = await this.connection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'opencode-claude-acp', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      this.supportsLoad = initialized.agentCapabilities?.loadSession === true;
      this.supportsImages = initialized.agentCapabilities?.promptCapabilities?.image === true;
      if (mcpServers.length && !initialized.agentCapabilities?.mcpCapabilities?.http) {
        throw new Error('This ACP agent does not support the HTTP MCP tool relay.');
      }
      if (savedID && this.supportsLoad) {
        const result = await this.connection.agent.request('session/load', {
          sessionId: savedID, cwd: this.directory, mcpServers, ...meta,
        });
        this.config = result.configOptions ?? [];
        this.rememberModel();
        this.sessionID = savedID;
        return true;
      }
      const result = await this.connection.agent.request('session/new', { cwd: this.directory, mcpServers, ...meta });
      this.config = result.configOptions ?? [];
      this.rememberModel();
      this.sessionID = result.sessionId;
      return false;
    } catch (error) {
      this.close();
      if (isAuthRequired(error)) throw error;
      throw new Error('Unable to start Claude ACP. Check the configured executable and the adapter on the OpenCode server.', { cause: error });
    } finally { clearTimeout(timeout); }
  }

  private rememberModel() {
    const option = this.config.find((item) => item.category === 'model' && item.type === 'select');
    if (option?.type === 'select') this.initialModel = option.currentValue;
  }

  async selectModel(id: string) {
    const advertised = (value: string) => modelChoices(this.config).some((item) => item.id === value);
    // `<model>-fast` is the plugin's catalog entry for a model with Fast mode on.
    const fast = id.endsWith(FAST_SUFFIX) && !advertised(id) && advertised(id.slice(0, -FAST_SUFFIX.length));
    if (fast) id = id.slice(0, -FAST_SUFFIX.length);
    if (id === 'default' && !advertised('default')) {
      if (!this.initialModel) return;
      id = this.initialModel;
    }
    const option = this.config.find((item) => item.category === 'model' && item.type === 'select');
    if (!option || option.type !== 'select' || !advertised(id)) {
      throw new Error(`Claude ACP does not advertise model ${id} for this session.`);
    }
    if (option.currentValue !== id) {
      const result = await this.connection.agent.request('session/set_config_option', {
        sessionId: this.sessionID, configId: option.id, value: id,
      });
      this.config = result.configOptions;
    }
    await this.selectFast(fast);
  }

  /** Fast mode persists across native model switches, so always pin it explicitly. */
  private async selectFast(enabled: boolean) {
    const option = fastOption(this.config);
    if (!option) {
      if (enabled) throw new Error('Claude ACP does not advertise Fast mode for this model.');
      return;
    }
    if (option.type === 'boolean') {
      if (option.currentValue === enabled) return;
      const result = await this.connection.agent.request('session/set_config_option', {
        sessionId: this.sessionID, configId: option.id, type: 'boolean', value: enabled,
      });
      this.config = result.configOptions;
      return;
    }
    if (option.type !== 'select') return;
    const value = enabled ? 'on' : 'off';
    if (option.currentValue === value) return;
    const result = await this.connection.agent.request('session/set_config_option', {
      sessionId: this.sessionID, configId: option.id, value,
    });
    this.config = result.configOptions;
  }

  async selectEffort(value: string) {
    const option = this.config.find((item) => item.category === 'thought_level' && item.type === 'select');
    if (!option || option.type !== 'select') {
      if (value === 'default') return;
      throw new Error(`Claude ACP does not advertise effort ${value} for this model.`);
    }
    if (!effortChoices(this.config).some((item) => item.id === value)) {
      throw new Error(`Claude ACP does not advertise effort ${value} for this model.`);
    }
    if (option.currentValue === value) return;
    const result = await this.connection.agent.request('session/set_config_option', {
      sessionId: this.sessionID, configId: option.id, value,
    });
    this.config = result.configOptions;
  }

  cancel() {
    if (this.disposed || !this.sessionID) return;
    void this.connection.agent.notify('session/cancel', { sessionId: this.sessionID }).catch(() => {});
  }

  close() {
    if (this.disposed) return;
    this.disposed = true;
    this.connection.close();
    this.child.stdin.destroy();
    this.child.kill();
  }
}
