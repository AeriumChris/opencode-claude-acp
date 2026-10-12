import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledVersion, compareVersions, installedClis, newestClaudeCli } from '../dist/claude-cli.js';

const adapter = createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');

test('versions compare numerically', () => {
  assert.ok(compareVersions('2.1.284', '2.1.280') > 0);
  assert.ok(compareVersions('2.10.0', '2.9.99') > 0);
  assert.equal(compareVersions('2.1.284', '2.1.284'), 0);
});

test('the newest installed Claude Code newer than the bundled CLI is selected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-cli-'));
  try {
    const file = async (...parts) => { await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true }); await writeFile(join(root, ...parts), ''); };
    const store = ['local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code'];
    await file(...store, '999.0.1', 'claude.exe');
    await file(...store, '999.0.0', 'claude.exe');
    await file('roaming', 'Claude', 'claude-code', '999.0.2', 'claude.exe');
    await mkdir(join(root, 'roaming', 'Claude', 'claude-code', '999.0.3'), { recursive: true }); // Incomplete download.
    await file('roaming', 'Claude', 'claude-code', 'not-a-version', 'claude.exe');
    await file('home', '.local', 'share', 'claude', 'versions', '0.0.1', 'claude.exe'); // Older than bundled.
    const env = { USERPROFILE: join(root, 'home'), APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local') };
    assert.deepEqual(installedClis(env, 'win32').map((cli) => cli.version).sort(), ['0.0.1', '999.0.0', '999.0.1', '999.0.2']);
    assert.deepEqual(newestClaudeCli(adapter, env, 'win32'), { version: '999.0.2', path: join(root, 'roaming', 'Claude', 'claude-code', '999.0.2', 'claude.exe') });
    assert.equal(newestClaudeCli(adapter, { USERPROFILE: join(root, 'home') }, 'win32'), undefined);

    await file('home2', '.local', 'share', 'claude', 'versions', '999.1.0');
    assert.equal(newestClaudeCli(adapter, { HOME: join(root, 'home2') }, 'linux')?.path, join(root, 'home2', '.local', 'share', 'claude', 'versions', '999.1.0'));
    assert.equal(newestClaudeCli(adapter, { USERPROFILE: join(root, 'home2') }, 'win32'), undefined); // Windows needs an .exe.
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the bundled CLI version comes from the adapter SDK', () => {
  assert.match(bundledVersion(adapter) ?? '', /^\d+\.\d+\.\d+$/);
});
