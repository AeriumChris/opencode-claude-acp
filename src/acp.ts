import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type RequestPermissionRequest,
  type RequestPermissionResponse, type SessionConfigOption, type SessionUpdate } from '@agentclientprotocol/sdk';
import { command, type Options } from './options.js';

export interface ModelChoice { id: string; name: string }
export function modelChoices(config: SessionConfigOption[]): ModelChoice[] {
  const option = config.find((item) => item.category === 'model' && item.type === 'select');
  if (!option || option.type !== 'select') return [];
  return option.options.flatMap((item) => 'options' in item ? item.options : [item])
    .map((item) => ({ id: item.value, name: item.name }));
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

  async start(savedID?: string) {
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
      if (savedID && this.supportsLoad) {
        const result = await this.connection.agent.request('session/load', {
          sessionId: savedID, cwd: this.directory, mcpServers: [],
        });
        this.config = result.configOptions ?? [];
        this.rememberModel();
        this.sessionID = savedID;
        return true;
      }
      const result = await this.connection.agent.request('session/new', { cwd: this.directory, mcpServers: [] });
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
