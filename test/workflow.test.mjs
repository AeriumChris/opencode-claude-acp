import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/sdk';
import { Plugin } from '@opencode/plugin';
import { createPlugin } from '../dist/index.js';

test('foreground CI wait continues through publish and verification despite changing host nudges', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-workflow-'));
  const log = join(directory, 'rpc.jsonl');
  const calls = [];
  let release, status = 'success', polls = 0, step = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const host = await OpenCode.create({ database: { path: ':memory:' }, models: { fetch: false },
    config: { directory, project: false, content: '{}' }, fs: { filewatcher: false, fff: false },
    plugins: [createPlugin({ command: process.execPath, args: [resolve('test/fixtures/agent.mjs')],
      idleTimeoutMs: 50, env: { ACP_TEST_LOG: log, ACP_TEST_CONTEXT: '1000', ACP_TEST_USAGE: '1' } }),
      Plugin.define({ id: 'test.ci-workflow', async setup(ctx) {
        await ctx.tool.transform((editor) => {
          for (const name of ['ci_status', 'ci_publish', 'ci_release']) editor.add({ name,
            description: name, options: { codemode: false }, input: { type: 'object', properties: {} },
            async execute() {
              calls.push(name);
              if (name === 'ci_status') {
                if (++polls === 1) return { content: 'running' };
                await gate;
                return { content: status };
              }
              return { content: name === 'ci_publish' ? 'release created' : 'published, draft=false' };
            },
          });
        });
        await ctx.session.hook('context', (event) => {
          for (const message of event.messages) for (const part of message.content) {
            if (part.type === 'text') part.text = `${part.text.replace(/\n*$/, '')}\n\n<dcp-system-reminder>CRITICAL WARNING: MAX CONTEXT LIMIT REACHED, host step ${++step}</dcp-system-reminder>\n\n@${step}@`;
          }
        });
      } })],
  });
  t.after(async () => { release(); await host.close(); await delay(700); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const location = { directory };
  const eventually = async (fn) => {
    for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); }
    throw new Error('Workflow did not reach the expected state');
  };
  await eventually(async () => (await host.model.list({ location })).data.some((m) => m.providerID === 'claude-acp' && m.id === 'fixture-model'));
  const { id: sessionID } = await host.session.create({ location, model: { providerID: 'claude-acp', id: 'fixture-model' } });
  await host.session.prompt({ sessionID, text: 'ci-workflow' });
  await eventually(() => polls === 2);
  await delay(150); // Longer than idle eviction; a waiting host tool is still an active turn.
  assert.deepEqual(calls, ['ci_status', 'ci_status']);
  release();
  await host.session.wait({ sessionID });
  assert.deepEqual(calls, ['ci_status', 'ci_status', 'ci_publish', 'ci_release']);
  let entries = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter((e) => e.method === 'session/prompt').length, 1, 'all steps finish inside one native prompt');
  assert.equal(entries.filter((e) => e.method === 'session/load').length, 0);
  assert.match(JSON.stringify(await host.session.context({ sessionID })), /published, draft=false/);
  status = 'failure';
  polls = 0;
  calls.length = 0;
  await host.session.prompt({ sessionID, text: 'ci-workflow' });
  await host.session.wait({ sessionID });
  assert.deepEqual(calls, ['ci_status', 'ci_status'], 'failed CI never publishes');
  entries = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter((e) => e.method === 'session/prompt').length, 2);
  assert(!(await host.session.context({ sessionID })).some((message) => message.type === 'compaction'),
    'a full native context and multiple tool handoffs do not create automatic checkpoint banners');
});
