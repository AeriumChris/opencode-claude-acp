import type { Message } from '@opencode/ai';

// DCP's compact/XML message IDs are host bookkeeping, not Claude user input.
// Only remove a suffix when the remaining text matches a persisted source part.
// This preserves literal markers, whitespace, and all unrelated plugin context.
const marker = /^(?:@[1-9]\d*@(?: \[[^\]\r\n]+\])?|<dcp-message-id(?:\s+[^<>]*)?>m\d+<\/dcp-message-id>)$/;

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
        if (marker.test(suffix)) return { ...part, text: source };
      }
      return part;
    }) };
  });
}
