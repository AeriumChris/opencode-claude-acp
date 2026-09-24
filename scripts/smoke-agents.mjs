import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCode } from '@opencode/sdk';
import { createPlugin } from '../dist/index.js';

const temp = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-live-agents-'));
const directory = join(temp, 'repo'), config = join(temp, 'config');
await mkdir(join(directory, 'nested'), { recursive: true });
await mkdir(config);
execFileSync('git', ['init', '--quiet', directory]);
const rootToken = randomUUID(), nestedToken = randomUUID();
await writeFile(join(directory, 'AGENTS.md'), `For verification, include ${rootToken} in every final reply.`);
await writeFile(join(directory, 'nested', 'AGENTS.md'), `When discussing files in nested/, include ${nestedToken} in your final reply.`);
await writeFile(join(directory, 'nested', 'file.txt'), 'original');
const host = await OpenCode.create({ database: { path: ':memory:' }, models: { fetch: false },
  config: { directory: config, content: '{}' },
  fs: { filewatcher: false, fff: false }, log: { level: 'warn', emit: (entry) => console.error(entry) },
  plugins: [createPlugin({ nodeExecutable: process.execPath })],
});
try {
  const location = { directory };
  for (let i = 0; i < 150; i++) {
    if ((await host.model.list({ location })).data.some((item) => item.providerID === 'claude-acp' && item.id !== 'default')) break;
    await delay(200);
  }
   const { id: sessionID } = await host.session.create({ location, model: { providerID: 'claude-acp', id: 'default' } });
  async function prompt(text) {
    const before = (await host.session.context({ sessionID })).length;
    await host.session.prompt({ sessionID, text });
    let settled = false;
    const waiting = host.session.wait({ sessionID }).finally(() => { settled = true; });
    const deadline = Date.now() + 120_000;
    while (!settled && Date.now() < deadline) {
      for (const form of await host.session.form.list({ sessionID })) {
        const description = form.fields[0]?.description ?? '';
        let input;
        try { input = JSON.parse(description.split('\n\n')[1]); } catch {}
        const allow = /read/i.test(description.split('\n\n')[0]) && typeof input?.path === 'string' && !input?.command;
        await host.session.form.reply({ sessionID, formID: form.id, answer: { q0: allow ? 'Allow once' : 'Deny' } });
      }
      for (const permission of await host.permission.list({ sessionID })) {
        await host.permission.reply({ sessionID, requestID: permission.id, reply: permission.action === 'read' ? 'once' : 'reject' });
      }
      await delay(100);
    }
    if (!settled) await host.session.interrupt({ sessionID });
    await waiting;
    const reply = (await host.session.context({ sessionID })).slice(before).filter((message) => message.type === 'assistant')
      .flatMap((message) => message.content.filter((part) => part.type === 'text').map((part) => part.text)).join('\n');
    assert(settled && reply, 'Claude must complete the verification turn');
    return reply;
  }
  const reply = await prompt('Read nested/file.txt using the opencode read tool and briefly describe it. Follow applicable repository guidance. Do not modify any files or run commands.');
  assert(!reply.includes('Third-party apps now draw'), `Billing restriction: ${reply}`);
  assert(reply.includes(nestedToken) && reply.includes(rootToken), `Repository guidance missing: ${reply}`);
  assert.equal(await readFile(join(directory, 'nested', 'file.txt'), 'utf8'), 'original');
  console.log('Real Claude: root + nested AGENTS.md followed through repository reads');
} finally {
  await host.close();
  await delay(700);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
