import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/sdk';
import { createPlugin } from '../dist/index.js';
import { permissionSummary, permissionChoices, allowPermission } from '../dist/permissions.js';
import { parseOptions } from '../dist/options.js';

const options = [
  { optionId: 'yes', kind: 'allow_once', name: 'Allow once' },
  { optionId: 'edit-all', kind: 'allow_always', name: 'Allow all edits in this session' },
  { optionId: 'rule', kind: 'allow_always', name: 'Always allow this command' },
  { optionId: 'no', kind: 'reject_once', name: 'Deny' },
];
const request = { toolCall: { toolCallId: 'test', title: 'Write fixture.txt', rawInput: {
  file_path: 'C:\\Working Projects\\fixture.txt', content: 'FILE_CONTENT_MARKER\n'.repeat(10_000),
} }, options };

test('approval summaries are bounded and omit payloads; only offered ACP IDs can be selected', () => {
  const summary = permissionSummary(request);
  assert(summary.length < 700);
  assert.match(summary, /Working Projects/);
  assert.doesNotMatch(summary, /FILE_CONTENT_MARKER/);
  assert.match(summary, /characters \(omitted\)/);
  const huge = permissionSummary({ ...request, toolCall: { toolCallId: 'x'.repeat(10_000),
    title: 'huge\n'.repeat(10_000), rawInput: { path: 'x'.repeat(10_000), command: 'x\n'.repeat(10_000) } } });
  assert(huge.length < 700);
  assert.equal(huge.split('\n').length, 4);
  assert.equal(permissionChoices(request).find((choice) => choice.label === 'Allow always (2)').optionId, 'rule');
  assert.deepEqual(allowPermission(request), { outcome: { outcome: 'selected', optionId: 'yes' } });
  const rejectOnly = { ...request, options: [options.at(-1)] };
  assert.deepEqual(permissionChoices(rejectOnly).map((choice) => choice.label), ['Deny']);
  assert.deepEqual(allowPermission(rejectOnly), { outcome: { outcome: 'cancelled' } });
  assert.equal(parseOptions({ permissionMode: 'allow' }).permissionMode, 'allow');
  assert.throws(() => parseOptions({ permissionMode: 'anything' }), /permissionMode/);
});

async function eventually(fn) {
  const deadline = Date.now() + 15_000;
  do { const result = await fn(); if (result) return result; await delay(50); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for approval form');
}

for (const permissionMode of ['ask', 'allow']) {
  test(`real host ACP approvals: ${permissionMode}`, { timeout: 90_000 }, async (t) => {
    const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-permissions-'));
    const log = join(directory, 'agent.jsonl');
    const host = await OpenCode.create({ database: { path: ':memory:' }, models: { fetch: false },
      config: { directory, project: false, content: '{}' }, fs: { filewatcher: false, fff: false },
      plugins: [createPlugin({ permissionMode, command: process.execPath,
        args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_LOG: log } })],
    });
    t.after(async () => { await host.close(); await delay(600); await rm(directory, { recursive: true, force: true }); });
    const logs = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
    await eventually(async () => (await host.model.list({ location: { directory } })).data
      .some((model) => model.providerID === 'claude-acp' && model.id === 'fixture-model'));
    const create = () => host.sessions.create({ location: { directory }, model: { providerID: 'claude-acp', id: 'fixture-model' } });
    const sessionID = (await create()).id;
    const prompt = (requests) => host.sessions.prompt({ sessionID, text: `permission:${JSON.stringify(requests)}` });
    const wait = () => host.sessions.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
    const answer = async (label) => {
      const form = await eventually(async () => (await host.session.form.list({ sessionID }))[0]);
      await host.session.form.reply({ sessionID, formID: form.id, answer: { q0: label } });
      return form;
    };
    if (permissionMode === 'ask') {
      await prompt([request]);
      const form = await answer('Allow always (2)');
      assert.doesNotMatch(JSON.stringify(form), /FILE_CONTENT_MARKER/);
      assert.match(JSON.stringify(form), /Always allow this command/);
      await wait();
      assert.equal((await logs()).filter((entry) => entry.permissionResult).at(-1).permissionResult.outcome.optionId, 'rule');

      await prompt([{}]);
      await answer('Allow always'); // Not offered for this request; free text must not grant it.
      await wait();
      assert.equal((await logs()).filter((entry) => entry.permissionResult).at(-1).permissionResult.outcome.optionId, 'no');

      // An always choice is adapter-owned, not a bridge-wide auto-approval.
      // Requests already queued when Allow all is selected must also be covered.
      await prompt([{}, {}, {}]);
      await answer('Allow all (session)');
      await wait();
      assert.deepEqual((await logs()).filter((entry) => entry.permissionResult).slice(-3)
        .map((entry) => entry.permissionResult.outcome.optionId), ['yes', 'yes', 'yes']);

      // Close the active connection; the session choice must survive a reload.
      await host.sessions.prompt({ sessionID, text: 'hang' });
      await eventually(async () => (await logs()).some((entry) => entry.method === 'session/prompt' && entry.params.prompt.some((part) => part.text === 'hang')));
      await host.sessions.interrupt({ sessionID });
      await wait();
    }
    await prompt([{}]);
    await wait();
    assert.equal((await logs()).filter((entry) => entry.permissionResult).at(-1).permissionResult.outcome.optionId, 'yes');
    assert.deepEqual(await host.session.form.list({ sessionID }), []);
    await prompt([{ options: [options.at(-1)] }]);
    await wait();
    assert.equal((await logs()).filter((entry) => entry.permissionResult).at(-1).permissionResult.outcome.outcome, 'cancelled');

    if (permissionMode === 'ask') {
      const isolated = (await create()).id;
      await host.sessions.prompt({ sessionID: isolated, text: 'permission isolated' });
      const form = await eventually(async () => (await host.session.form.list({ sessionID: isolated }))[0]);
      await host.session.form.reply({ sessionID: isolated, formID: form.id, answer: { q0: 'Deny' } });
      await host.sessions.wait({ sessionID: isolated });
      assert.equal((await logs()).filter((entry) => entry.permissionResult).at(-1).permissionResult.outcome.optionId, 'no');
    }
  });
}
