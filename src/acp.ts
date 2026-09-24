import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type RequestPermissionRequest,
  type RequestPermissionResponse, type SessionConfigOption, type SessionUpdate, type McpServer } from '@agentclientprotocol/sdk';
import { command, type Options } from './options.js';

export interface Choice { id: string; name: string }
export interface ModelChoice extends Choice { efforts?: Choice[]; contextWindow?: number }
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
      ...(item.value === option.currentValue ? { efforts: effortChoices(config) } : {}) }));
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
    const [exe, args] = command(options);
    this.child = spawn(exe, args, { cwd: directory, env: { ...process.env, ...options.env },
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

  async start(savedID?: string, mcpServers: McpServer[] = []) {
    // The bundled Claude adapter accepts a native system-prompt append through
    // this ACP extension, preserving Claude's own preset and project guidance.
    const meta = mcpServers.length ? { _meta: { systemPrompt: { append: [
      'You are connected to OpenCode through ACP. The opencode MCP server exposes the tools available in this OpenCode session, including plugin and upstream MCP tools.',
      'Prefer these tools for supported operations so OpenCode tool hooks and permissions apply. Native Claude tools remain available.',
      'For the opencode execute tool, use search({query, namespace}) inside its code to discover exact tool paths and signatures; search is synchronous.',
      'Only call paths returned by search, and await tool calls. Do not guess tool paths.',
      'Before repository work, read the repository AGENTS.md if present. Before working in a subdirectory, also check for applicable AGENTS.md files along its path. Use the opencode read tool so it can return additional directory instructions.',
      'Follow AGENTS.md guidance within its directory scope; more specific directory guidance takes precedence. Re-read relevant guidance when asked or when it changes.',
    ].join('\n') } } } : {};
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
      throw new Error('Unable to start Claude ACP. Run the bundled Claude CLI login on the server, and check the configured executable.', { cause: error });
    } finally { clearTimeout(timeout); }
  }

  private rememberModel() {
    const option = this.config.find((item) => item.category === 'model' && item.type === 'select');
    if (option?.type === 'select') this.initialModel = option.currentValue;
  }

  async selectModel(id: string) {
    if (id === 'default' && !modelChoices(this.config).some((item) => item.id === 'default')) {
      if (!this.initialModel) return;
      id = this.initialModel;
    }
    const option = this.config.find((item) => item.category === 'model' && item.type === 'select');
    if (!option || option.type !== 'select' || !modelChoices(this.config).some((item) => item.id === id)) {
      throw new Error(`Claude ACP does not advertise model ${id} for this session.`);
    }
    if (option.currentValue === id) return;
    const result = await this.connection.agent.request('session/set_config_option', {
      sessionId: this.sessionID, configId: option.id, value: id,
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
