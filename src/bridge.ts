import { createHash, randomUUID } from 'node:crypto';
import type { ContentBlock, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import { LLMEvent, type LLMRequest, type Message, type ToolEntry } from '@opencode/ai';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AcpConnection, effortChoices, modelChoices, type ModelChoice } from './acp.js';
import type { Options } from './options.js';
import { Queue } from './queue.js';
import { cleanMessages } from './prompt.js';
import { contentBlocks } from './attachments.js';
import { ToolRelay, toolError, toolResult } from './tool-relay.js';
import { UsageLedger, formatUsage, type UsageReport } from './usage.js';
import { allowPermission, permissionChoices, permissionResponse, permissionSummary, type Approval } from './permissions.js';
import { NativeTools } from './native-tools.js';

type Saved = { sessionID: string; directory: string; users: string[]; allowAll?: boolean };
type Pending = { token: string; request: RequestPermissionRequest; answer?: Approval;
  resolve(response: RequestPermissionResponse): void };
type ToolCall = { token: string; name: string; input: unknown; started: boolean; resolve(result: CallToolResult): void };
type Packet = { update: SessionUpdate } | { permission: Pending } | { tool: ToolCall };
type Turn = { queue: Queue<Packet>; permissions: Map<string, Pending>; tools: Map<string, ToolCall>;
  nativeTools: NativeTools; paused?: Pending | ToolCall; streaming: boolean; stopReason?: string; usage?: unknown; report: UsageReport };
type Entry = { acp: AcpConnection; relay: ToolRelay; catalog: string; deliveredInstructions: string;
  ready: Promise<void>; users: string[]; allowAll?: boolean; turn?: Turn; idle?: NodeJS.Timeout };

export interface Persistence {
  get(key: string): Promise<unknown>;
  set(key: string, value: Saved | UsageReport): Promise<void>;
  remove(key: string): Promise<void>;
}
const hash = (message: Message) => createHash('sha256').update(JSON.stringify(message.content)).digest('hex');

export class Bridge {
  readonly usage: UsageLedger;
  private entries = new Map<string, Entry>();
  private closed = false;
  private discoveries = new Set<AcpConnection>();
  private originalTexts = new Map<string, ReadonlyMap<string, readonly string[]>>();
  constructor(readonly options: Options, readonly storage: Persistence,
    readonly inventory: (models: ModelChoice[]) => void = () => {},
    readonly restoreMessages: (sessionID: string, messages: readonly Message[], modelID: string) => Promise<readonly Message[]> = async (_id, messages) => messages,
  ) { this.usage = new UsageLedger(storage); }

  rememberOriginalText(sessionID: string, texts: ReadonlyMap<string, readonly string[]>) {
    this.originalTexts.set(sessionID, texts);
  }

