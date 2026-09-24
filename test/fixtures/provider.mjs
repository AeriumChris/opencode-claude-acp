// Deterministic non-ACP provider for testing a switch away from native history.
import { appendFileSync } from 'node:fs';
import { LLMEvent } from '@opencode/ai';
import { Protocol, Route } from '@opencode/ai/route';
import { Effect, Schema, Stream } from 'effect';

export function model(id, settings) {
  const protocol = Protocol.make({ id: 'checkpoint-fixture',
    body: { schema: Schema.Struct({}), from: () => Effect.succeed({}) },
    stream: { event: Schema.toType(LLMEvent), initial: () => null, step: (_, event) => Effect.succeed([null, [event]]) },
  });
  return Route.make({ id: 'checkpoint-fixture', provider: 'checkpoint-fixture', protocol,
    endpoint: { baseURL: 'http://fixture.invalid', path: '/' }, transport: {
      id: 'checkpoint-fixture', prepare: () => Effect.succeed({}),
      execute: (_, request) => Effect.sync(() => {
        appendFileSync(settings.log, `${JSON.stringify({ otherProvider: request.messages })}\n`);
        return { frames: Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }), LLMEvent.textStart({ id: 'text' }),
          LLMEvent.textDelta({ id: 'text', text: '## Objective\n- Continue the fixture conversation.' }),
          LLMEvent.textEnd({ id: 'text' }), LLMEvent.stepFinish({ index: 0, reason: { normalized: 'stop' } }),
          LLMEvent.finish({ reason: { normalized: 'stop' } }),
        ]) };
      }),
    },
  }).model({ id });
}
