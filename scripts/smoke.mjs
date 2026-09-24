import { OpenCode } from '@opencode/sdk';
import { createPlugin } from '../dist/index.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomInt, randomUUID } from 'node:crypto';
import { screenshot } from '../test/fixtures/image.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-live-'));
const effort = process.argv.find((argument) => argument.startsWith('--effort='))?.slice('--effort='.length);
const host = await OpenCode.create({
  database: { path: ':memory:' }, models: { fetch: false }, config: { directory, project: false, content: '{}' },
  fs: { filewatcher: false, fff: false }, log: { level: 'warn', emit: (entry) => console.error(entry) },
  plugins: [createPlugin({ nodeExecutable: process.execPath })],
});
try {
  let found = false;
  for (let n = 0; n < 150; n++) {
    const models = (await host.model.list({ location: { directory } })).data.filter((model) => model.providerID === 'claude-acp');
    if (models.length > 1 && (!effort || models.find((model) => model.id === 'default')?.variants.some((variant) => variant.id === effort))) {
      console.log('Models:', models.map((model) => model.id)); found = true; break;
    }
    await delay(200);
  }
  if (!found) throw new Error('Claude ACP model/effort discovery failed. Check Claude login and the requested effort.');
  const session = await host.sessions.create({ location: { directory }, model: { providerID: 'claude-acp', id: 'default', ...(effort ? { variant: effort } : {}) } });
  await host.sessions.prompt({ sessionID: session.id, text: 'Reply with exactly ACP_READY. Do not use any tools.' });
  await host.sessions.wait({ sessionID: session.id });
  const context = await host.sessions.context({ sessionID: session.id });
  const assistant = context.filter((message) => message.type === 'assistant');
  if (!JSON.stringify(assistant).includes('ACP_READY')) throw new Error(`Live Claude smoke failed: ${JSON.stringify(context)}`);
  console.log('Live Claude → ACP → OpenCode: ACP_READY');
  if (effort) console.log(`Selected effort: ${effort}`);
  if (process.argv.includes('--attachments')) {
    const colors = [{ name: 'RED', rgb: [255, 0, 0] }, { name: 'GREEN', rgb: [0, 180, 0] }, { name: 'BLUE', rgb: [0, 0, 255] }];
    const color = colors[randomInt(colors.length)];
    const attachedToken = randomUUID(), repoToken = randomUUID();
    const file = join(directory, 'repo-check.txt');
    await writeFile(file, repoToken);
    const before = (await host.sessions.context({ sessionID: session.id })).length;
    await host.sessions.prompt({ sessionID: session.id,
      text: 'Identify the color of the large rectangle in the screenshot. Also report the token in the attached notes, and use your Read tool to read repo-check.txt in the current project and report its token. Do not edit files or run shell commands.',
      files: [
        { uri: `data:image/png;base64,${screenshot(color.rgb).toString('base64')}`, name: 'screen.png' },
        { uri: `data:text/plain;base64,${Buffer.from(attachedToken).toString('base64')}`, name: 'notes.txt' },
      ],
    });
    let settled = false;
    const waiting = host.sessions.wait({ sessionID: session.id }).finally(() => { settled = true; });
    const deadline = Date.now() + 120_000;
    while (!settled && Date.now() < deadline) {
      for (const form of await host.session.form.list({ sessionID: session.id })) {
        const description = form.fields[0]?.description ?? '';
        let input;
        try { input = JSON.parse(description.split('\n\n')[1]); } catch {}
        const allowed = /Read/.test(description.split('\n\n')[0]) && typeof input?.file_path === 'string' && resolve(directory, input.file_path) === resolve(file);
        await host.session.form.reply({ sessionID: session.id, formID: form.id, answer: { q0: allowed ? 'Allow once' : 'Deny' } });
      }
      await delay(100);
    }
    if (!settled) await host.sessions.interrupt({ sessionID: session.id });
    await waiting;
    const messages = (await host.sessions.context({ sessionID: session.id })).slice(before).filter((message) => message.type === 'assistant');
    const reply = messages.flatMap((message) => message.content.filter((part) => part.type === 'text').map((part) => part.text)).join('\n');
    if (!reply.toUpperCase().includes(color.name) || !reply.includes(attachedToken) || !reply.includes(repoToken)) {
      throw new Error(`Attachment/repository read smoke failed: ${reply}`);
    }
    if (!messages.some((message) => message.content.some((part) => part.type === 'tool' && part.executed === true))) throw new Error('No native repository read tool result.');
    console.log('Live screenshot vision + attached text + native repository read: verified');
  }
  if (process.argv.includes('--tools')) {
    const file = join(directory, 'acp-smoke.txt');
    const content = 'ACP_FILE_READY\n';
    await host.sessions.prompt({ sessionID: session.id,
      text: `Use your Write tool to create ${file} with exactly the text ACP_FILE_READY followed by a newline. Do not run shell commands or modify any other file. Then reply FILE_DONE.` });
    let settled = false;
    const waiting = host.sessions.wait({ sessionID: session.id }).finally(() => { settled = true; });
    const deadline = Date.now() + 120_000;
    while (!settled && Date.now() < deadline) {
      for (const form of await host.session.form.list({ sessionID: session.id })) {
        // Approve only the exact scratch-file write requested above.
        const description = form.fields[0]?.description ?? '';
        let input;
        try { input = JSON.parse(description.split('\n\n')[1]); } catch {}
        const allowed = typeof input?.file_path === 'string' && resolve(input.file_path) === resolve(file) && input.content === content;
        await host.session.form.reply({ sessionID: session.id, formID: form.id, answer: { q0: allowed ? 'Allow once' : 'Deny' } });
        if (!allowed) console.log('Denied an operation outside the smoke-test file write.');
      }
      await delay(100);
    }
    if (!settled) await host.sessions.interrupt({ sessionID: session.id });
    await waiting;
    if (!settled || Date.now() >= deadline) throw new Error('Live tool smoke timed out.');
    if (await readFile(file, 'utf8') !== content) throw new Error('Claude did not write the expected scratch file.');
    const result = JSON.stringify(await host.sessions.context({ sessionID: session.id }));
    if (!result.includes('claude_code')) throw new Error('Claude tool output was not mirrored in OpenCode.');
    console.log('Live Claude tool execution → scratch file + OpenCode tool result: verified');
  }
} finally {
  await host.close();
  await delay(700);
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
