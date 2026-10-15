import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestError } from '@agentclientprotocol/sdk';
import { OpenCode } from '@opencode/sdk/effect';
import { ManagedRuntime } from 'effect';
import plugin from '../dist/index.js';
import { isAuthRequired, providerFailure } from '../dist/auth-error.js';
import { authorizationURL, startLogin } from '../dist/auth-login.js';

async function eventually(fn, description) {
  const deadline = Date.now() + 10_000;
  do { const result = await fn(); if (result) return result; await delay(30); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}

test('auth errors retain their category through startup causes without matching arbitrary failures', () => {
  for (const error of [RequestError.authRequired(), new Error('startup', { cause: RequestError.authRequired() }), new Error('OAuth required')]) {
    assert(isAuthRequired(error));
    assert.equal(providerFailure(error).reason._tag, 'Authentication');
  }
  for (const error of [new Error('spawn ENOENT'), new Error('User asked: OAuth required'), { code: -32603 }]) {
    assert(!isAuthRequired(error));
    assert.equal(providerFailure(error).reason._tag, 'UnknownProvider');
  }
  const cyclic = new Error('cycle'); cyclic.cause = cyclic;
  assert(!isAuthRequired(cyclic));
  const valid = 'https://claude.ai/oauth/authorize?state=test&code_challenge=test';
  assert.equal(authorizationURL(valid), valid);
  assert.equal(authorizationURL(valid.replace('claude.ai/oauth', 'claude.com/cai/oauth')), valid.replace('claude.ai/oauth', 'claude.com/cai/oauth'));
  for (const url of [valid.replace('claude.ai', 'claude.ai.evil.test'), valid.replace('/oauth/authorize', '/other'), valid.replace('https:', 'http:'), 'https://claude.ai/oauth/authorize']) assert.equal(authorizationURL(url), undefined);
});

test('real host: cold login command, auth recovery, explicit retry, and cancellation', { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'claude-auth-'));
  const gate = join(directory, 'auth');
  const log = join(directory, 'agent.jsonl');
  const runtime = ManagedRuntime.make(OpenCode.layer({ database: { path: ':memory:' }, models: { fetch: false },
    config: { directory, project: false, content: JSON.stringify({ model: 'claude-acp/fixture-model' }) },
    fs: { filewatcher: false, fff: false }, plugins: [{ ...plugin, effect: (ctx) => plugin.effect({ ...ctx,
      options: { command: process.execPath, args: [resolve('test/fixtures/agent.mjs')],
        env: { ACP_TEST_AUTH_GATE: gate, ACP_TEST_LOG: log } } }) }] }));
  t.after(async () => { await runtime.dispose(); await delay(300); await rm(directory, { recursive: true, force: true }); });
  const sdk = await runtime.runPromise(OpenCode.Service);
  const api = (domain) => Object.fromEntries(Object.entries(domain).filter(([, value]) => typeof value === 'function')
    .map(([key, value]) => [key, (...args) => runtime.runPromise(value(...args))]));
  const host = { model: api(sdk.model), command: api(sdk.command), plugin: api(sdk.plugin),
    sessions: api(sdk.session), session: { form: api(sdk.session.form) } };
  const location = { directory };
  const logs = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
  await eventually(async () => (await host.command.list({ location })).data.some((command) => command.name === 'claude-login'), 'login command registered');
  const session = await host.sessions.create({ location });
  const sessionID = session.id;
  const forms = () => host.session.form.list({ sessionID });
  const form = async (title) => {
    const result = await eventually(async () => (await forms()).find((f) => f.title === title), title);
    // Desktop 2.0.29 selects only question forms and renders these field types.
    assert.equal(result.metadata.kind, 'question', `${title} must be visible in desktop`);
    assert(result.fields.every((field) => field.type === 'string' || field.type === 'multiselect'));
    return result;
  };
  const reply = (f, answer) => host.session.form.reply({ sessionID, formID: f.id, answer });
  const prompt = async (text) => {
    await host.sessions.prompt({ sessionID, text });
    await host.sessions.wait({ sessionID }, { signal: AbortSignal.timeout(10_000) });
  };
  // Load the actual server entrypoint, logged out, before any provider request.
  assert.equal((await host.model.list({ location })).data.filter((m) => m.providerID === 'claude-acp').length, 0);
  await host.sessions.command({ sessionID, name: 'claude-login', text: '' });
  await reply(await form('Claude Code sign-in required'), { action: 'authenticate' });
  await reply(await form('Authenticate with Claude'), { code: 'fixture-code' });
  await reply(await form('Claude Code is signed in'), { action: 'done' });
  assert.equal((await logs()).filter((l) => l.method === 'session/prompt').length, 0);
  await eventually(async () => (await host.model.list({ location })).data.some((m) => m.providerID === 'claude-acp'), 'models after first login');
  await rm(gate);
  await prompt('first attempt');
  const failed = (await host.sessions.context({ sessionID })).findLast((m) => m.type === 'idle');
  assert.equal(failed.error.type, 'provider.auth');
  assert.match(failed.error.message, /sign-in required.*Authenticate/);
  const offer = await form('Claude Code sign-in required');
  assert(offer.fields[0].options.some((o) => o.label === 'Authenticate'));
  assert.equal((await logs()).filter((l) => l.method === 'auth/login').length, 1, 'no additional login until user chooses it');
  await reply(offer, { action: 'authenticate' });
  const authorize = await form('Authenticate with Claude');
  assert.equal(authorize.fields[0].key, 'code');
  assert(authorize.fields[0].description.includes('https://claude.ai/oauth/authorize?state=fixture&code_challenge=fixture'));
  await reply(authorize, { code: 'fixture-code' });
  await reply(await form('Claude Code is signed in'), { action: 'done' });
  assert.equal((await logs()).filter((l) => l.method === 'session/prompt').length, 0, 'authentication never replays the failed request');
  await prompt('explicit retry');
  assert((await host.sessions.context({ sessionID })).some((m) => m.type === 'assistant' && m.content.some((p) => p.type === 'text' && p.text.startsWith('fixture:') && p.text.includes('explicit retry'))));

  // Expiration on an already-running ACP connection uses the same recovery UI.
  await rm(gate);
  await prompt('expired');
  await reply(await form('Claude Code sign-in required'), { action: 'cancel' });
  await eventually(async () => (await forms()).length === 0, 'dismissed offer');
  assert.equal((await logs()).filter((l) => l.method === 'auth/login').length, 2);
  await host.sessions.command({ sessionID, name: 'claude-login', text: '' });
  await reply(await form('Claude Code sign-in required'), { action: 'authenticate' });
  const pending = await form('Authenticate with Claude');
  await host.session.form.cancel({ sessionID, formID: pending.id });
  await eventually(async () => (await forms()).length === 0, 'cancelled login');
  const login = (await logs()).findLast((l) => l.method === 'auth/login');
  assert.equal(login.noBrowser, '1');
  await eventually(() => { try { process.kill(login.pid, 0); return false; } catch { return true; } }, 'login child stopped');
});

test('login process failure and cancellation settle without leaking CLI output', { timeout: 15_000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'claude-login-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const options = { command: process.execPath, args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_AUTH_GATE: join(directory, 'auth') } };
  const controller = new AbortController();
  const login = startLogin(directory, options, controller.signal);
  await login.url;
  login.submit('wrong');
  await assert.rejects(login.done, /sign-in failed/);
  const cancelled = new AbortController();
  const pending = startLogin(directory, options, cancelled.signal);
  await pending.url;
  cancelled.abort();
  await assert.rejects(pending.done, /cancelled/);
});
