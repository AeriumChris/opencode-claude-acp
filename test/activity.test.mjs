import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('native tool activity is visible before completion, survives host handoffs, and settles on cancellation', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-activity-'));
  const host = await OpenCode.create({ database: { path: ':memory:' }, models: { fetch: false },
    config: { directory, project: false, content: JSON.stringify({ permissions: [{ action: '*', resource: '*', effect: 'ask' }] }) }, fs: { filewatcher: false, fff: false },
    plugins: [createPlugin({ command: process.execPath, args: [resolve('test/fixtures/agent.mjs')] })],
  });
  t.after(async () => { await host.close(); await delay(600); await rm(directory, { recursive: true, force: true }); });
  const location = { directory };
  await eventually(async () => (await host.model.list({ location })).data.some((model) => model.providerID === 'claude-acp' && model.id === 'fixture-model'), 'provider discovery');
  for (const mode of ['complete', 'permission', 'cancel', 'missing']) {
    const { id: sessionID } = await host.sessions.create({ location, model: { providerID: 'claude-acp', id: 'fixture-model' } });
    const gate = join(directory, mode);
    const context = () => host.sessions.context({ sessionID });
    const tools = async () => (await context()).flatMap((message) => message.content ?? []).filter((part) => part.type === 'tool');
    await host.sessions.prompt({ sessionID, text: `activity:${JSON.stringify({ gate, mode })}` });
    await eventually(async () => {
      const tool = (await tools()).find((part) => part.id === 'claude_activity-build');
      return tool?.state.status === 'streaming' && JSON.parse(tool.state.input || '{}').title === 'Build';
    }, `${mode}: pending activity visible while native input is being prepared`);
    await writeFile(`${gate}.input`, 'release');
    const running = await eventually(async () => {
      const parts = await tools();
      return parts.filter((part) => part.state.status === 'running').length === 2 && parts;
    }, `${mode}: both native tools running before the fixture is released`).catch(async (error) => {
      console.error(JSON.stringify(await context(), null, 2));
      throw error;
    });
    const build = running.find((part) => part.id === 'claude_activity-build');
    assert.equal(build.state.input.title, 'Build desktop tests');
    assert.equal(build.name, 'shell');
    assert.equal(build.state.input.command, 'cmake --build fixture');
    const read = running.find((part) => part.id === 'claude_activity-check');
    assert.equal(read.name, 'read');
    assert.equal(read.state.input.path, 'fixture.txt');
    assert.match(JSON.stringify(await context()), /Fixture thinking\./);
    if (mode === 'cancel') await host.sessions.interrupt({ sessionID });
    else {
      await writeFile(gate, 'release');
      if (mode === 'permission') {
        const request = await eventually(async () => (await host.permission.list({ sessionID }))[0], 'native permission');
        assert.deepEqual(await host.session.form.list({ sessionID }), []);
        assert.equal((await tools()).filter((part) => part.state.status === 'running').length, 2);
        await host.permission.reply({ sessionID, requestID: request.id, decision: 'once' });
      }
    }
    await host.sessions.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
    const finished = await tools();
    assert(finished.every((part) => ['completed', 'error'].includes(part.state.status)), `${mode}: no stranded native tools`);
    const builds = finished.filter((part) => part.id.startsWith('claude_activity-build'));
    assert.equal(builds.length, 1, 'permission replies do not duplicate native activity');
    assert(builds.every((part) => part.state.input.title === 'Build desktop tests'));
    if (mode === 'cancel' || mode === 'missing') assert.equal(builds.at(-1).state.status, 'error');
    else {
      assert.equal(builds.at(-1).state.status, 'completed');
      assert.match(JSON.stringify(builds.at(-1)), /build succeeded/);
      assert.equal(finished.findLast((part) => part.id.startsWith('claude_activity-check')).state.status, 'error');
    }
  }
});
