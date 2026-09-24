import { randomUUID } from 'node:crypto';
import { Plugin } from '@opencode/plugin';
import { Model } from '@opencode/schema/model';
import { Provider } from '@opencode/schema/provider';
import { Bridge } from './bridge.js';
import type { ModelChoice } from './acp.js';
import { parseOptions, type Options } from './options.js';
import { bridges } from './registry.js';

export type { Options } from './options.js';
export function createPlugin(options: Options = {}) {
  return Plugin.define({ id: 'opencode-claude-acp', async setup(ctx) {
    const instanceID = randomUUID();
    const providerID = Provider.ID.make('claude-acp');
    // ACP publishes rolling model choices, not launch dates. The desktop/web
    // selector hides epoch-dated entries and keeps only one model per family.
    // Date these catalog entries when registered, with one family per choice.
    const catalogRegisteredAt = Date.now();
    let choices: ModelChoice[] = [];
    let disposed = false;
    const bridge = new Bridge(parseOptions({ ...ctx.options, ...options }), ctx.storage, (models) => {
      if (!models.length || disposed) return;
      const merged = new Map(choices.map((model) => [model.id, model]));
      for (const model of models) merged.set(model.id, { ...merged.get(model.id), ...model });
      const next = [...merged.values()];
      if (JSON.stringify(next) === JSON.stringify(choices)) return;
      choices = next;
      void ctx.provider.reload().catch(() => {});
    });
    bridges.set(instanceID, bridge);
    const registrations: { dispose(): Promise<void> }[] = [];
    registrations.push(await ctx.provider.transform((editor) => {
      const models = [{ ...choices.find((item) => item.id === 'default'), id: 'default', name: 'Claude Code — default (ACP)' },
        ...choices.filter((item) => item.id !== 'default')];
      editor.add({ info: { ...Provider.Info.empty(providerID), name: 'Claude Code (ACP)', activation: 'enabled',
        package: new URL('./provider.js', import.meta.url).href, settings: { instanceID } },
        models: models.map((item) => ({ ...Model.Info.default(providerID, Model.ID.make(item.id)), name: item.name,
          family: Model.Family.make(`claude-acp/${item.id}`), time: { released: catalogRegisteredAt },
          variants: (item.efforts ?? []).filter((effort) => effort.id !== 'default')
            .map((effort) => ({ id: Model.VariantID.make(effort.id) })),
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'] } })),
      });
    }));
    registrations.push(await ctx.session.hook('context', async (event) => {
      if (event.model.providerID !== providerID) { await bridge.reset(event.sessionID); return; }
      const session = await ctx.session.get({ sessionID: event.sessionID });
      event.options.acpSessionID = event.sessionID;
      event.options.acpDirectory = session.location.directory;
      event.options.acpEffort = event.model.variant ?? 'default';
      const question = event.tools.question;
      if (!question) throw new Error('Claude ACP requires OpenCode’s built-in question tool for approvals. Enable it for this agent.');
      event.tools = { question };
    }));
    registrations.push(await ctx.session.hook('title', (event) => {
      event.result = event.messages.find((item) => item.role === 'user')?.content
        .filter((part) => part.type === 'text').map((part) => part.text).join(' ').replace(/\s+/g, ' ').slice(0, 80) || 'Claude Code (ACP)';
    }, { providerID }));
    registrations.push(await ctx.session.hook('generate', () => {
      throw new Error('Claude ACP supports interactive sessions; auxiliary generation is not supported.');
    }, { providerID }));
    registrations.push(await ctx.session.hook('compaction', () => {
      throw new Error('OpenCode compaction is not supported by this ACP bridge. Claude Code manages its own context. Start a new session if the host context fills.');
    }, { providerID }));
    registrations.push(await ctx.session.hook('retry', (event) => { event.decision = { retry: false }; }, { providerID }));
    registrations.push(await ctx.tool.hook('execute.after', (event) => {
      if (event.tool === 'question') bridge.answer(event.sessionID, event.id,
        event.status === 'completed' ? event.result.metadata?.answers : undefined);
    }));
    const events = new AbortController();
    const watching = (async () => {
      for await (const envelope of ctx.event.subscribe({ signal: events.signal })) {
        const event = envelope;
        if (event.type === 'session.status' && event.data.status.type === 'idle') bridge.onIdle(event.data.sessionID);
        if (event.type === 'session.deleted') await bridge.reset(event.data.sessionID);
      }
    })().catch(() => {});
    // A missing login never blocks loading all of the user's other providers.
    void bridge.discover(ctx.location.directory).catch(() => {});
    return async () => {
      disposed = true;
      events.abort();
      bridge.close();
      bridges.delete(instanceID);
      await watching;
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  } });
}

export default createPlugin();
