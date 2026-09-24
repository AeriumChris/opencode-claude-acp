import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/sdk';
import { createPlugin } from '../dist/index.js';

async function eventually(fn, description) {
  const deadline = Date.now() + 15_000;
  do { const result = await fn(); if (result) return result; await delay(50); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}

test('real OpenCode host: model catalog, streams, continuity, approvals, and cancellation', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'claude-acp-'));
  const log = join(directory, 'agent.jsonl');
  const host = await OpenCode.create({ database: { path: ':memory:' }, models: { fetch: false },
    config: { directory, project: false, content: '{}' }, fs: { filewatcher: false, fff: false },
    plugins: [createPlugin({ command: process.execPath, args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_LOG: log } })],
  });
  t.after(async () => { await host.close(); await delay(600); await rm(directory, { recursive: true, force: true }); });
  const logs = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const location = { directory };
  const inventory = await eventually(async () => {
    const { data } = await host.model.list({ location });
    return data.some((model) => model.providerID === 'claude-acp' && model.id === 'fixture-model') && data;
  }, 'ACP models in the native model catalog');
  assert(inventory.some((model) => model.id === 'default' && model.providerID === 'claude-acp'));
  const session = await host.sessions.create({ location, model: { providerID: 'claude-acp', id: 'fixture-model' } });
  const sessionID = session.id;
  await host.sessions.prompt({ sessionID, text: 'hello' });
  await host.sessions.wait({ sessionID });
  let context = await host.sessions.context({ sessionID });
  assert.match(JSON.stringify(context), /fixture:hello/);
  await host.sessions.prompt({ sessionID, text: 'followup' });
  await host.sessions.wait({ sessionID });
  context = await host.sessions.context({ sessionID });
  assert.match(JSON.stringify(context), /fixture:followup/);
  let prompts = (await logs()).filter((entry) => entry.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].params.sessionId, prompts[1].params.sessionId);
  assert.deepEqual(prompts[1].params.prompt, [{ type: 'text', text: 'followup' }]);
  await host.sessions.switchModel({ sessionID, model: { providerID: 'claude-acp', id: 'fixture-other' } });
  await host.sessions.prompt({ sessionID, text: 'model switched' });
  await host.sessions.wait({ sessionID });
  assert((await logs()).some((entry) => entry.method === 'session/set_config_option' && entry.params.value === 'fixture-other'));
  await host.sessions.switchModel({ sessionID, model: { providerID: 'claude-acp', id: 'default' } });
  await host.sessions.prompt({ sessionID, text: 'default restored' });
  await host.sessions.wait({ sessionID });
  assert.equal((await logs()).filter((entry) => entry.method === 'session/set_config_option').at(-1).params.value, 'fixture-model');
  for (const [answer, expected] of [['Allow once', 'yes'], ['Deny', 'no'], ['custom unexpected text', 'no']]) {
    await host.sessions.prompt({ sessionID, text: `permission ${answer}` });
    const form = await eventually(async () => (await host.session.form.list({ sessionID }))[0], 'native approval question');
    assert.match(JSON.stringify(form), /Claude ACP approval/);
    const count = (await logs()).filter((entry) => entry.method === 'session/prompt').length;
    await host.session.form.reply({ sessionID, formID: form.id, answer: { q0: answer } });
    await host.sessions.wait({ sessionID }, { signal: AbortSignal.timeout(10_000) }).catch(async (error) => {
      console.error(JSON.stringify({ logs: await logs(), context: await host.sessions.context({ sessionID }), forms: await host.session.form.list({ sessionID }) }, null, 2));
      throw error;
    });
    const entries = await logs();
    assert.equal(entries.filter((entry) => entry.method === 'session/prompt').length, count, 'approval resumes the original ACP prompt');
    assert.equal(entries.filter((entry) => entry.permissionResult).at(-1).permissionResult.outcome.optionId, expected);
  }
  await host.sessions.prompt({ sessionID, text: 'permission dismiss' });
  const dismissed = await eventually(async () => (await host.session.form.list({ sessionID }))[0], 'dismissible approval');
  await host.session.form.cancel({ sessionID, formID: dismissed.id });
  await host.sessions.wait({ sessionID });
  assert.notEqual((await logs()).filter((entry) => entry.permissionResult).at(-1).permissionResult.outcome.optionId, 'yes');

  await host.sessions.prompt({ sessionID, text: 'permission interrupt' });
  await eventually(async () => (await host.session.form.list({ sessionID }))[0], 'approval before interrupt');
  await host.sessions.interrupt({ sessionID });
  await host.sessions.wait({ sessionID });
  await eventually(async () => (await logs()).filter((entry) => entry.permissionResult).at(-1)?.permissionResult.outcome.outcome === 'cancelled', 'pending ACP permission cancelled');

  const isolated = await host.sessions.create({ location, model: { providerID: 'claude-acp', id: 'fixture-model' } });
  await host.sessions.prompt({ sessionID: isolated.id, text: 'isolated' });
  await host.sessions.wait({ sessionID: isolated.id });
  const isolatedPrompt = (await logs()).filter((entry) => entry.method === 'session/prompt').at(-1);
  assert.notEqual(isolatedPrompt.params.sessionId, prompts[0].params.sessionId);
  await host.sessions.prompt({ sessionID, text: 'hang' });
  await eventually(async () => (await logs()).some((entry) => entry.method === 'session/prompt' && entry.params.prompt.some((part) => part.text === 'hang')), 'long-running ACP prompt');
  await host.sessions.interrupt({ sessionID });
  await host.sessions.wait({ sessionID });
  await eventually(async () => (await logs()).some((entry) => entry.method === 'session/cancel'), 'ACP cancellation');
  assert((await logs()).some((entry) => entry.method === 'session/load'), 'persisted session is reloaded after interruption');
});
