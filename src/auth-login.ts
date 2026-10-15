import { spawn } from 'node:child_process';
import { command, type Options } from './options.js';

/** Only publish an OAuth authorization URL, never arbitrary CLI output. */
export function authorizationURL(output: string): string | undefined {
  for (const candidate of output.match(/https:\/\/[^\s<>"\x1b]+/g) ?? []) {
    try {
      const url = new URL(candidate);
      const endpoint = ['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(url.hostname)
        ? url.pathname === '/oauth/authorize'
        : url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize';
      if (endpoint && !url.username && !url.password && !url.port &&
          url.searchParams.has('state') && url.searchParams.has('code_challenge')) return url.href;
    } catch { /* Output may contain a URL split across chunks. */ }
  }
}

export function startLogin(directory: string, options: Options, signal: AbortSignal) {
  const [exe, args, extraEnv] = command(options);
  // The CLI owns PKCE, token exchange, storage and refresh. Manual code entry
  // also works when the browser and OpenCode server are on different machines.
  const child = spawn(exe, [...args, '--cli', 'auth', 'login'], { cwd: directory,
    env: { ...process.env, ...extraEnv, ...options.env, NO_BROWSER: '1' },
    stdio: 'pipe', shell: false, windowsHide: true });
  let output = '';
  let settled = false;
  let found = false;
  let resolveURL!: (url: string) => void;
  let rejectURL!: (error: Error) => void;
  let resolveDone!: () => void;
  let rejectDone!: (error: Error) => void;
  const url = new Promise<string>((resolve, reject) => { resolveURL = resolve; rejectURL = reject; });
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Either promise may reject before its consumer starts awaiting it.
  void url.catch(() => {});
  void done.catch(() => {});
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    output = '';
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      // The adapter starts a native CLI child. Windows does not forward signals
      // to descendants, so terminate only this owned process tree on cancel.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
        killer.once('error', () => child.kill());
      } else child.kill();
    }
    if (!found) rejectURL(error ?? new Error('Claude login completed without an authorization link. Retry /claude-login.'));
    if (error) rejectDone(error); else resolveDone();
  };
  const abort = () => finish(new Error('Claude sign-in cancelled. Run /claude-login to try again.'));
  const timeout = setTimeout(() => finish(new Error('Claude sign-in timed out. Run /claude-login to try again.')), 5 * 60_000);
  timeout.unref();
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', () => finish(new Error('Could not launch Claude login. Check the configured executable on the OpenCode server.')));
  child.stdin.on('error', () => finish(new Error('Claude login closed before receiving the authorization code. Run /claude-login to try again.')));
  child.once('close', (code) => finish(code === 0 ? undefined : new Error('Claude sign-in failed. Run /claude-login to try again, or run the adapter with --cli auth login on the OpenCode server.')));
  const read = (chunk: Buffer) => {
    if (found || settled) return;
    output = (output + chunk.toString('utf8')).slice(-32_768);
    // Wait for a delimiter so a chunk boundary cannot truncate the PKCE URL.
    const complete = output.match(/https:\/\/[^\s<>"\x1b]+(?=[\s<>"\x1b])/g)?.join('\n');
    const value = complete && authorizationURL(complete);
    if (value) { found = true; output = ''; resolveURL(value); }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  if (signal.aborted) abort();
  return { url, done, submit(code: string) {
    if (!settled && code.trim() && !/[\r\n\x00]/.test(code.trim())) child.stdin.write(`${code.trim()}\n`);
    else if (!settled) finish(new Error('Invalid authorization code. Run /claude-login and paste the code on one line.'));
  } };
}
