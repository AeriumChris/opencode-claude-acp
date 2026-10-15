import { RequestError } from '@agentclientprotocol/sdk';
import { AIError, AuthenticationError, UnknownProviderError } from '@opencode/ai';

export const signInMessage = 'Claude Code sign-in required: you are signed out or your login has expired. Choose Authenticate in the sign-in prompt, then retry your message. You can also run /claude-login, or run the adapter with --cli auth login on the OpenCode server.';

/** ACP errors can be wrapped by startup or stream failures. Never inspect prompt text. */
export function isAuthRequired(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error);
    const value = error as { code?: unknown; message?: unknown; cause?: unknown };
    if (value.code === RequestError.authRequired().code) return true;
    if (typeof value.message === 'string' && /^(?:authentication required|oauth required|not logged in(?:\s*[·:.].*)?|session expired[.!]?\s*please run \/login.*)[.!]?$/i.test(value.message.trim())) return true;
    error = value.cause;
  }
  return false;
}

export function providerFailure(error: unknown): AIError {
  return new AIError({ reason: isAuthRequired(error)
    ? new AuthenticationError({ message: signInMessage })
    : new UnknownProviderError({ message: error instanceof Error ? error.message : String(error) }) });
}
