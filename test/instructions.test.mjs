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

for (const integrationMode of ['opencode', 'native']) test(`${integrationMode}: host instructions and scoped guidance survive tool continuations`, { timeout: 90_000 }, async (t) => {
  const temp = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-instructions-'));
  const directory = join(temp, 'repo'), config = join(temp, 'config'), log = join(temp, 'rpc.jsonl');
  await mkdir(join(directory, 'nested'), { recursive: true });
  await mkdir(config);
  execFileSync('git', ['init', '--quiet', directory]);
  await writeFile(join(config, 'AGENTS.md'), 'GLOBAL_RULE_TOKEN');
  await writeFile(join(directory, 'AGENTS.md'), 'ROOT_RULE_TOKEN');
  await writeFile(join(directory, 'nested', 'AGENTS.md'), 'NESTED_RULE_TOKEN: use this only within nested/.');
  await writeFile(join(directory, 'nested', 'file.txt'), 'example');
  let lateInstruction = 'LATE_PLUGIN_INSTRUCTION';
  const host = await OpenCode.create({ database: { path: ':memory:' }, models: { fetch: false },
    config: { directory: config, content: JSON.stringify({ agents: {
      reviewer: { system: 'CUSTOM_AGENT_TOKEN' },
      build: { permissions: [{ action: 'edit', resource: '*', effect: 'allow' }] },
    } }) },
    fs: { filewatcher: false, fff: false },
    plugins: [createPlugin({ ...(integrationMode === 'opencode' ? { integrationMode } : {}), command: process.execPath, args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_LOG: log, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } }),
      Plugin.define({ id: 'test.instructions', async setup(ctx) {
          await ctx.session.hook('context', (event) => {
            event.system.push({ type: 'text', text: lateInstruction });
            if (integrationMode === 'opencode') delete event.tools.question;
          });
      } })],
  });
  t.after(async () => { await host.close(); await delay(700); await rm(temp, { recursive: true, force: true, maxRetries: 5 }); });
  const location = { directory };
  for (let i = 0; i < 100; i++) {
    const models = await host.model.list({ location }).catch((error) => {
      if (error._tag === 'ServiceUnavailableError' && error.service === 'plugin') return { data: [] };
      throw error;
    });
    if (models.data.some((item) => item.providerID === 'claude-acp' && item.id === 'fixture-model')) break;
    await delay(100);
  }
  const { id: sessionID } = await host.session.create({ location, agent: 'reviewer', model: { providerID: 'claude-acp', id: 'fixture-model' } });
  const logs = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const prompt = async (text) => {
    await host.session.prompt({ sessionID, text });
    await host.session.wait({ sessionID }, { signal: AbortSignal.timeout(15_000) });
  };
  await prompt('hello');
  const initial = (await logs()).find((entry) => entry.method === 'session/new' && entry.params.mcpServers.length);
  const system = integrationMode === 'native' ? initial.params._meta.systemPrompt.append : initial.params._meta.systemPrompt;
  assert.match(system, /read the repository AGENTS.md/);
  assert.match(system, /foreground shell calls/);
  assert.match(system, /verify its published status before ending the turn/);
  const environments = (await logs()).filter((entry) => Object.hasOwn(entry, 'backgroundTasksDisabled'));
  assert(environments.length > 0);
  assert(environments.every((entry) => entry.backgroundTasksDisabled === '1'), 'native background work stays disabled even with a conflicting env option');
  for (const token of ['CUSTOM_AGENT_TOKEN', 'ROOT_RULE_TOKEN', 'GLOBAL_RULE_TOKEN', 'LATE_PLUGIN_INSTRUCTION']) {
    assert.equal(system.includes(token), integrationMode === 'opencode', `host system content ${token} follows integration mode`);
  }
  if (integrationMode === 'native') assert.equal(initial.params._meta.claudeCode, undefined);
  else assert.deepEqual(initial.params._meta.claudeCode.options, {
    tools: [], strictMcpConfig: true, allowedTools: ['mcp__opencode__*'],
  }, 'only the host MCP relay is available; it retains host permission checks');
  await prompt(`relay:${JSON.stringify({ name: 'read', arguments: { path: 'AGENTS.md' } })}`);
  assert.match(JSON.stringify((await logs()).filter((entry) => entry.relayResults).at(-1)), /ROOT_RULE_TOKEN/);
  await prompt(`relay:${JSON.stringify({ name: 'read', arguments: { path: 'nested/file.txt' } })}`);
  let entries = await logs();
  assert.equal(entries.filter((entry) => entry.method === 'session/prompt').length, 3, 'nested guidance does not replay the active prompt');
  assert.match(JSON.stringify(entries.filter((entry) => entry.relayResults).at(-1)), /NESTED_RULE_TOKEN/, 'nested guidance reaches Claude with the read result');
  await prompt('followup');
  entries = await logs();
  assert.equal(new Set(entries.filter((entry) => entry.effective).map((entry) => entry.effective.sessionId)).size, 1);
  if (integrationMode === 'native') assert.equal(entries.filter((entry) => entry.method === 'session/load').length, 0);
  assert.equal(entries.filter((entry) => entry.method === 'session/prompt').length, 4);
  assert.deepEqual(entries.filter((entry) => entry.method === 'session/prompt').at(-1).params.prompt, [{ type: 'text', text: 'followup' }]);
  for (const entry of entries.filter((entry) => entry.method === 'session/prompt')) {
    for (const token of ['CUSTOM_AGENT_TOKEN', 'GLOBAL_RULE_TOKEN', 'LATE_PLUGIN_INSTRUCTION']) {
      assert(!JSON.stringify(entry.params.prompt).includes(token), `${token} is never downgraded to user text`);
    }
  }
  if (integrationMode === 'native') return;
  lateInstruction = 'REVISED_PLUGIN_INSTRUCTION';
  await host.session.switchAgent({ sessionID, agent: 'plan' });
  await prompt('plan the next change');
  entries = await logs();
  const resumed = entries.filter((entry) => entry.method === 'session/load').at(-1);
  assert(resumed, 'switching instructions reloads Claude with the same saved history');
  assert.equal(resumed.params.sessionId, entries.find((entry) => entry.effective).effective.sessionId);
  assert.match(resumed.params._meta.systemPrompt, /REVISED_PLUGIN_INSTRUCTION/);
  assert(!resumed.params._meta.systemPrompt.includes('CUSTOM_AGENT_TOKEN'), 'previous agent system prompt is replaced');
  assert(!resumed.params._meta.systemPrompt.includes('LATE_PLUGIN_INSTRUCTION'), 'previous plugin system prompt is replaced');
  assert.deepEqual(resumed.params._meta.claudeCode.options.tools, []);
  assert.equal(entries.filter((entry) => entry.method === 'session/prompt').length, 5, 'switching agents does not replay prompts');
  const write = `relay:${JSON.stringify({ name: 'write', arguments: { path: 'mode-check.txt', content: 'host write' } })}`;
  await prompt(write);
  let result = (await logs()).filter((entry) => entry.relayResults).at(-1).relayResults[0];
  assert.equal(result.isError, true, 'Plan denies writes through the host tool engine');
  await assert.rejects(readFile(join(directory, 'mode-check.txt')), { code: 'ENOENT' });
  await host.session.switchAgent({ sessionID, agent: 'build' });
  // Consume the host's plan-exit reminder before the fixture's JSON-only command.
  await prompt('back to build');
  await prompt(write);
  result = (await logs()).filter((entry) => entry.relayResults).at(-1).relayResults[0];
  assert(!result.isError, JSON.stringify(result));
  assert.equal(await readFile(join(directory, 'mode-check.txt'), 'utf8'), 'host write', 'Build retains host file tools without requiring question');
});
