import type { Message } from '@opencode/ai';

// DCP's IDs and compression nudges describe host history, not Claude's native
// context. In particular its usage estimate may include a whole ACP agent loop.
// Only remove a suffix when the remaining text matches a persisted source part.
// This preserves literal markers, whitespace, and all unrelated plugin context.
const bookkeeping = /^(?:(?:@[1-9]\d*@(?: \[[^\]\r\n]+\])?|<dcp-message-id(?:\s+[^<>]*)?>m\d+<\/dcp-message-id>|<dcp-system-reminder>(?:(?!<\/dcp-system-reminder>)[\s\S])*<\/dcp-system-reminder>)(?:\n+|$))+$/;

export function cleanMessages(messages: readonly Message[], originals: ReadonlyMap<string, readonly string[]>): Message[] {
  return messages.map((message) => {
    const sources = message.id ? originals.get(message.id) : undefined;
    if (!sources) return message;
    return { ...message, content: message.content.map((part) => {
      if (part.type !== 'text' || sources.includes(part.text)) return part;
      for (const source of sources) {
        const prefix = source.replace(/\n*$/, '');
        if (!part.text.startsWith(`${prefix}\n\n`)) continue;
        const suffix = part.text.slice(prefix.length + 2);
        if (bookkeeping.test(suffix)) return { ...part, text: source };
      }
      return part;
    }) };
  });
}
