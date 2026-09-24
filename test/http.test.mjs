import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Effect } from 'effect';
import { ServerProcess } from '@opencode/server/process';
import { OpenCode } from '@opencode/client';

test('HTTP clients share the provider catalog, session output, and approval forms', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-http-'));
  const password = randomUUID();
  const log = join(directory, 'agent.jsonl');
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const server = yield* ServerProcess.start({ hostname: '127.0.0.1', port: 0, password,
        database: { path: ':memory:' }, models: { fetch: false }, fs: { filewatcher: false, fff: false },
        config: { directory, project: false, content: JSON.stringify({ plugins: [{
          package: pathToFileURL(resolve('.')).href,
          options: { command: process.execPath, args: [resolve('test/fixtures/agent.mjs')], env: { ACP_TEST_LOG: log } },
        }] }) },
      });
      yield* Effect.promise(async () => {
        const baseUrl = `http://127.0.0.1:${server.address.port}`;
        assert.equal((await fetch(`${baseUrl}/api/info`)).status, 401);
        const options = { baseUrl, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } };
        const first = OpenCode.make(options);
        const second = OpenCode.make(options);
        const location = { directory };
        let models = [];
        for (let n = 0; n < 100; n++) {
          models = (await first.model.list({ location })).data;
          if (models.some((model) => model.providerID === 'claude-acp' && model.id === 'fixture-model')) break;
          await delay(100);
        }
        assert(models.some((model) => model.providerID === 'claude-acp' && model.id === 'fixture-model'), JSON.stringify((await first.plugin.list({ location })).data.filter((item) => item.source.type !== 'builtin')));
        assert.deepEqual(models.find((model) => model.providerID === 'claude-acp' && model.id === 'fixture-model').variants.map((variant) => variant.id), ['low', 'medium', 'high']);
        const session = await first.session.create({ location, model: { providerID: 'claude-acp', id: 'fixture-model' } });
        const sessionID = session.id;
        await second.session.switchModel({ sessionID, model: { providerID: 'claude-acp', id: 'fixture-model', variant: 'high' } });
        await first.session.prompt({ sessionID, text: 'permission HTTP client' });
        let form;
        for (let n = 0; n < 100; n++) {
          [form] = await second.session.form.list({ sessionID });
          if (form) break;
          await delay(100);
        }
        assert(form, 'a second client sees the pending ACP approval');
        assert.match(JSON.stringify(form), /Claude ACP approval/);
        await second.session.form.reply({ sessionID, formID: form.id, answer: { q0: 'Allow once' } });
        await first.session.wait({ sessionID });
        const context = await second.session.context({ sessionID });
        assert.match(JSON.stringify(context), /Approved operation completed/);
        assert(context.some((message) => message.type === 'assistant' && message.content.some((part) => part.type === 'tool' && part.executed === true)));
        const entries = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
        assert.equal(entries.filter((entry) => entry.effective).at(-1).effective.effort, 'high', 'HTTP-selected effort reaches the ACP prompt');
        assert.equal(entries.filter((entry) => entry.method === 'session/prompt').length, 1, 'approval does not replay the prompt');
      });
    })));
  } finally {
    await delay(600);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
