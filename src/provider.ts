import { AIError, LLMEvent, UnknownProviderError } from '@opencode/ai';
import { Route, Protocol, type TransportDef } from '@opencode/ai/route';
import { Effect, Schema, Stream } from 'effect';
import { bridges } from './registry.js';

const failure = (error: unknown) => new AIError({ reason: new UnknownProviderError({ message: error instanceof Error ? error.message : String(error) }) });

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
      const source = bridge.stream(options.acpSessionID, options.acpDirectory, modelID, request, controller.signal)[Symbol.asyncIterator]();
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
