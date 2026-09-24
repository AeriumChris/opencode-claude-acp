import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { LLMEvent } from '@opencode/ai';

type Update = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;
type Activity = { update: Update; segment: number; phase?: 'input' | 'running'; done?: boolean };

/** ACP deltas belong to a native turn, which can span several host model steps. */
export class NativeTools {
  private tools = new Map<string, Activity>();

  *update(update: Update): Iterable<LLMEvent> {
    let tool = this.tools.get(update.toolCallId);
    if (tool?.done) return;
    if (!tool) {
      tool = { update, segment: 0 };
      this.tools.set(update.toolCallId, tool);
    } else {
      // Optional/null ACP update fields mean unchanged, not erased.
      tool.update = { ...tool.update, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)) } as Update;
    }
    yield* this.open(tool);
    const status = tool.update.status;
    if (status === 'in_progress' || status === 'completed' || status === 'failed') yield* this.call(tool);
    if (status === 'completed' || status === 'failed') {
      yield this.result(tool, status === 'failed' ? 'error' : 'json', tool.update.rawOutput ?? tool.update.content ?? status);
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
    yield LLMEvent.toolInputStart({ id: this.id(tool), name: 'claude_code', providerExecuted: true });
    yield LLMEvent.toolInputDelta({ id: this.id(tool), name: 'claude_code', text: JSON.stringify(this.input(tool)) });
    yield LLMEvent.toolInputEnd({ id: this.id(tool), name: 'claude_code' });
  }

  private *call(tool: Activity): Iterable<LLMEvent> {
    if (tool.phase === 'running') return;
    yield* this.open(tool);
    tool.phase = 'running';
    yield LLMEvent.toolCall({ id: this.id(tool), name: 'claude_code', providerExecuted: true,
      input: this.input(tool) });
  }

  private input(tool: Activity) {
    return { title: tool.update.title?.trim() || 'Claude Code operation',
      ...(tool.update.rawInput != null ? { input: tool.update.rawInput } : {}) };
  }

  private result(tool: Activity, type: 'json' | 'error', value: unknown) {
    return LLMEvent.toolResult({ id: this.id(tool), name: 'claude_code', providerExecuted: true, result: { type, value } });
  }
}
