import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { Message } from '@opencode/ai';

/** OpenCode resolves file/data URLs and normalizes images before model dispatch. */
export function contentBlocks(message: Message, supportsImages: boolean): ContentBlock[] {
  return message.content.flatMap((part): ContentBlock[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text }];
    if (part.type !== 'media') return [];
    const label = part.filename ?? 'unnamed attachment';
    if (!supportsImages || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.media.mediaType)) {
      throw new Error(`Claude ACP cannot read attachment ${label} (${part.media.mediaType}). Attach a PNG, JPEG, GIF, WebP, or UTF-8 text file.`);
    }
    const inline = part.media.inline();
    if (!inline) throw new Error(`Attachment ${label} has no image bytes. Use OpenCode’s file picker, paste, or a file/data URL rather than a remote media reference.`);
    return [
      ...(part.filename ? [{ type: 'text' as const, text: `Attached image: ${part.filename}` }] : []),
      { type: 'image', data: inline.base64, mimeType: inline.mime },
    ];
  });
}
