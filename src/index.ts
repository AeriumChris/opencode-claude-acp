import { createHash, randomUUID } from 'node:crypto';
import { Plugin } from '@opencode/plugin';
import { Plugin as EffectPlugin } from '@opencode/plugin/effect';
import { fromPromise } from '@opencode/plugin/promise/adapter';
import { Effect, type Schema } from 'effect';
import { Model } from '@opencode/schema/model';
import { Provider } from '@opencode/schema/provider';
import { Session } from '@opencode/schema/session';
import { Bridge } from './bridge.js';
import { FAST_SUFFIX, type ModelChoice } from './acp.js';
import { parseOptions, type Options } from './options.js';
import { bridges } from './registry.js';
import { Checkpoints } from './compaction.js';
import { Authentication, type AskForm } from './auth.js';
import { captureForm } from './auth-form.js';
import { isAuthRequired, signInMessage } from './auth-error.js';

export type { Options } from './options.js';

/** A different adapter or Claude runtime can advertise different models. */
function catalogStorageKey(options: Options) {
  const runtime = [options.command, options.args, options.nodeExecutable, options.env];
  return `catalog:${createHash('sha256').update(JSON.stringify(runtime)).digest('hex').slice(0, 16)}`;
}

function cachedChoices(value: unknown): ModelChoice[] {
  const choice = (item: unknown): item is { id: string; name: string } => typeof item === 'object' && item !== null &&
    typeof (item as { id?: unknown }).id === 'string' && typeof (item as { name?: unknown }).name === 'string';
  if (!Array.isArray(value) || !value.every(choice)) return [];
  return value.map((item: ModelChoice) => ({ id: item.id, name: item.name,
    ...(Array.isArray(item.efforts) && item.efforts.every(choice) ? { efforts: item.efforts } : {}),
    ...(typeof item.fast === 'boolean' ? { fast: item.fast } : {}) }));
}
export function createPlugin(options: Options = {}, forms: { ask?: AskForm } = {}) {
  return Plugin.define({ id: 'opencode-claude-acp', async setup(ctx) {
    const instanceID = randomUUID();
    const providerID = Provider.ID.make('claude-acp');
    // ACP publishes rolling model choices, not launch dates. The desktop/web
    // selector hides epoch-dated entries and keeps only one model per family.
    // Date these catalog entries when registered, with one family per choice.
    const catalogRegisteredAt = Date.now();
    let disposed = false;
    const checkpoints = new Checkpoints(ctx.storage);
    const configured = parseOptions({ ...ctx.options, ...options });
    // Discovery starts Claude Code and probes every model, which takes many
    // seconds. Show the last discovered catalog at once, then refresh it.
    const catalogKey = catalogStorageKey(configured);
    let choices = await ctx.storage.get(catalogKey).then(cachedChoices, () => []);
    const publish = (next: ModelChoice[], persist: boolean) => {
      if (persist) void (next.length ? ctx.storage.set(catalogKey, next as unknown as Schema.Json)
        : ctx.storage.remove(catalogKey)).catch(() => {});
      if (JSON.stringify(next) === JSON.stringify(choices)) return;
      choices = next;
      void ctx.provider.reload().catch(() => {});
    };
    const bridge = new Bridge(configured, ctx.storage, (models, complete) => {
      if (!models.length || disposed) return;
      if (complete) return publish(models, true);
      const merged = new Map(choices.map((model) => [model.id, model]));
      for (const model of models) merged.set(model.id, { ...merged.get(model.id), ...model });
      publish([...merged.values()], false);
    }, async (sessionID, messages, modelID) => checkpoints.restore(messages,
      checkpoints.history(await ctx.session.context({ sessionID: Session.ID.make(sessionID) })),
      { providerID, id: Model.ID.make(modelID) }, 'provider'));
    bridges.set(instanceID, bridge);
    const authentication = new Authentication(ctx, (form, signal) => {
      const ask = forms.ask ?? bridge.askForm;
      if (!ask) return Promise.reject(new Error(signInMessage));
      return ask(form, signal);
    }, configured, (directory) => bridge.discover(directory));
    const registrations: { dispose(): Promise<void> }[] = [];
    registrations.push(await ctx.provider.transform((editor) => {
      const advertised = choices.filter((item) => item.id !== 'default');
      const ids = new Set(advertised.map((item) => item.id));
      // Fast mode is a native toggle, but the selector has no per-model switch.
      // Offer it as a sibling model so it can be chosen like any other.
      const models = advertised.flatMap((item) => item.fast && !ids.has(`${item.id}${FAST_SUFFIX}`)
        ? [item, { ...item, id: `${item.id}${FAST_SUFFIX}`, name: `${item.name} Fast (credit)` }] : [item]);
      editor.add({ info: { ...Provider.Info.empty(providerID), canonical: Provider.ID.anthropic, name: 'Claude Code (ACP)', activation: 'enabled',
        package: new URL('./provider.js', import.meta.url).href, settings: { instanceID } },
        models: models.map((item) => ({ ...Model.Info.default(providerID, Model.ID.make(item.id)), name: item.name,
          family: Model.Family.make(`claude-acp/${item.id}`), time: { released: catalogRegisteredAt },
          // Zero disables OpenCode's automatic context-limit checkpoints. ACP
          // owns its native context; turn-wide billing totals cannot size it.
          // Keep the actual native capacity in /claude-usage instead.
          limit: { ...Model.Info.default(providerID, Model.ID.make(item.id)).limit, context: 0 },
          variants: (item.efforts ?? []).filter((effort) => effort.id !== 'default')
            .map((effort) => ({ id: Model.VariantID.make(effort.id) })),
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'] } })),
      });
    }));
    registrations.push(await ctx.session.hook('context', async (event) => {
      const projected = checkpoints.history(await ctx.session.context({ sessionID: event.sessionID }));
      if (event.model.providerID !== providerID) {
        event.messages = await checkpoints.restore(event.messages, projected, event.model);
        await bridge.reset(event.sessionID);
        return;
      }
      const session = await ctx.session.get({ sessionID: event.sessionID });
      const history = await checkpoints.expand(projected);
      const originals = new Map<string, string[]>();
      for (const message of history) {
        if (message.type === 'user') originals.set(message.id, [message.text,
          ...(message.skills ?? []).flatMap((skill) => skill.text === undefined ? [] : [skill.text])]);
        else if (message.type === 'synthetic' || message.type === 'skill') originals.set(message.id, [message.text]);
        else if (message.type === 'assistant') originals.set(message.id,
          message.content.filter((part) => part.type === 'text').map((part) => part.text));
      }
      bridge.rememberOriginalText(event.sessionID, originals);
      event.options.acpSessionID = event.sessionID;
      event.options.acpDirectory = session.location.directory;
      event.options.acpAgent = event.agent;
      event.options.acpEffort = event.model.variant ?? 'default';
      const reportIDs: string[] = [];
      let reporting = false;
      let reportRequested = false;
      for (const message of history) {
        if (message.type === 'user' || message.type === 'synthetic') {
          reporting = message.metadata?.claudeAcpUsageReport === true;
          reportRequested = reporting;
        }
        if (reporting) reportIDs.push(message.id);
        if (message.type === 'assistant') reportRequested = false;
      }
      event.options.acpReportIDs = reportIDs;
      event.options.acpUsageReport = reportRequested;
      // Nested AGENTS.md files are injected by OpenCode's read tool as synthetic
      // messages. Treat these as instructions, not new user turns.
      event.options.acpInstructionIDs = history.filter((message) => message.type === 'synthetic' &&
        message.metadata?.instruction !== undefined).map((message) => message.id);
    }));
    registrations.push(await ctx.command.transform((editor) => editor.add({ name: 'claude-usage',
      description: 'Show recorded Claude ACP tokens, context capacity, and reported cost without calling Claude.',
      async execute({ sessionID }) {
        const session = await ctx.session.get({ sessionID });
        if (session.model?.providerID !== providerID) throw new Error('Select a Claude ACP model before using /claude-usage.');
        // The provider answers this tagged request locally. A queued synthetic
        // with resume:false is not delivered to the transcript until another turn.
        await ctx.session.synthetic({ sessionID, text: 'Show the recorded Claude ACP usage report.',
          description: 'Claude ACP usage report', metadata: { claudeAcpUsageReport: true }, delivery: 'queue', resume: true });
      },
    })));
    registrations.push(await ctx.command.transform((editor) => editor.add({ name: 'claude-login',
      description: 'Authenticate Claude Code on the OpenCode server.',
      async execute({ sessionID }) {
        if (!forms.ask && !bridge.askForm) throw new Error('Claude sign-in forms are unavailable in this host. Run the adapter with --cli auth login on the OpenCode server.');
        authentication.offer(sessionID);
      },
    })));
    registrations.push(await ctx.session.hook('title', (event) => {
      event.result = event.messages.find((item) => item.role === 'user')?.content
        .filter((part) => part.type === 'text').map((part) => part.text).join(' ').replace(/\s+/g, ' ').slice(0, 80) || 'Claude Code (ACP)';
    }, { providerID }));
    registrations.push(await ctx.session.hook('generate', () => {
      throw new Error('Claude ACP supports interactive sessions; auxiliary generation is not supported.');
    }, { providerID }));
    registrations.push(await ctx.session.hook('compaction', async (event) => {
      const history = checkpoints.history(await ctx.session.context({ sessionID: event.sessionID }));
      if (event.model.providerID === providerID) event.result = await checkpoints.create(history);
      else event.messages = await checkpoints.restore(event.messages, history, event.model);
    }));
    registrations.push(await ctx.session.hook('retry', (event) => {
      event.decision = { retry: false };
      if (event.error.type === 'provider.auth') authentication.offer(event.sessionID);
    }, { providerID }));
    registrations.push(await ctx.tool.hook('execute.before', (event) => {
      bridge.toolStarted(event.sessionID, event.id, event.tool);
    }));
    registrations.push(await ctx.tool.hook('execute.after', (event) => {
      if (event.tool === 'question') bridge.answer(event.sessionID, event.id,
        event.status === 'completed' ? event.result.metadata?.answers : undefined);
    }));
    const events = new AbortController();
    const watching = (async () => {
      for await (const envelope of ctx.event.subscribe({ signal: events.signal })) {
        const event = envelope;
        if (event.type === 'session.status' && event.data.status.type === 'idle') bridge.onIdle(event.data.sessionID);
        if (event.type === 'session.deleted') { authentication.cancel(event.data.sessionID); await bridge.reset(event.data.sessionID); }
      }
    })().catch(() => {});
    // A missing login never blocks loading all of the user's other providers.
    // Signed out, the cached catalog would only offer models that cannot run.
    void bridge.discover(ctx.location.directory).catch((error) => {
      if (!disposed && isAuthRequired(error)) publish([], true);
    });
    return async () => {
      disposed = true;
      events.abort();
      bridge.close();
      await authentication.close();
      bridges.delete(instanceID);
      await watching;
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  } });
}

// Command execution has the host runtime even when no model has been selected
// or called. Keep that context across the Promise adapter for sign-in forms.
export default EffectPlugin.define({ id: 'opencode-claude-acp', effect: (ctx) => Effect.suspend(() => {
  const forms: { ask?: AskForm } = {};
  return fromPromise(createPlugin({}, forms)).effect({ ...ctx, command: {
    ...ctx.command,
    transform: (callback) => ctx.command.transform((editor) => callback({
      add: (definition) => editor.add({ ...definition, execute: (input) => Effect.gen(function* () {
        if (definition.name === 'claude-login') forms.ask = yield* captureForm;
        yield* definition.execute(input);
      }) }),
    })),
  } });
}) });
