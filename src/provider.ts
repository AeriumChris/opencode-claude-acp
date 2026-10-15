import { LLMEvent } from '@opencode/ai';
import { Route, Protocol, type TransportDef } from '@opencode/ai/route';
import { Context, Effect, Option, Schema, Stream } from 'effect';
import type { Interface as PermissionService } from '@opencode/core/permission';
import { Agent } from '@opencode/schema/agent';
import { Session } from '@opencode/schema/session';
import { nativePermission } from './permissions.js';
import { bridges } from './registry.js';
import { providerFailure as failure } from './auth-error.js';
import { captureForm } from './auth-form.js';

// The pinned V2 plugin API exposes permission replies but not assertion. Resolve
// the host's location service by its stable key, without loading a second Core
// runtime (or creating an unrelated permission queue).
const HostPermission = Context.Service<PermissionService>('@opencode/Permission');

/** OpenCode native provider entrypoint. Execution stays in the server for all clients. */
export function model(modelID: string, settings: Readonly<Record<string, unknown>>) {
  const protocol = Protocol.make({
    id: 'claude-acp',
    body: { schema: Schema.Struct({}), from: () => Effect.succeed({}) },
    stream: { event: Schema.toType(LLMEvent), initial: () => null,
      step: (_state: null, event: LLMEvent) => Effect.succeed([null, [event]] as const) },
  });
  const transport: TransportDef<{}, {}, LLMEvent> = {
    id: 'claude-acp-stdio',
    prepare: () => Effect.succeed({}),
    execute: (_prepared, request) => Effect.gen(function* () {
      const bridge = bridges.get(String(settings.instanceID));
      const options = request.providerOptions;
      if (!bridge || typeof options?.acpSessionID !== 'string' || typeof options.acpDirectory !== 'string') {
        return yield* Effect.fail(failure(new Error('Claude ACP must be used through its OpenCode session plugin.')));
      }
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      const services = yield* Effect.context<never>();
      bridge.askForm = yield* captureForm;
      const permission = Context.getOption(services, HostPermission);
      const authorize = async (pending: Parameters<typeof nativePermission>[0]) => {
        if (Option.isNone(permission)) throw new Error('OpenCode permission service is unavailable. Update to the supported OpenCode version.');
        try {
          await Effect.runPromiseWith(services)(permission.value.assert({
            ...nativePermission(pending), sessionID: Session.ID.make(options.acpSessionID as string),
            agent: typeof options.acpAgent === 'string' ? Agent.ID.make(options.acpAgent) : undefined,
          }), { signal: controller.signal });
          return true;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // Rejection, a deny rule, and host errors must never grant permission.
          return false;
        }
      };
      const source = bridge.stream(options.acpSessionID, options.acpDirectory, modelID, request, controller.signal, authorize)[Symbol.asyncIterator]();
      const iterable: AsyncIterable<LLMEvent> = { [Symbol.asyncIterator]: () => ({
        next: () => source.next(),
        // Abort before awaiting return(): an async generator may be blocked in
        // next() waiting for ACP. Relying on the outer scope finalizer deadlocks.
        return: async () => { controller.abort(); return source.return ? source.return() : { done: true, value: undefined }; },
      }) };
      return { frames: Stream.fromAsyncIterable(iterable, failure) };
    }),
  };
  return Route.make<{}, {}, LLMEvent, LLMEvent, null>({ id: 'claude-acp', provider: 'claude-acp', protocol,
    endpoint: { baseURL: 'http://acp.invalid', path: '/' }, transport }).model({ id: modelID });
}
