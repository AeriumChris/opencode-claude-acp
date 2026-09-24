import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/sdk';
import { Plugin } from '@opencode/plugin';
import { createPlugin } from '../dist/index.js';
import { screenshot } from './fixtures/image.mjs';

async function eventually(fn, description) {
  const deadline = Date.now() + 20_000;
  do { const value = await fn(); if (value) return value; await delay(50); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}

test('ACP MCP relay uses the host tool engine, hooks, MCP connections, forms, and cancellation', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-tools-'));
  const log = join(directory, 'agent.jsonl');
  const secret = randomUUID();
  const executions = [], hooks = [];
  let cancelled = false, hideProbe = false, denyQuestions = false;
  const host = await OpenCode.create({ database: { path: ':memory:' }, models: { fetch: false },
    config: { directory, project: false, content: '{}' }, fs: { filewatcher: false, fff: false },
    plugins: [createPlugin({ command: process.execPath, args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_LOG: log } }),
      Plugin.define({ id: 'test.relay-tools', async setup(ctx) {
        await ctx.mcp.transform((editor) => editor.set('fixture', { type: 'local', codemode: false,
          command: [process.execPath, resolve('test/fixtures/mcp.mjs')], environment: { FIXTURE_TOKEN: secret } }));
        await ctx.mcp.transform((editor) => editor.set('codedfixture', { type: 'local', codemode: true,
          command: [process.execPath, resolve('test/fixtures/mcp.mjs')], environment: { FIXTURE_TOKEN: secret } }));
        await ctx.tool.transform((editor) => {
          for (const name of ['probe', 'wait', 'broken', 'hidden']) editor.add({ name, description: `Test ${name}`, options: { codemode: false },
            input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            async execute(input, context) {
              executions.push({ name, input, sessionID: context.sessionID });
              if (name === 'broken') throw new Error('fixture tool failure');
              if (name === 'wait') await new Promise((_, reject) => context.signal.addEventListener('abort', () => {
                cancelled = true; reject(new Error('cancelled'));
              }, { once: true }));
              return { content: `${secret}:${input.text}` };
            },
          });
          editor.add({ name: 'image_result', description: 'Return an inline screenshot', options: { codemode: false },
            input: { type: 'object', properties: {} }, async execute() {
              return { content: [{ type: 'file', mime: 'image/png', name: 'result.png', uri: `data:image/png;base64,${screenshot().toString('base64')}` }] };
            },
          });
        });
        await ctx.session.hook('context', (event) => { delete event.tools.hidden; if (hideProbe) delete event.tools.probe; });
        await ctx.permission.hook('evaluate', (event) => { if (denyQuestions && event.action === 'question') event.effect = 'deny'; });
        await ctx.tool.hook('execute.before', (event) => {
          hooks.push({ phase: 'before', tool: event.tool, sessionID: event.sessionID });
          if (event.tool === 'probe') event.input.text += ':before';
        });
        await ctx.tool.hook('execute.after', (event) => {
          hooks.push({ phase: 'after', tool: event.tool, sessionID: event.sessionID });
          // Runs AFTER the ACP plugin; replacing result must reach Claude.
          if (event.tool === 'probe' && event.status === 'completed') event.result = {
            content: `${event.result.content.map((part) => part.text).join('')}:after`,
          };
        });
      } })],
  });
  t.after(async () => { await host.close(); await delay(700); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const location = { directory };
  await eventually(async () => (await host.model.list({ location })).data.some((model) => model.providerID === 'claude-acp' && model.id === 'fixture-model'), 'provider');
  await eventually(async () => (await host.mcp.list({ location })).data.some((item) => item.name === 'fixture' && item.status.status === 'connected'), 'upstream MCP');
  const session = await host.session.create({ location, model: { providerID: 'claude-acp', id: 'fixture-model' } });
  const sessionID = session.id;
  const logs = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const call = async (calls) => {
    await host.session.prompt({ sessionID, text: `relay:${JSON.stringify(calls)}` });
    await host.session.wait({ sessionID });
    return (await logs()).filter((entry) => entry.relayResults).at(-1).relayResults;
  };
  let results = await call([{ name: 'probe', arguments: { text: 'one' } }, { name: 'probe', arguments: { text: 'two' } }]);
  assert.match(JSON.stringify(results), new RegExp(`${secret}:one:before:after`));
  assert.match(JSON.stringify(results), /two:before:after/);
  assert.equal(executions.length, 2);
  assert(executions.every((entry) => entry.sessionID === sessionID));
  assert.equal(hooks.filter((entry) => entry.tool === 'probe').length, 4);
  assert.equal((await logs()).filter((entry) => entry.method === 'session/prompt').length, 1, 'parallel tools resume one ACP prompt');
  const nativeTools = (await host.session.context({ sessionID })).flatMap((message) => message.content ?? []).filter((part) => part.type === 'tool' && part.name === 'claude_code');
  assert.equal(nativeTools.length, 3, 'native activity spans both parallel relay handoffs');
  assert(nativeTools.every((part) => part.state.status === 'completed' && part.state.input.title === 'Call OpenCode tools'));
  assert(nativeTools.slice(0, -1).every((part) => JSON.stringify(part.state.content).includes('Native operation has not finished')));
  assert.match(JSON.stringify(nativeTools.at(-1).state.content), /OpenCode tools returned/);
  const firstServer = (await logs()).find((entry) => entry.method === 'session/new' && entry.params.mcpServers.length).params.mcpServers[0];
  assert.equal((await fetch(firstServer.url, { method: 'POST', body: '{}' })).status, 403, 'relay requires its per-session bearer');
  const other = await host.session.create({ location, model: { providerID: 'claude-acp', id: 'fixture-model' } });
  await host.session.prompt({ sessionID: other.id, text: 'relay:{"name":"probe","arguments":{"text":"isolated"}}' });
  await host.session.wait({ sessionID: other.id });
  assert.equal(executions.at(-1).sessionID, other.id);
  const otherServer = (await logs()).filter((entry) => entry.method === 'session/new' && entry.params.mcpServers.length).at(-1).params.mcpServers[0];
  assert.equal((await fetch(otherServer.url, { method: 'POST', headers: { Authorization: firstServer.headers[0].value }, body: '{}' })).status, 403);
  results = await call({ name: 'fixture_echo', arguments: { text: 'upstream' } });
  assert.match(JSON.stringify(results), new RegExp(`${secret}:upstream`));
  assert(hooks.some((entry) => entry.tool === 'fixture_echo'));
  results = await call({ name: 'execute', arguments: { code: 'return search({namespace: "codedfixture"});' } });
  const path = JSON.stringify(results).match(/tools\.codedfixture(?:\[\\"echo\\"\]|\.echo)/)?.[0].replaceAll('\\"', '"');
  assert(path, `Code Mode search should discover the upstream tool: ${JSON.stringify(results)}`);
  results = await call({ name: 'execute', arguments: { code: `return await ${path}({text: "code-mode"});` } });
  assert.match(JSON.stringify(results), new RegExp(`${secret}:code-mode`));
  results = await call({ name: 'image_result', arguments: {} });
  assert.equal(results[0].content[0].type, 'image');
  assert.equal(results[0].content[0].data, screenshot().toString('base64'));
  results = await call({ name: 'hidden', arguments: { text: 'no' } });
  assert.equal(results[0].isError, true);
  assert(!executions.some((entry) => entry.name === 'hidden'));
  results = await call({ name: 'broken', arguments: { text: 'error' } });
  assert.equal(results[0].isError, true);
  assert.match(JSON.stringify(results), /fixture tool failure/);
  await host.session.prompt({ sessionID, text: `relay:${JSON.stringify({ name: 'question', arguments: { questions: [{ header: 'Plugin question', question: 'Select a color', options: [{ label: 'Blue', description: 'Blue color' }] }] } })}` });
  const form = await eventually(async () => (await host.session.form.list({ sessionID }))[0], 'relayed question');
  await host.session.form.reply({ sessionID, formID: form.id, answer: { q0: 'Blue' } });
  await host.session.wait({ sessionID });
  assert.match(JSON.stringify((await logs()).filter((entry) => entry.relayResults).at(-1)), /Blue/);
  denyQuestions = true;
  results = await call({ name: 'question', arguments: { questions: [{ header: 'Denied', question: 'No approval', options: [{ label: 'Yes', description: 'Yes' }] }] } });
  assert.equal(results[0].isError, true, 'native permission denial reaches Claude');
  assert.equal((await host.session.form.list({ sessionID })).length, 0);
  hideProbe = true;
  const loads = (await logs()).filter((entry) => entry.method === 'session/load').length;
  results = await call({ name: 'probe', arguments: { text: 'removed' } });
  assert.equal(results[0].isError, true);
  assert((await logs()).filter((entry) => entry.method === 'session/load').length > loads, 'changed catalogs reconnect the native MCP client');
  await host.session.prompt({ sessionID, text: `relay:${JSON.stringify({ name: 'wait', arguments: { text: 'cancel me' } })}` });
  await eventually(() => executions.some((entry) => entry.name === 'wait'), 'long-running host tool');
  await host.session.interrupt({ sessionID });
  await host.session.wait({ sessionID });
  assert(cancelled, 'stopping ACP interrupts the actual host tool');
  const server = (await logs()).find((entry) => entry.method === 'session/new' && entry.params.mcpServers.length).params.mcpServers[0];
  assert.equal(server.name, 'opencode');
  assert(!JSON.stringify(server).includes(secret), 'upstream credentials are not passed to Claude');
});
