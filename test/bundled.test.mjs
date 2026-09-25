import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/client';
import { screenshot } from './fixtures/image.mjs';

// Opt in with the actual release executable: SDK tests share the plugin's modules
// and cannot establish compatibility with a compiled host's class identities.
test('bundled host continues image checkpoints and reloads their archived history', {
  skip: !process.env.OPENCODE_TEST_EXECUTABLE, timeout: 120_000,
}, async (t) => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-bundled-'));
  const log = join(directory, 'agent.jsonl');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  let output = '';
  let password;
  const stop = async () => {
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  };
  t.after(async () => { await stop(); await delay(700); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  const eventually = async (fn, description) => {
    const deadline = Date.now() + 30_000;
    do {
      const value = await fn();
      if (value) return value;
      if (server.exitCode !== null) throw new Error(`Server exited: ${output.slice(-2000)}`);
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${description}. ${output.slice(-2000)}`);
  };
  const start = async (auto = false) => {
    output = '';
    password = undefined;
    server = spawn(process.env.OPENCODE_TEST_EXECUTABLE, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: directory, windowsHide: true,
      env: { ...process.env,
        XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
        XDG_STATE_HOME: join(directory, 'state'), XDG_CACHE_HOME: join(directory, 'cache'),
        OPENCODE_CONFIG_DIR: join(directory, 'config', 'opencode'), OPENCODE_DB: join(directory, 'host.db'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ compaction: { auto, tokens: 1 }, plugins: [
          { package: pathToFileURL(resolve('test/fixtures/plain-messages')).href }, {
          package: pathToFileURL(resolve('.')).href,
          options: { command: process.execPath, args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_LOG: log, ...(auto ? { ACP_TEST_CONTEXT: '1000' } : {}) } },
        }] }),
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let startup = '';
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => {
      startup = (startup + chunk).slice(-8000);
      password = startup.match(/server password ([^\s]+)/)?.[1] ?? password;
      output = startup.replace(/server password [^\r\n]*/g, 'server password [redacted]');
    });
    const headers = () => ({ authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` });
    await eventually(async () => password && fetch(`${baseUrl}/api/info`, { headers: headers() }).then((r) => r.ok).catch(() => false), 'private server startup');
    const client = OpenCode.make({ baseUrl, headers: headers() });
    await eventually(async () => (await client.model.list({ location: { directory } })).data.some((m) => m.providerID === 'claude-acp' && m.id === 'fixture-model'), 'fixture model discovery');
    return client;
  };
  let client = await start();
  const logs = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  const prompts = async () => (await logs()).filter((entry) => entry.method === 'session/prompt');
  const say = async (sessionID, text, files) => {
    const before = (await readFile(log, 'utf8').catch(() => '')).split('\n').length;
    await client.session.prompt({ sessionID, text, ...(files ? { files } : {}) });
    await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
    const session = await client.session.get({ sessionID });
    assert.notEqual(session.outcome, 'failed', `Bundled session failed after ${text}`);
    assert((await readFile(log, 'utf8')).split('\n').length > before, 'request reaches ACP');
  };
  const { id: sessionID } = await client.session.create({ location: { directory }, model: { providerID: 'claude-acp', id: 'fixture-model' } });
  const image = screenshot().toString('base64');
  await say(sessionID, 'Keep the screenshot.', [{ uri: `data:image/png;base64,${image}`, name: 'screen.png' }]);
  assert((JSON.parse(await readFile(join(directory, 'plain-hook.json'), 'utf8'))).count > 0, 'the prior context hook ran');
  const nativeID = (await prompts()).at(-1).params.sessionId;
  await say(sessionID, 'Second message.');
  await client.session.compact({ sessionID });
  await client.session.wait({ sessionID });
  assert((await client.session.context({ sessionID })).some((m) => m.type === 'compaction' && m.status === 'completed' && m.summary === ''));
  await say(sessionID, 'Continue after checkpoint.');
  assert.deepEqual((await prompts()).at(-1).params, { sessionId: nativeID, prompt: [{ type: 'text', text: 'Continue after checkpoint.' }] });
  await stop();
  client = await start(true);
  await say(sessionID, 'Continue after restart.');
  assert.deepEqual((await prompts()).at(-1).params, { sessionId: nativeID, prompt: [{ type: 'text', text: 'Continue after restart.' }] });
  assert.equal((await client.model.list({ location: { directory } })).data.find((m) => m.providerID === 'claude-acp' && m.id === 'fixture-model')?.limit.context, 0, 'native capacity does not enable host compaction');
  const question = { name: 'question', arguments: { questions: [{ header: 'Checkpoint test', question: 'Choose a value', options: [{ label: 'Blue', description: 'Blue' }] }] } };
  await client.session.prompt({ sessionID, text: `relay:${JSON.stringify(question)}` });
  const form = await eventually(async () => (await client.session.form.list({ sessionID }))[0], 'relayed question');
  const beforeRelay = (await prompts()).length;
  const checkpointID = (await client.session.context({ sessionID })).find((m) => m.type === 'compaction')?.id;
  await client.session.form.reply({ sessionID, formID: form.id, answer: { q0: 'Blue' } });
  await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(30_000) });
  assert.notEqual((await client.session.get({ sessionID })).outcome, 'failed');
  const checkpoint = (await client.session.context({ sessionID })).find((m) => m.type === 'compaction');
  assert.equal(checkpoint?.id, checkpointID, 'no automatic checkpoint banner appears during the tool handoff');
  assert.equal(checkpoint?.status, 'completed');
  assert.equal((await prompts()).length, beforeRelay, 'tool result resumes the same native prompt');
  assert.match(JSON.stringify((await logs()).filter((e) => e.relayResults).at(-1)), /Blue/);
  const fork = await client.session.fork({ sessionID });
  await say(fork.id, 'Continue in fork.');
  const sent = (await prompts()).at(-1).params.prompt;
  assert.deepEqual(sent.filter((part) => part.type === 'image'), [{ type: 'image', data: image, mimeType: 'image/png' }]);
  assert.match(JSON.stringify(sent), /Keep the screenshot/);
});
