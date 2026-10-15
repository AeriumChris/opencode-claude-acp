import type { Plugin } from '@opencode/plugin';
import { Form } from '@opencode/schema/form';
import { Session } from '@opencode/schema/session';
import type { Options } from './options.js';
import { signInMessage } from './auth-error.js';
import { startLogin } from './auth-login.js';

type Flow = { controller: AbortController; task: Promise<void> };
export type AskForm = (form: Form.Info, signal: AbortSignal) => Promise<Form.Answer | undefined>;

/** Use question forms: desktop/web session UIs filter out generic forms. */
export class Authentication {
  private flows = new Map<string, Flow>();
  private closed = false;
  private signingIn?: string;

  constructor(private ctx: Pick<Plugin.Context, 'session'>, private askForm: AskForm, private options: Options,
    private authenticated: (directory: string) => Promise<void>) {}

  offer(sessionID: string) {
    if (this.closed || this.flows.has(sessionID)) return;
    const flow: Flow = { controller: new AbortController(), task: Promise.resolve() };
    this.flows.set(sessionID, flow);
    flow.task = this.run(sessionID, flow.controller.signal).catch(() => {
      // A deleted session, disconnected client or shutdown must not obscure the
      // original provider error. Its message always includes a CLI fallback.
    }).finally(() => {
      if (this.flows.get(sessionID) === flow) this.flows.delete(sessionID);
    });
  }

  cancel(sessionID: string) { this.flows.get(sessionID)?.controller.abort(); }

  async close() {
    this.closed = true;
    for (const flow of this.flows.values()) flow.controller.abort();
    await Promise.all([...this.flows.values()].map((flow) => flow.task));
  }

  private async ask(sessionID: string, signal: AbortSignal, title: string, fields: Form.Fields) {
    if (signal.aborted) return;
    return this.askForm({ sessionID, id: Form.ID.create(), title, fields, metadata: { kind: 'question', claudeAcpAuth: true } }, signal);
  }

  private async notice(sessionID: string, signal: AbortSignal, title: string, description: string) {
    await this.ask(sessionID, signal, title, [{ key: 'action', type: 'string', title, description: `${title}. ${description}`,
      options: [{ value: 'done', label: 'Done' }], required: true }]);
  }

  private async run(sessionID: string, signal: AbortSignal) {
    const answer = await this.ask(sessionID, signal, 'Claude Code sign-in required', [{
      key: 'action', type: 'string', title: 'Sign in to Claude Code', description: signInMessage,
      options: [{ value: 'authenticate', label: 'Authenticate' }, { value: 'cancel', label: 'Not now' }], required: true,
    }]);
    if (signal.aborted || answer?.action !== 'authenticate') return;
    if (this.signingIn) {
      await this.notice(sessionID, signal, 'Claude sign-in already in progress', 'Complete or cancel the sign-in prompt in the other session, then run /claude-login here.');
      return;
    }
    this.signingIn = sessionID;
    const loginController = new AbortController();
    const abort = () => loginController.abort();
    signal.addEventListener('abort', abort, { once: true });
    let failure: string | undefined;
    try {
      const session = await this.ctx.session.get({ sessionID: Session.ID.make(sessionID) });
      if (signal.aborted) return;
      const login = startLogin(session.location.directory, this.options, loginController.signal);
      const url = await login.url;
      const code = this.ask(sessionID, loginController.signal, 'Authenticate with Claude', [
        // Desktop questions render only string/multiselect fields. An external
        // field would be invisible and its required acknowledgement impossible.
        { key: 'code', type: 'string', title: 'Authorization code', required: true,
          description: `Copy this URL into your browser to sign in to Claude:\n\n${url}\n\nAfter signing in, paste the authorization code here (choose “Type your own answer” if shown). If the browser completes sign-in automatically, this prompt will close. Credentials are saved by Claude Code on the OpenCode server.`, maxLength: 4096 },
      ]).then(async (answer) => {
        if (!answer || typeof answer.code !== 'string') { loginController.abort(); return; }
        login.submit(answer.code);
        await login.done;
      });
      await Promise.race([login.done, code]);
      if (signal.aborted || loginController.signal.aborted) return;
      loginController.abort();
      await code.catch(() => {});
      // Discovery is disposable and refreshes model choices without replaying a
      // user prompt or restarting unrelated sessions.
      await this.authenticated(session.location.directory).catch(() => {});
    } catch (error) {
      if (loginController.signal.aborted) return;
      failure = error instanceof Error ? error.message : 'Claude sign-in failed. Run /claude-login to try again.';
    } finally {
      loginController.abort();
      signal.removeEventListener('abort', abort);
      this.signingIn = undefined;
    }
    if (!signal.aborted) await this.notice(sessionID, signal,
      failure ? 'Claude sign-in failed' : 'Claude Code is signed in',
      failure ?? 'Sign-in completed. Retry your message to continue.');
  }
}