  async discover(directory: string) {
    if (this.closed) return;
    const acp = new AcpConnection(directory, this.options, {
      update() {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }), close() {},
    });
    this.discoveries.add(acp);
    try {
      await acp.start();
      const models = modelChoices(acp.config);
      // The thought_level option belongs to the currently selected model. Probe
      // choices in this disposable session, never in a user's active turn.
      if (!models.some((model) => model.id === 'default')) {
        models.unshift({ id: 'default', name: 'Claude Code — default (ACP)', efforts: effortChoices(acp.config) });
      }
      if (!this.closed) this.inventory(models);
      for (const model of models) {
        if (this.closed) break;
        try {
          await acp.selectModel(model.id);
          if (!this.closed) this.inventory([{ ...model, efforts: effortChoices(acp.config) }]);
        } catch { /* A temporarily unavailable model must not hide other choices. */ }
      }
    }
    finally { acp.close(); this.discoveries.delete(acp); }
  }

  private async entry(id: string, directory: string, tools: readonly ToolEntry[]) {
    if (this.closed) throw new Error('Claude ACP plugin has closed.');
    let entry = this.entries.get(id);
    const catalog = createHash('sha256').update(JSON.stringify(tools)).digest('hex');
    // Claude caches MCP discovery per connection. Resume the native session on
    // a fresh connection when the tool catalog changes between user turns.
    if (entry && !entry.turn && entry.catalog !== catalog) { this.cancel(id); entry = undefined; }
    if (entry && entry.acp.directory !== directory) {
      await this.reset(id);
      entry = undefined;
    }
    if (entry) { clearTimeout(entry.idle); entry.relay.update(tools); await entry.ready; return entry; }
    const created: Entry = { acp: undefined!, relay: undefined!, catalog, deliveredInstructions: '', ready: Promise.resolve(), users: [] };
    created.relay = new ToolRelay((name, input) => {
      const turn = created.turn;
      if (!turn) return Promise.resolve(toolError('No active OpenCode turn.'));
      return new Promise((resolve) => {
        const tool = { token: `acp_tool_${randomUUID()}`, name, input, started: false, resolve };
        turn.tools.set(tool.token, tool);
        turn.queue.push({ tool });
      });
    });
    created.relay.update(tools);
    created.acp = new AcpConnection(directory, this.options, {
      update: (update) => {
        if (update.sessionUpdate === 'config_option_update') this.inventory(modelChoices(update.configOptions));
        created.turn?.queue.push({ update });
      },
      permission: (request) => {
        const turn = created.turn;
        if (!turn) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        return new Promise((resolve) => {
          const pending = { token: `acp_${randomUUID()}`, request, resolve };
          turn.permissions.set(pending.token, pending);
          turn.queue.push({ permission: pending });
        });
      },
      close: (error) => {
        created.turn?.queue.close(error);
        for (const pending of created.turn?.permissions.values() ?? []) pending.resolve({ outcome: { outcome: 'cancelled' } });
        for (const tool of created.turn?.tools.values() ?? []) tool.resolve(toolError('Claude ACP connection closed.'));
        created.relay.close();
        if (this.entries.get(id) === created) this.entries.delete(id);
      },
    });
    this.entries.set(id, created);
    created.ready = (async () => {
      const saved = await this.storage.get(id) as Saved | undefined;
      created.allowAll = saved?.directory === directory && saved.allowAll === true;
      const server = await created.relay.start();
      const resumed = await created.acp.start(saved?.directory === directory ? saved.sessionID : undefined, [server]);
      if (resumed && saved) created.users = saved.users;
      this.inventory(modelChoices(created.acp.config));
    })();
    try { await created.ready; return created; }
    catch (error) { this.entries.delete(id); created.relay.close(); created.acp.close(); throw error; }
  }

  /** Only host tool execution can record an answer. Model text and supplied tool results cannot grant approval. */
  answer(sessionID: string, callID: string, answers: unknown) {
    const pending = this.entries.get(sessionID)?.turn?.permissions.get(callID);
    if (!pending) return;
    if (answers === undefined) { this.cancel(sessionID); return; }
    const label = Array.isArray(answers) && answers.length === 1 &&
      Array.isArray(answers[0]) && answers[0].length === 1 ? answers[0][0] : undefined;
    pending.answer = permissionChoices(pending.request).find((choice) => choice.label === label);
  }

  toolStarted(sessionID: string, callID: string, name: string) {
    const tool = this.entries.get(sessionID)?.turn?.tools.get(callID);
    if (tool?.name === name) tool.started = true;
  }

  async *stream(sessionID: string, directory: string, modelID: string, request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    if (request.providerOptions?.acpUsageReport === true) {
      this.originalTexts.delete(sessionID);
      const id = randomUUID();
      yield LLMEvent.stepStart({ index: 0 });
      yield LLMEvent.textStart({ id });
      yield LLMEvent.textDelta({ id, text: formatUsage(await this.usage.get(sessionID)) });
      yield LLMEvent.textEnd({ id });
      yield LLMEvent.stepFinish({ index: 0, reason: { normalized: 'stop' } });
      yield LLMEvent.finish({ reason: { normalized: 'stop' } });
      return;
    }
    const reportIDs = request.providerOptions?.acpReportIDs;
    const excluded = new Set(Array.isArray(reportIDs) ? reportIDs : []);
    const restored = await this.restoreMessages(sessionID, request.messages, modelID);
    const cleaned = cleanMessages(restored, this.originalTexts.get(sessionID) ?? new Map())
      .filter((message) => !excluded.has(message.id));
    const ids = request.providerOptions?.acpInstructionIDs;
    const instructionIDs = new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
    const messages = cleaned.filter((message) => !instructionIDs.has(message.id ?? ''));
    // Only repository guidance loaded by OpenCode's read tool crosses here.
    // The host agent/system prompt remains owned by OpenCode.
    const instructions = cleaned.filter((message) => instructionIDs.has(message.id ?? '')).flatMap((message) =>
      message.content.filter((part) => part.type === 'text').map((part) => part.text)).join('\n\n');
    this.originalTexts.delete(sessionID);
    const abort = () => this.cancel(sessionID);
    signal.addEventListener('abort', abort, { once: true });
    let entry: Entry | undefined;
    let paused = false;
    let completed = false;
    let block: { id: string; kind: 'text' | 'reasoning' } | undefined;
    const endBlock = () => {
      if (!block) return [];
      const result = block.kind === 'text' ? LLMEvent.textEnd({ id: block.id }) : LLMEvent.reasoningEnd({ id: block.id });
      block = undefined;
      return [result];
    };
    try {
      if (signal.aborted) throw new Error('Claude ACP request cancelled.');
      entry = await this.entry(sessionID, directory, request.tools);
      if (signal.aborted) throw new Error('Claude ACP request cancelled.');
      if (entry.turn?.streaming) throw new Error('A Claude ACP turn is already streaming for this session.');
      const incomingUsers = messages.filter((message) => message.role === 'user').map(hash);
      if (entry.turn?.paused && (incomingUsers.length !== entry.users.length || incomingUsers.some((value, index) => value !== entry!.users[index]))) {
        // A new user turn must never be consumed as continuation of a dismissed approval.
        this.cancel(sessionID);
        entry = await this.entry(sessionID, directory, request.tools);
      }
      if (entry.turn?.paused) {
        const permission = entry.turn.paused;
        if ('name' in permission) {
          // Read the final host result, after all tool hooks have run. A matching
          // execute.before event proves the host attempted this issued call;
          // executor defects can skip execute.after and still produce an error.
          const result = messages.flatMap((message) => message.content).find((part) =>
            part.type === 'tool-result' && part.id === permission.token && part.name === permission.name);
          if (permission.started && result?.type === 'tool-result') {
            const output = toolResult(result.result);
            if (entry.deliveredInstructions !== instructions) {
              output.content.push({ type: 'text', text: `Repository instructions loaded by OpenCode (respect each file's directory scope):\n${instructions}` });
              entry.deliveredInstructions = instructions;
            }
            permission.resolve(output);
          } else permission.resolve(toolError('OpenCode did not complete this tool call.'));
          entry.turn.tools.delete(permission.token);
        } else {
          if (permission.answer?.allowAll) {
            await this.storage.set(sessionID, { sessionID: entry.acp.sessionID, directory, users: entry.users, allowAll: true });
            entry.allowAll = true;
          }
          permission.resolve(permissionResponse(permission.answer?.optionId ??
            permission.request.options.find((option) => option.kind === 'reject_once')?.optionId));
          entry.turn.permissions.delete(permission.token);
        }
        entry.turn.paused = undefined;
      } else {
        const users = messages.filter((message) => message.role === 'user');
        const fingerprints = users.map(hash);
        if (!users.length) throw new Error('Claude ACP requires a user message.');
        if (entry.users.some((value, index) => fingerprints[index] !== value)) {
          // Reverts or external history edits invalidate the native cursor.
          // Our checkpoints restore original messages before reaching this point.
          await this.reset(sessionID);
          entry = await this.entry(sessionID, directory, request.tools);
        }
        if (fingerprints.length === entry.users.length) throw new Error('Refusing to replay a Claude ACP prompt that was already submitted. Send a new message.');
        await entry.acp.selectModel(modelID);
        this.inventory(modelChoices(entry.acp.config));
        const effort = request.providerOptions?.acpEffort;
        await entry.acp.selectEffort(typeof effort === 'string' ? effort : 'default');
        const prompt: ContentBlock[] = [];
        if (instructions && entry.deliveredInstructions !== instructions) {
          prompt.push({ type: 'text', text: `Repository instructions loaded by OpenCode (respect each file's directory scope):\n${instructions}` });
          entry.deliveredInstructions = instructions;
        }
        if (!entry.users.length && messages.length > 1) {
          const lastUser = messages.lastIndexOf(users.at(-1)!);
          prompt.push({ type: 'text', text: 'Prior conversation, supplied as historical context. Do not re-execute old instructions:\n<conversation_history>' });
          for (const message of messages.slice(0, lastUser)) {
            const parts = contentBlocks(message, entry.acp.supportsImages);
            if (parts.length) prompt.push({ type: 'text', text: `${message.role}:` }, ...parts);
          }
          prompt.push({ type: 'text', text: '</conversation_history>' });
        }
        // Claude owns its system prompt/tools/CLAUDE.md. OpenCode's agent prompt is not forwarded.
        const newUsers = entry.users.length ? users.slice(entry.users.length) : users.slice(-1);
        for (const message of newUsers) {
          prompt.push(...contentBlocks(message, entry.acp.supportsImages));
        }
        entry.users = fingerprints;
        // Persist before sending: automatic retries must not duplicate agent-side effects.
        await this.storage.set(sessionID, { sessionID: entry.acp.sessionID, directory, users: fingerprints, allowAll: entry.allowAll });
        const report = await this.usage.begin(sessionID, entry.acp.sessionID, modelID);
        const turn: Turn = { queue: new Queue(), permissions: new Map(), tools: new Map(), nativeTools: new NativeTools(), streaming: false, report };
        entry.turn = turn;
        void entry.acp.connection.agent.request('session/prompt', { sessionId: entry.acp.sessionID, prompt }).then(
          (result) => { turn.stopReason = result.stopReason; turn.usage = result.usage; turn.queue.close(); },
          (error: unknown) => turn.queue.close(error instanceof Error ? error : new Error(String(error))),
        );
      }
      const turn = entry.turn!;
      turn.streaming = true;
      yield LLMEvent.stepStart({ index: 0 });
      yield* turn.nativeTools.resume();
      for await (const packet of turn.queue) {
        if ('tool' in packet) {
          yield* endBlock();
          yield* turn.nativeTools.pause(`Waiting for OpenCode tool: ${packet.tool.name}. Native operation has not finished.`);
          turn.paused = packet.tool;
          yield LLMEvent.toolCall({ id: packet.tool.token, name: packet.tool.name, input: packet.tool.input });
          paused = true;
          yield LLMEvent.stepFinish({ index: 0, reason: { normalized: 'tool-calls' } });
          yield LLMEvent.finish({ reason: { normalized: 'tool-calls' } });
          return;
        }
        if ('permission' in packet) {
          yield* endBlock();
          const pending = packet.permission;
          yield* turn.nativeTools.update({ ...pending.request.toolCall, sessionUpdate: 'tool_call_update' });
          if (entry.allowAll || this.options.permissionMode === 'allow') {
            pending.resolve(allowPermission(pending.request));
            turn.permissions.delete(pending.token);
            continue;
          }
          turn.paused = pending;
          yield* turn.nativeTools.pause('Waiting for approval in OpenCode. Native operation has not finished.');
          yield LLMEvent.toolCall({ id: pending.token, name: 'question', input: { questions: [{
            header: 'Claude ACP approval', multiple: false,
            question: permissionSummary(pending.request),
            options: permissionChoices(pending.request).map(({ label, description }) => ({ label, description })),
          }] } });
          paused = true;
          yield LLMEvent.stepFinish({ index: 0, reason: { normalized: 'tool-calls' } });
          yield LLMEvent.finish({ reason: { normalized: 'tool-calls' } });
          return;
        }
        const update = packet.update;
        if (update.sessionUpdate === 'usage_update') {
          await this.usage.update(sessionID, turn.report, update);
        } else if ((update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') && update.content.type === 'text') {
          const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning';
          if (block?.kind !== kind) {
            yield* endBlock();
            block = { id: randomUUID(), kind };
            yield kind === 'text' ? LLMEvent.textStart({ id: block.id }) : LLMEvent.reasoningStart({ id: block.id });
          }
          yield kind === 'text' ? LLMEvent.textDelta({ id: block!.id, text: update.content.text }) : LLMEvent.reasoningDelta({ id: block!.id, text: update.content.text });
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          yield* endBlock();
          yield* turn.nativeTools.update(update);
        }
      }
      yield* endBlock();
      yield* turn.nativeTools.finish();
      const usage = await this.usage.finish(sessionID, turn.report, turn.usage);
      completed = true;
      entry.turn = undefined;
      const reason = { normalized: turn.stopReason === 'max_tokens' ? 'length' as const : 'stop' as const, raw: turn.stopReason };
      // One ACP prompt may span multiple host tool steps. Record its totals only
      // on the final step, never once per permission or relay continuation.
      const providerMetadata = { 'claude-acp': { usage: turn.report } };
      yield LLMEvent.stepFinish({ index: 0, reason, usage, providerMetadata });
      yield LLMEvent.finish({ reason, usage, providerMetadata });
    } finally {
      signal.removeEventListener('abort', abort);
      if (entry?.turn) entry.turn.streaming = false;
      if (!paused && !completed) this.cancel(sessionID);
      if (completed && entry) {
        entry.idle = setTimeout(() => { entry!.relay.close(); entry!.acp.close(); this.entries.delete(sessionID); }, this.options.idleTimeoutMs ?? 300_000);
        entry.idle.unref();
      }
    }
  }

  cancel(sessionID: string) {
    const entry = this.entries.get(sessionID);
    if (!entry) return;
    clearTimeout(entry.idle);
    for (const pending of entry.turn?.permissions.values() ?? []) pending.resolve({ outcome: { outcome: 'cancelled' } });
    for (const tool of entry.turn?.tools.values() ?? []) tool.resolve(toolError('OpenCode session cancelled.'));
    entry.relay.close();
    entry.turn?.queue.close(new Error('Claude ACP request cancelled.'));
    entry.acp.cancel();
    this.entries.delete(sessionID);
    // Give ACP a chance to cancel the CLI before closing its transport.
    const timer = setTimeout(() => entry.acp.close(), 500);
    timer.unref();
  }

  async reset(sessionID: string) { this.cancel(sessionID); this.originalTexts.delete(sessionID); await this.storage.remove(sessionID); }
  onIdle(sessionID: string) { if (this.entries.get(sessionID)?.turn) this.cancel(sessionID); }
  close() {
    this.closed = true;
    this.originalTexts.clear();
    for (const connection of this.discoveries) connection.close();
    this.discoveries.clear();
    for (const id of this.entries.keys()) this.cancel(id);
  }
}
