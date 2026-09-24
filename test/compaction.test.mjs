import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/sdk';
import { Plugin } from '@opencode/plugin';
import { Model } from '@opencode/schema/model';
import { Provider } from '@opencode/schema/provider';
import { createPlugin } from '../dist/index.js';
import { Checkpoints } from '../dist/compaction.js';
import { screenshot } from './fixtures/image.mjs';

async function eventually(fn, description) {
  const deadline = Date.now() + 15_000;
  do { const value = await fn(); if (value) return value; await delay(50); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}

test('checkpoint restoration rejects missing or circular archives instead of losing history', async () => {
  const values = new Map();
  const checkpoints = new Checkpoints({ get: async (key) => values.get(key), set: async (key, value) => { values.set(key, value); } });
  const user = { type: 'user', id: 'msg_original', time: { created: 1 }, text: 'Keep the original request.' };
  const result = await checkpoints.create(checkpoints.history([user]));
  const raw = { type: 'compaction', id: 'msg_checkpoint', time: { created: 2 }, status: 'completed', reason: 'auto', recent: '', ...result };
  const history = checkpoints.history([raw]);
  assert.equal((await checkpoints.expand(history))[0].text, user.text);
  values.clear();
  await assert.rejects(checkpoints.expand(history), /history is unavailable/);
  values.set(result.metadata.claudeAcpCheckpoint, [raw]);
  await assert.rejects(checkpoints.expand(history), /circular history reference/);
});

test('real host checkpoints preserve pending prompts, attachments, restart continuity, forks and reverts', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-compaction-'));
  const log = join(directory, 'agent.jsonl');
  const database = join(directory, 'host.db');
  const compactions = [];
  let simulateOldFailure = false;
  let host;
  const start = async (auto = false, noLoad = false) => {
    host = await OpenCode.create({ database: { path: database }, models: { fetch: false },
      config: { directory, project: false, content: JSON.stringify({ compaction: { auto, tokens: 1 } }) },
      fs: { filewatcher: false, fff: false }, plugins: [createPlugin({ command: process.execPath,
        args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_LOG: log, ...(auto ? { ACP_TEST_CONTEXT: '1000' } : {}), ...(noLoad ? { ACP_TEST_NO_LOAD: '1' } : {}) } }),
        Plugin.define({ id: 'test.checkpoint-observer', async setup(ctx) {
          await ctx.session.hook('compaction', (event) => {
            compactions.push({ sessionID: event.sessionID, supplied: !!event.result });
            if (simulateOldFailure) { simulateOldFailure = false; throw new Error('Simulated old plugin compaction failure'); }
          });
          await ctx.provider.transform((editor) => editor.add({
            info: { ...Provider.Info.empty('checkpoint-fixture'), activation: 'enabled',
              package: pathToFileURL(resolve('test/fixtures/provider.mjs')).href, settings: { log } },
            models: [{ ...Model.Info.default('checkpoint-fixture', 'fixture'), capabilities: { tools: true, input: ['text', 'image'], output: ['text'] } }],
          }));
        } })] });
    await eventually(async () => (await host.model.list({ location: { directory } })).data.some((m) => m.providerID === 'claude-acp' && m.id === 'fixture-model'), 'fixture discovery');
  };
  t.after(async () => { await host?.close(); await delay(700); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const logs = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const prompts = async () => (await logs()).filter((e) => e.method === 'session/prompt');
  const wait = async (sessionID) => {
    await host.sessions.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
    const context = await host.sessions.context({ sessionID });
    assert(!context.some((m) => m.type === 'compaction' && m.status !== 'completed'), JSON.stringify(context));
    assert(!context.some((m) => m.type === 'idle' && m.outcome === 'failed'), JSON.stringify({ context, session: await host.sessions.get({ sessionID }) }));
    return context;
  };
  const say = async (sessionID, text, files) => {
    const input = await host.sessions.prompt({ sessionID, text, ...(files ? { files } : {}) });
    await wait(sessionID);
    return input;
  };
  const compact = async (sessionID) => {
    const count = (await prompts()).length;
    await host.sessions.compact({ sessionID });
    const context = await wait(sessionID);
    const checkpoint = context.find((m) => m.type === 'compaction');
    assert.equal(checkpoint?.status, 'completed', JSON.stringify(context));
    assert(checkpoint.metadata.claudeAcpCheckpoint.startsWith('checkpoint/'));
    assert.equal((await prompts()).length, count, 'checkpoint does not prompt Claude');
    return checkpoint;
  };
  await start();
  const { id: sessionID } = await host.sessions.create({ location: { directory }, model: { providerID: 'claude-acp', id: 'fixture-model' } });
  const image = screenshot().toString('base64');
  const file = join(directory, 'notes.txt');
  await writeFile(file, 'Original attachment contents.');
  await say(sessionID, 'Keep this image and attachment.', [{ uri: `data:image/png;base64,${image}`, name: 'screen.png' }, { uri: pathToFileURL(file).href, name: 'notes.txt' }]);
  const nativeID = (await prompts()).at(-1).params.sessionId;
  await say(sessionID, 'Second original message.');
  await compact(sessionID);
  await say(sessionID, 'After first checkpoint.');
  assert.deepEqual((await prompts()).at(-1).params, { sessionId: nativeID, prompt: [{ type: 'text', text: 'After first checkpoint.' }] });
  await compact(sessionID);
  await host.close(); host = undefined;
  await start();
  await say(sessionID, 'After service restart.');
  assert((await logs()).some((e) => e.method === 'session/load' && e.params.sessionId === nativeID));
  assert.deepEqual((await prompts()).at(-1).params, { sessionId: nativeID, prompt: [{ type: 'text', text: 'After service restart.' }] });

  const fork = await host.sessions.fork({ sessionID });
  await say(fork.id, 'Continue the fork.');
  const forkPrompt = (await prompts()).at(-1).params;
  assert.notEqual(forkPrompt.sessionId, nativeID);
  assert.match(JSON.stringify(forkPrompt.prompt), /Prior conversation, supplied as historical context/);
  assert.match(JSON.stringify(forkPrompt.prompt), /Original attachment contents/);
  assert.match(JSON.stringify(forkPrompt.prompt), /Second original message/);
  assert(forkPrompt.prompt.some((p) => p.type === 'image' && p.data === image));
  assert.equal(forkPrompt.prompt.at(-1).text, 'Continue the fork.');
  await host.sessions.switchModel({ sessionID: fork.id, model: { providerID: 'checkpoint-fixture', id: 'fixture' } });
  await say(fork.id, 'Continue with another provider.');
  const switched = (await logs()).filter((e) => e.otherProvider).at(-1).otherProvider;
  assert.match(JSON.stringify(switched), /Original attachment contents|Second original message/);
  assert.doesNotMatch(JSON.stringify(switched), /Claude ACP checkpoint\./);
  await host.sessions.compact({ sessionID: fork.id });
  await wait(fork.id);
  const summarized = (await logs()).filter((e) => e.otherProvider).at(-1).otherProvider;
  assert.match(JSON.stringify(summarized), /Second original message/);
  assert.equal(compactions.at(-1).supplied, false, 'other providers retain normal summarization');
  const discard = await say(sessionID, 'Discard this later.');
  await say(sessionID, 'Also discard.');
  await host.session.revert.stage({ sessionID, messageID: discard.id, files: false });
  await host.session.revert.commit({ sessionID });
  await say(sessionID, 'Replacement after revert.');
  const reverted = (await prompts()).at(-1).params;
  assert.notEqual(reverted.sessionId, nativeID, 'revert still resets native history');
  assert.match(JSON.stringify(reverted.prompt), /Second original message/);
  assert.doesNotMatch(JSON.stringify(reverted.prompt), /Discard this later|Also discard/);

  await host.close(); host = undefined;
  await start(true);
  // A tiny advertised context triggers actual automatic host compaction. The
  // newest user is admitted before compaction and must still reach Claude once.
  await say(sessionID, 'Enable small native context.');
  await eventually(async () => (await host.model.list({ location: { directory } })).data.find((m) => m.providerID === 'claude-acp' && m.id === 'fixture-model')?.limit.context === 1000, 'small context published');
  simulateOldFailure = true;
  await host.sessions.prompt({ sessionID, text: 'Pending before old compaction failure.' });
  await host.sessions.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
  assert((await host.sessions.context({ sessionID })).some((m) => m.type === 'compaction' && m.status === 'running'), 'reproduce the old stuck automatic checkpoint');
  const beforeAuto = (await prompts()).length;
  await say(sessionID, 'Pending across automatic compaction.');
  assert.equal((await prompts()).length, beforeAuto + 1);
  assert.deepEqual((await prompts()).at(-1).params.prompt, [
    { type: 'text', text: 'Pending before old compaction failure.' },
    { type: 'text', text: 'Pending across automatic compaction.' },
  ]);
  assert((await host.sessions.context({ sessionID })).some((m) => m.type === 'compaction' && m.reason === 'auto' && m.status === 'completed'));
  // Compact between a real ACP approval handoff and its resumed host step.
  await host.sessions.prompt({ sessionID, text: 'permission after checkpoint' });
  const form = await eventually(async () => (await host.session.form.list({ sessionID }))[0], 'approval');
  const beforeApproval = (await prompts()).length;
  const beforeApprovalCompactions = compactions.length;
  await host.session.form.reply({ sessionID, formID: form.id, answer: { q0: 'Allow once' } });
  await wait(sessionID);
  assert.equal((await prompts()).length, beforeApproval, 'approval resumes original native turn through compaction');
  assert(compactions.length > beforeApprovalCompactions, 'host really compacted at the approval continuation');
  assert.equal((await logs()).filter((e) => e.permissionResult).at(-1).permissionResult.outcome.optionId, 'yes');

  const question = { name: 'question', arguments: { questions: [{ header: 'Compaction test', question: 'Choose a value', options: [{ label: 'Blue', description: 'Blue' }] }] } };
  await host.sessions.prompt({ sessionID, text: `relay:${JSON.stringify(question)}` });
  const relayForm = await eventually(async () => (await host.session.form.list({ sessionID }))[0], 'relayed question');
  const beforeRelay = (await prompts()).length;
  const beforeRelayCompactions = compactions.length;
  await host.session.form.reply({ sessionID, formID: relayForm.id, answer: { q0: 'Blue' } });
  await wait(sessionID);
  assert(compactions.length > beforeRelayCompactions, 'host really compacted at the relay continuation');
  assert.equal((await prompts()).length, beforeRelay);
  assert.match(JSON.stringify((await logs()).filter((e) => e.relayResults).at(-1)), /Blue/);
  assert.doesNotMatch(JSON.stringify((await logs()).filter((e) => e.relayResults).at(-1)), /did not complete/);

  await host.close(); host = undefined;
  await start(false, true);
  await say(sessionID, 'Continue without native session loading.');
  const cold = (await prompts()).at(-1).params.prompt;
  assert.match(JSON.stringify(cold), /Original attachment contents/);
  assert(cold.some((p) => p.type === 'image' && p.data === image));
  assert.equal(cold.at(-1).text, 'Continue without native session loading.');
});
