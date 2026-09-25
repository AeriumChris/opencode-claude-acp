import { randomUUID } from 'node:crypto';
import { toLLMMessages } from '@opencode/core/session/runner/to-llm-message';
import type { Message } from '@opencode/ai';
import type { Model } from '@opencode/schema/model';
import { SessionMessage } from '@opencode/schema/session-message';
import { Schema } from 'effect';

type History = readonly SessionMessage.Info[];
type Storage = {
  get(key: string): Promise<Schema.Json | undefined>;
  set(key: string, value: Schema.Json): Promise<void>;
};
const marker = 'claudeAcpCheckpoint';
const prefix = 'checkpoint/';
const decodeHistory = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Info));
const encodeHistory = Schema.encodeSync(Schema.Array(SessionMessage.Info));

function reference(message: SessionMessage.Info) {
  if (message.type !== 'compaction' || message.status !== 'completed') return;
  const key = message.metadata?.[marker];
  return typeof key === 'string' && key.startsWith(prefix) ? key : undefined;
}

/** Host checkpoints archive history; Claude continues to own its native context.
 * Keep immutable snapshots across resets/reverts: a fork can still reference one.
 * Snapshots link to earlier checkpoints instead of copying their entire history.
 */
export class Checkpoints {
  constructor(private readonly storage: Storage) {}

  // The plugin API uses wire values (notably numeric timestamps); core's
  // converter expects decoded schemas. Encode again before writing JSON storage.
  history(messages: readonly unknown[]): History { return decodeHistory(messages); }

  async create(history: History) {
    const messages = history.filter((message) => message.type !== 'compaction' || message.status === 'completed')
      .map((message) => reference(message) ? { ...message, recent: '' } : message);
    const key = `${prefix}${randomUUID()}`;
    await this.storage.set(key, JSON.parse(JSON.stringify(encodeHistory(messages))) as Schema.Json);
    return {
      summary: '',
      metadata: { [marker]: key },
    };
  }

  async expand(history: History): Promise<SessionMessage.Info[]> {
    const result: SessionMessage.Info[] = [];
    // Iterative traversal also handles long-running sessions with many checkpoints.
    const stack: { messages: History; index: number; key: string }[] = [{ messages: history, index: 0, key: '' }];
    const active = new Set<string>();
    while (stack.length) {
      const frame = stack.at(-1)!;
      if (frame.index === frame.messages.length) {
        active.delete(frame.key);
        stack.pop();
        continue;
      }
      const message = frame.messages[frame.index++]!;
      const key = reference(message);
      if (!key) { result.push(message); continue; }
      if (active.has(key)) throw new Error('Claude ACP checkpoint contains a circular history reference.');
      const saved = await this.storage.get(key);
      if (!Array.isArray(saved)) throw new Error('Claude ACP checkpoint history is unavailable. Restore the plugin storage before continuing this session.');
      active.add(key);
      stack.push({ messages: decodeHistory(saved), index: 0, key });
    }
    return result;
  }

  /** Replace only our checkpoint wrappers, preserving other plugins' message edits.
   * Also used for other providers and their compaction requests after a model switch.
   */
  async restore(messages: readonly Message[], history: History, model: Model.Ref, runtime: 'host' | 'provider' = 'host'): Promise<Message[]> {
    const checkpoints = new Map(history.filter((message) => reference(message)).map((message) => [message.id, message]));
    // The desktop executable and a filesystem plugin have separate copies of
    // @opencode/ai. Media.Asset is validated with instanceof, so local converter
    // instances cannot cross back into the host. Decode the wire representation
    // with the host Message schema supplied on its existing message instances.
    const hostMessage = messages.map((message) => message.constructor).find(Schema.isSchema) as typeof Message | undefined;
    const restored: Message[] = [];
    for (const message of messages) {
      const checkpoint = message.id && checkpoints.get(message.id as SessionMessage.ID);
      if (checkpoint) {
        const converted = toLLMMessages(await this.expand([checkpoint]), model);
        // ACP consumes restored messages inside its own provider, after host
        // validation. This also supports hooks such as DCP that spread messages
        // into plain objects and therefore erase the host schema constructor.
        if (runtime === 'provider' || !converted.some((item) => item.content.some((part) => part.type === 'media'))) {
          restored.push(...converted);
          continue;
        }
        if (!hostMessage) throw new Error('Claude ACP cannot restore this checkpoint for another provider because a context hook replaced all host Message instances. Continue with Claude ACP or disable that context hook before switching providers.');
        const decode = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Array(hostMessage)));
        restored.push(...decode(JSON.parse(JSON.stringify(converted))));
      }
      else restored.push(message);
    }
    return restored;
  }
}
