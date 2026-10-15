import type { Interface as FormService } from '@opencode/core/form';
import { Context, Effect, Option } from 'effect';
import type { AskForm } from './auth.js';

// Resolve the host's service during execution, not plugin setup (whose
// context is deliberately restricted). Never create a second Form service.
const HostForm = Context.Service<FormService>('@opencode/Form');
export const captureForm = Effect.gen(function* () {
  const services = yield* Effect.context<never>();
  const forms = Context.getOption(services, HostForm);
  if (Option.isNone(forms)) return undefined;
  const ask: AskForm = async (form, signal) => {
    const state = await Effect.runPromiseWith(services)(forms.value.ask(form), { signal });
    return state.status === 'answered' ? state.answer : undefined;
  };
  return ask;
});
