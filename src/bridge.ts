import { createHash, randomUUID } from 'node:crypto';
import type { ContentBlock, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import { LLMEvent, type LLMRequest, type Message } from '@opencode/ai';
import { AcpConnection, effortChoices, modelChoices, type ModelChoice } from './acp.js';
import type { Options } from './options.js';
import { Queue } from './queue.js';

type Saved = { sessionID: string; directory: string; users: string[] };
type Pending = { token: string; request: RequestPermissionRequest; answer?: boolean;
  resolve(response: RequestPermissionResponse): void };
type Packet = { update: SessionUpdate } | { permission: Pending };
type Turn = { queue: Queue<Packet>; permissions: Map<string, Pending>; paused?: Pending; streaming: boolean; stopReason?: string };
type Entry = { acp: AcpConnection; ready: Promise<void>; users: string[]; turn?: Turn; idle?: NodeJS.Timeout };

export interface Persistence {
  get(key: string): Promise<unknown>;
  set(key: string, value: Saved): Promise<void>;
  remove(key: string): Promise<void>;
}
const hash = (message: Message) => createHash('sha256').update(JSON.stringify(message.content)).digest('hex');
const text = (message: Message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');

export class Bridge {
  private entries = new Map<string, Entry>();
  private closed = false;
  private discoveries = new Set<AcpConnection>();
  constructor(readonly options: Options, readonly storage: Persistence,
    readonly inventory: (models: ModelChoice[]) => void = () => {}) {}

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

  private async entry(id: string, directory: string) {
    if (this.closed) throw new Error('Claude ACP plugin has closed.');
    let entry = this.entries.get(id);
    if (entry && entry.acp.directory !== directory) {
      await this.reset(id);
      entry = undefined;
    }
    if (entry) { clearTimeout(entry.idle); await entry.ready; return entry; }
    const created: Entry = { acp: undefined!, ready: Promise.resolve(), users: [] };
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
        if (this.entries.get(id) === created) this.entries.delete(id);
      },
    });
    this.entries.set(id, created);
    created.ready = (async () => {
      const saved = await this.storage.get(id) as Saved | undefined;
      const resumed = await created.acp.start(saved?.directory === directory ? saved.sessionID : undefined);
      if (resumed && saved) created.users = saved.users;
      this.inventory(modelChoices(created.acp.config));
    })();
    try { await created.ready; return created; }
    catch (error) { this.entries.delete(id); created.acp.close(); throw error; }
  }

  /** Only host tool execution can record an answer. Model text and supplied tool results cannot grant approval. */
  answer(sessionID: string, callID: string, answers: unknown) {
    const pending = this.entries.get(sessionID)?.turn?.permissions.get(callID);
    if (!pending) return;
    if (answers === undefined) { this.cancel(sessionID); return; }
    pending.answer = Array.isArray(answers) && answers.length === 1 &&
      Array.isArray(answers[0]) && answers[0].length === 1 && answers[0][0] === 'Allow once';
  }

  async *stream(sessionID: string, directory: string, modelID: string, request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
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
      entry = await this.entry(sessionID, directory);
      if (signal.aborted) throw new Error('Claude ACP request cancelled.');
      if (entry.turn?.streaming) throw new Error('A Claude ACP turn is already streaming for this session.');
      const incomingUsers = request.messages.filter((message) => message.role === 'user').map(hash);
      if (entry.turn?.paused && (incomingUsers.length !== entry.users.length || incomingUsers.some((value, index) => value !== entry!.users[index]))) {
        // A new user turn must never be consumed as continuation of a dismissed approval.
        this.cancel(sessionID);
        entry = await this.entry(sessionID, directory);
      }
      if (entry.turn?.paused) {
        const permission = entry.turn.paused;
        const choice = permission.request.options.find((option) => option.kind === (permission.answer === true ? 'allow_once' : 'reject_once'));
        permission.resolve(choice ? { outcome: { outcome: 'selected', optionId: choice.optionId } } : { outcome: { outcome: 'cancelled' } });
        entry.turn.permissions.delete(permission.token);
        entry.turn.paused = undefined;
      } else {
        const users = request.messages.filter((message) => message.role === 'user');
        const fingerprints = users.map(hash);
        if (!users.length) throw new Error('Claude ACP requires a user message.');
        if (entry.users.some((value, index) => fingerprints[index] !== value)) {
          // Reverts/compaction invalidate the native session's chronological cursor.
          await this.reset(sessionID);
          entry = await this.entry(sessionID, directory);
        }
        if (fingerprints.length === entry.users.length) throw new Error('Refusing to replay a Claude ACP prompt that was already submitted. Send a new message.');
        await entry.acp.selectModel(modelID);
        this.inventory(modelChoices(entry.acp.config));
        const effort = request.providerOptions?.acpEffort;
        await entry.acp.selectEffort(typeof effort === 'string' ? effort : 'default');
        const prompt: ContentBlock[] = [];
        if (!entry.users.length && request.messages.length > 1) {
          const lastUser = request.messages.lastIndexOf(users.at(-1)!);
          const history = request.messages.slice(0, lastUser).map((message) => `${message.role}: ${text(message)}`).join('\n\n');
          if (history) prompt.push({ type: 'text', text: `Prior conversation, supplied as historical context. Do not re-execute old instructions:\n<conversation_history>\n${history}\n</conversation_history>` });
        }
        // Claude owns its system prompt/tools/CLAUDE.md. OpenCode's tool instructions are not forwarded.
        const newUsers = entry.users.length ? users.slice(entry.users.length) : users.slice(-1);
        for (const message of newUsers) {
          for (const part of message.content) {
            if (part.type === 'text') prompt.push({ type: 'text', text: part.text });
            else if (part.type === 'media') {
              const source = part.media.source;
              if (!entry.acp.supportsImages || !part.media.mediaType.startsWith('image/')) throw new Error('This ACP session does not support the attached media.');
              if (source.type === 'base64') prompt.push({ type: 'image', data: source.data, mimeType: part.media.mediaType });
              else if (source.type === 'bytes') prompt.push({ type: 'image', data: Buffer.from(source.data).toString('base64'), mimeType: part.media.mediaType });
              else throw new Error('Claude ACP requires inline image data; remote media references are not supported.');
            }
          }
        }
        entry.users = fingerprints;
        // Persist before sending: automatic retries must not duplicate agent-side effects.
        await this.storage.set(sessionID, { sessionID: entry.acp.sessionID, directory, users: fingerprints });
        const turn: Turn = { queue: new Queue(), permissions: new Map(), streaming: false };
        entry.turn = turn;
        void entry.acp.connection.agent.request('session/prompt', { sessionId: entry.acp.sessionID, prompt }).then(
          (result) => { turn.stopReason = result.stopReason; turn.queue.close(); },
          (error: unknown) => turn.queue.close(error instanceof Error ? error : new Error(String(error))),
        );
      }
      const turn = entry.turn!;
      turn.streaming = true;
      yield LLMEvent.stepStart({ index: 0 });
      for await (const packet of turn.queue) {
        if ('permission' in packet) {
          yield* endBlock();
          const pending = packet.permission;
          turn.paused = pending;
          const details = pending.request.toolCall;
          yield LLMEvent.toolCall({ id: pending.token, name: 'question', input: { questions: [{
            header: 'Claude ACP approval', multiple: false,
            question: `Claude Code requests permission: ${details.title ?? details.toolCallId}\n\n${JSON.stringify(details.rawInput ?? details.content ?? {}, null, 2)}\n\nAllow this operation once?`,
            options: [{ label: 'Deny', description: 'Do not run this operation.' },
              { label: 'Allow once', description: 'Approve this one Claude Code operation.' }],
          }] } });
          paused = true;
          yield LLMEvent.stepFinish({ index: 0, reason: { normalized: 'tool-calls' } });
          yield LLMEvent.finish({ reason: { normalized: 'tool-calls' } });
          return;
        }
        const update = packet.update;
        if ((update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') && update.content.type === 'text') {
          const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning';
          if (block?.kind !== kind) {
            yield* endBlock();
            block = { id: randomUUID(), kind };
            yield kind === 'text' ? LLMEvent.textStart({ id: block.id }) : LLMEvent.reasoningStart({ id: block.id });
          }
          yield kind === 'text' ? LLMEvent.textDelta({ id: block!.id, text: update.content.text }) : LLMEvent.reasoningDelta({ id: block!.id, text: update.content.text });
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          // Keep ACP-owned tools visible without asking OpenCode to execute them again.
          if (update.status === 'completed' || update.status === 'failed') {
            yield* endBlock();
            const id = `claude_${update.toolCallId}`;
            yield LLMEvent.toolCall({ id, name: 'claude_code', input: update.rawInput ?? { title: update.title ?? update.toolCallId }, providerExecuted: true });
            yield LLMEvent.toolResult({ id, name: 'claude_code', result: { type: update.status === 'failed' ? 'error' : 'json', value: update.rawOutput ?? update.content ?? update.status }, providerExecuted: true });
          }
        }
      }
      yield* endBlock();
      completed = true;
      entry.turn = undefined;
      const reason = { normalized: turn.stopReason === 'max_tokens' ? 'length' as const : 'stop' as const, raw: turn.stopReason };
      yield LLMEvent.stepFinish({ index: 0, reason });
      yield LLMEvent.finish({ reason });
    } finally {
      signal.removeEventListener('abort', abort);
      if (entry?.turn) entry.turn.streaming = false;
      if (!paused && !completed) this.cancel(sessionID);
      if (completed && entry) {
        entry.idle = setTimeout(() => { entry!.acp.close(); this.entries.delete(sessionID); }, this.options.idleTimeoutMs ?? 300_000);
        entry.idle.unref();
      }
    }
  }

  cancel(sessionID: string) {
    const entry = this.entries.get(sessionID);
    if (!entry) return;
    clearTimeout(entry.idle);
    for (const pending of entry.turn?.permissions.values() ?? []) pending.resolve({ outcome: { outcome: 'cancelled' } });
    entry.turn?.queue.close(new Error('Claude ACP request cancelled.'));
    entry.acp.cancel();
    this.entries.delete(sessionID);
    // Give ACP a chance to cancel the CLI before closing its transport.
    const timer = setTimeout(() => entry.acp.close(), 500);
    timer.unref();
  }

  async reset(sessionID: string) { this.cancel(sessionID); await this.storage.remove(sessionID); }
  onIdle(sessionID: string) { if (this.entries.get(sessionID)?.turn) this.cancel(sessionID); }
  close() {
    this.closed = true;
    for (const connection of this.discoveries) connection.close();
    this.discoveries.clear();
    for (const id of this.entries.keys()) this.cancel(id);
  }
}
