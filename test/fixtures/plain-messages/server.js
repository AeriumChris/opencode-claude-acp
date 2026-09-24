import { Plugin } from '@opencode/plugin';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// DCP-style context edits retain content but replace Message instances by spreads.
export default Plugin.define({ id: 'test.plain-messages', async setup(ctx) {
  for (const kind of ['context', 'compaction']) await ctx.session.hook(kind, async (event) => {
    event.messages = event.messages.map((message) => ({ ...message, content: [...message.content] }));
    await writeFile(join(ctx.location.directory, 'plain-hook.json'), JSON.stringify({ kind, count: event.messages.length }));
  });
} });
