import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/sdk';
import { Plugin } from '@opencode/plugin';
import { createPlugin } from '../dist/index.js';

test('AGENTS.md reads deliver scoped guidance without forwarding host agent prompts', { timeout: 90_000 }, async (t) => {
  const temp = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-instructions-'));
  const directory = join(temp, 'repo'), config = join(temp, 'config'), log = join(temp, 'rpc.jsonl');
  await mkdir(join(directory, 'nested'), { recursive: true });
  await mkdir(config);
  execFileSync('git', ['init', '--quiet', directory]);
  await writeFile(join(config, 'AGENTS.md'), 'GLOBAL_RULE_TOKEN');
  await writeFile(join(directory, 'AGENTS.md'), 'ROOT_RULE_TOKEN');
  await writeFile(join(directory, 'nested', 'AGENTS.md'), 'NESTED_RULE_TOKEN: use this only within nested/.');
  await writeFile(join(directory, 'nested', 'file.txt'), 'example');
  const host = await OpenCode.create({ database: { path: ':memory:' }, models: { fetch: false },
    config: { directory: config, content: JSON.stringify({ agents: { reviewer: { system: 'CUSTOM_AGENT_TOKEN' } } }) },
    fs: { filewatcher: false, fff: false },
    plugins: [createPlugin({ command: process.execPath, args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_LOG: log, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } }),
      Plugin.define({ id: 'test.instructions', async setup(ctx) {
         await ctx.session.hook('context', (event) => { event.system.push({ type: 'text', text: 'LATE_PLUGIN_INSTRUCTION' }); });
      } })],
  });
  t.after(async () => { await host.close(); await delay(700); await rm(temp, { recursive: true, force: true, maxRetries: 5 }); });
  const location = { directory };
  for (let i = 0; i < 100; i++) {
    if ((await host.model.list({ location })).data.some((item) => item.providerID === 'claude-acp' && item.id === 'fixture-model')) break;
    await delay(100);
  }
  const { id: sessionID } = await host.session.create({ location, agent: 'reviewer', model: { providerID: 'claude-acp', id: 'fixture-model' } });
  const logs = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const prompt = async (text) => { await host.session.prompt({ sessionID, text }); await host.session.wait({ sessionID }); };
  await prompt('hello');
  const initial = (await logs()).find((entry) => entry.method === 'session/new' && entry.params.mcpServers.length);
  assert.match(initial.params._meta.systemPrompt.append, /read the repository AGENTS.md/);
  assert.match(initial.params._meta.systemPrompt.append, /foreground shell calls/);
  assert.match(initial.params._meta.systemPrompt.append, /verify its published status before ending the turn/);
  const environments = (await logs()).filter((entry) => Object.hasOwn(entry, 'backgroundTasksDisabled'));
  assert(environments.length > 0);
  assert(environments.every((entry) => entry.backgroundTasksDisabled === '1'), 'native background work stays disabled even with a conflicting env option');
  for (const token of ['CUSTOM_AGENT_TOKEN', 'ROOT_RULE_TOKEN', 'GLOBAL_RULE_TOKEN', 'LATE_PLUGIN_INSTRUCTION']) {
    assert(!initial.params._meta.systemPrompt.append.includes(token), `host system content ${token} is not forwarded`);
  }
  assert.equal(initial.params._meta.claudeCode, undefined, 'no native mode/tool restriction overrides');
  await prompt(`relay:${JSON.stringify({ name: 'read', arguments: { path: 'AGENTS.md' } })}`);
  assert.match(JSON.stringify((await logs()).filter((entry) => entry.relayResults).at(-1)), /ROOT_RULE_TOKEN/);
  await prompt(`relay:${JSON.stringify({ name: 'read', arguments: { path: 'nested/file.txt' } })}`);
  let entries = await logs();
  assert.equal(entries.filter((entry) => entry.method === 'session/prompt').length, 3, 'nested guidance does not replay the active prompt');
  assert.match(JSON.stringify(entries.filter((entry) => entry.relayResults).at(-1)), /NESTED_RULE_TOKEN/, 'nested guidance reaches Claude with the read result');
  await prompt('followup');
  entries = await logs();
  assert.equal(new Set(entries.filter((entry) => entry.effective).map((entry) => entry.effective.sessionId)).size, 1);
  assert.equal(entries.filter((entry) => entry.method === 'session/load').length, 0, 'file guidance does not reconnect native session');
  assert.equal(entries.filter((entry) => entry.method === 'session/prompt').length, 4);
  assert.deepEqual(entries.filter((entry) => entry.method === 'session/prompt').at(-1).params.prompt, [{ type: 'text', text: 'followup' }]);
  for (const token of ['CUSTOM_AGENT_TOKEN', 'GLOBAL_RULE_TOKEN', 'LATE_PLUGIN_INSTRUCTION']) {
    assert(!JSON.stringify(entries).includes(token), `unrelated host instructions ${token} never reach ACP`);
  }
});
