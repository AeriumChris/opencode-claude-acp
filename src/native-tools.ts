import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { LLMEvent } from '@opencode/ai';

type Update = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;
type Activity = { update: Update; name: string; segment: number; phase?: 'input' | 'running'; done?: boolean };

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Match OpenCode's built-in renderers without scheduling a host tool execution. */
export function nativeToolName(update: Pick<Update, 'kind' | 'title' | 'rawInput'>): string {
  const input = record(update.rawInput);
  if (update.kind === 'execute') return 'shell';
  if (update.kind === 'read') return 'read';
  if (update.kind === 'edit') return 'content' in input && !('old_string' in input) ? 'write' : 'edit';
  if (update.kind === 'search') return /^glob\b/i.test(update.title ?? '') || 'glob' in input ? 'glob' : 'grep';
  if (update.kind === 'fetch') return 'webfetch';
  return 'claude_code';
}

function output(update: Update): unknown {
  const blocks = update.content?.flatMap((part) => part.type === 'content' && part.content.type === 'text' ? [part.content.text] : []);
  if (blocks?.length) return blocks.join('\n');
  const raw = update.rawOutput;
  if (typeof raw === 'string') return raw;
  const fields = record(raw);
  const text = ['stdout', 'stderr'].flatMap((key) => typeof fields[key] === 'string' && fields[key] ? [fields[key]] : []);
  if (text.length) return text.join('\n');
  return raw ?? update.content ?? update.status ?? '';
}

/** ACP deltas belong to a native turn, which can span several host model steps. */
export class NativeTools {
  private tools = new Map<string, Activity>();

  *update(update: Update): Iterable<LLMEvent> {
    let tool = this.tools.get(update.toolCallId);
    if (tool?.done) return;
    if (!tool) {
      tool = { update, name: nativeToolName(update), segment: 0 };
      this.tools.set(update.toolCallId, tool);
    } else {
      // Optional/null ACP update fields mean unchanged, not erased.
      tool.update = { ...tool.update, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)) } as Update;
    }
    yield* this.open(tool);
    const status = tool.update.status;
    if (status === 'in_progress' || status === 'completed' || status === 'failed') yield* this.call(tool);
    if (status === 'completed' || status === 'failed') {
      yield this.result(tool, status === 'failed' ? 'error' : 'json', output(tool.update));
      tool.done = true;
      tool.phase = undefined;
    }
  }

  *resume(): Iterable<LLMEvent> {
    for (const tool of this.tools.values()) {
      if (tool.done) continue;
      yield* this.open(tool);
      if (tool.update.status === 'in_progress') yield* this.call(tool);
    }
  }

  *pause(message: string): Iterable<LLMEvent> {
    // The host requires every provider-owned call to settle within its step.
    // Explicitly end this display segment; the native operation is still pending.
    for (const tool of this.tools.values()) {
      if (tool.done || !tool.phase) continue;
      yield* this.call(tool);
      yield this.result(tool, 'json', { status: 'paused', message });
      tool.phase = undefined;
      tool.segment++;
    }
  }

  *finish(): Iterable<LLMEvent> {
    for (const tool of this.tools.values()) {
      if (tool.done) continue;
      yield* this.call(tool);
      yield this.result(tool, 'error', 'Claude ACP ended the turn without a final tool status.');
      tool.done = true;
    }
  }

  private id(tool: Activity) {
    return `claude_${tool.update.toolCallId}${tool.segment ? `_resume_${tool.segment}` : ''}`;
  }

  private *open(tool: Activity): Iterable<LLMEvent> {
    if (tool.phase) return;
    tool.phase = 'input';
    yield LLMEvent.toolInputStart({ id: this.id(tool), name: tool.name, providerExecuted: true });
    yield LLMEvent.toolInputDelta({ id: this.id(tool), name: tool.name, text: JSON.stringify(this.input(tool)) });
    yield LLMEvent.toolInputEnd({ id: this.id(tool), name: tool.name });
  }

  private *call(tool: Activity): Iterable<LLMEvent> {
    if (tool.phase === 'running') return;
    yield* this.open(tool);
    tool.phase = 'running';
    yield LLMEvent.toolCall({ id: this.id(tool), name: tool.name, providerExecuted: true,
      input: this.input(tool) });
  }

  private input(tool: Activity) {
    const input = record(tool.update.rawInput);
    const path = input.file_path ?? input.path ?? tool.update.locations?.[0]?.path;
    return { ...input, title: tool.update.title?.trim() || 'Claude Code operation',
      ...(typeof path === 'string' ? { path } : {}),
      ...(tool.name === 'shell' && typeof input.command !== 'string' ? { command: tool.update.title ?? '' } : {}) };
  }

  private result(tool: Activity, type: 'json' | 'error', value: unknown) {
    return LLMEvent.toolResult({ id: this.id(tool), name: tool.name, providerExecuted: true, result: { type, value } });
  }
}
