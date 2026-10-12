import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundledVersion, compareVersions, installedClis, newestClaudeCli } from '../dist/claude-cli.js';
import { command } from '../dist/options.js';

function fixture(t) {
  const root = mkdtempSync(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), 'acp-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local') };
  const file = (path, content = '') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; };
  const adapter = file(join(root, 'adapter', 'index.js'));
  const sdk = join(root, 'adapter', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  file(join(sdk, 'package.json'), JSON.stringify({ exports: './sdk.mjs', claudeCodeVersion: '2.1.280' }));
  file(join(sdk, 'sdk.mjs'));
  return { root, env, file, adapter, sdk, native: join(env.HOME, '.local', 'share', 'claude', 'versions') };
}

test('compares version components numerically', () => {
  assert(compareVersions('2.1.284', '2.1.99') > 0);
  assert(compareVersions('2.10.0', '2.9.999') > 0);
  assert(compareVersions('3.0.0', '2.999.999') > 0);
  assert(compareVersions('2.1.280', '2.1.284') < 0);
  assert.equal(compareVersions('2.1.280', '2.1.280'), 0);
});

test('discovers Store, APPDATA and native installs, skipping incomplete and non-version entries', (t) => {
  const { env, file, adapter, native } = fixture(t);
  const desktop = join(env.APPDATA, 'Claude', 'claude-code');
  const store = join(env.LOCALAPPDATA, 'Packages', 'Claude_test', 'LocalCache', 'Roaming', 'Claude', 'claude-code');
  const paths = [file(join(native, '2.1.281', 'claude.exe')), file(join(desktop, '2.1.282', 'claude.exe')),
    file(join(store, '2.1.284', 'claude.exe'))];
  mkdirSync(join(store, '2.1.999'), { recursive: true });
  mkdirSync(join(store, '2.1.998', 'claude.exe'), { recursive: true });
  for (const name of ['latest', '2.2', '3.0.0-beta', 'v3.0.0']) file(join(store, name, 'claude.exe'));
  file(join(env.LOCALAPPDATA, 'Packages', 'Other_test', 'LocalCache', 'Roaming', 'Claude', 'claude-code', '9.0.0', 'claude.exe'));
  assert.deepEqual(installedClis(env, 'win32').map((cli) => cli.path).sort(), paths.sort());
  assert.equal(newestClaudeCli(adapter, env, 'win32'), join(store, '2.1.284', 'claude.exe'));
});

test('keeps the bundled copy when installs are older or equal', (t) => {
  const { env, file, adapter, native } = fixture(t);
  assert.equal(newestClaudeCli(adapter, env, 'win32'), undefined);
  file(join(native, '2.1.279', 'claude.exe'));
  file(join(native, '2.1.280', 'claude.exe'));
  assert.equal(installedClis(env, 'win32').length, 2);
  assert.equal(newestClaudeCli(adapter, env, 'win32'), undefined);
});

test('Windows rejects extensionless executables in every layout', (t) => {
  const { env, file, native } = fixture(t);
  file(join(native, '2.1.284'));
  file(join(native, '2.1.285', 'claude'));
  file(join(env.APPDATA, 'Claude', 'claude-code', '2.1.284', 'claude'));
  file(join(env.LOCALAPPDATA, 'Packages', 'Claude_test', 'LocalCache', 'Roaming', 'Claude', 'claude-code', '2.1.284', 'claude'));
  assert.deepEqual(installedClis(env, 'win32'), []);
});

test('native installer supports versioned binaries and directories on Unix', (t) => {
  const { env, file, adapter, native } = fixture(t);
  const paths = [file(join(native, '2.1.99')), file(join(native, '2.1.284', 'claude'))];
  assert.deepEqual(installedClis(env, 'linux').map((cli) => cli.path).sort(), paths.sort());
  assert.equal(newestClaudeCli(adapter, env, 'linux'), join(native, '2.1.284', 'claude'));
});

test('Linux desktop uses XDG_CONFIG_HOME or the home config directory', (t) => {
  const { root, env, file, adapter } = fixture(t);
  const fallback = file(join(env.HOME, '.config', 'Claude', 'claude-code', '2.1.284', 'claude'));
  assert.equal(newestClaudeCli(adapter, env, 'linux'), fallback);
  env.XDG_CONFIG_HOME = join(root, 'xdg');
  const xdg = file(join(env.XDG_CONFIG_HOME, 'Claude', 'claude-code', '2.1.283', 'claude'));
  assert.deepEqual(installedClis(env, 'linux'), [{ version: '2.1.283', path: xdg }]);
  assert.equal(newestClaudeCli(adapter, env, 'linux'), xdg);
});

test('macOS desktop uses Library/Application Support', (t) => {
  const { env, file, adapter } = fixture(t);
  const path = file(join(env.HOME, 'Library', 'Application Support', 'Claude', 'claude-code', '2.1.284', 'claude'));
  assert.equal(newestClaudeCli(adapter, env, 'darwin'), path);
});

test('reads bundled x.y.z through the adapter SDK dependency without a package.json export', (t) => {
  const { adapter } = fixture(t);
  assert.equal(bundledVersion(adapter), '2.1.280');
  const installed = createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
  assert.match(bundledVersion(installed), /^\d+\.\d+\.\d+$/);
});

test('falls back when bundled version metadata is missing or invalid', (t) => {
  const { env, file, adapter, native, sdk } = fixture(t);
  file(join(native, '9.0.0', 'claude.exe'));
  for (const metadata of ['{}', '{"claudeCodeVersion":"latest"}', '{']) {
    file(join(sdk, 'package.json'), metadata);
    assert.equal(bundledVersion(adapter), undefined);
    assert.equal(newestClaudeCli(adapter, env, 'win32'), undefined);
  }
  rmSync(join(sdk, 'package.json'));
  assert.equal(bundledVersion(adapter), undefined);
});

test('only the default adapter receives discovery env, and inherited pins win', (t) => {
  const { env, file, native } = fixture(t);
  const keys = [...Object.keys(env), 'XDG_CONFIG_HOME', 'CLAUDE_CODE_EXECUTABLE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  Object.assign(process.env, env);
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CLAUDE_CODE_EXECUTABLE;
  const cli = file(join(native, '999.0.0', process.platform === 'win32' ? 'claude.exe' : 'claude'));
  const [exe, args, extraEnv] = command({ nodeExecutable: process.execPath });
  assert.equal(exe, process.execPath);
  assert.equal(args.length, 1);
  assert.deepEqual(extraEnv, { CLAUDE_CODE_EXECUTABLE: cli });
  assert.deepEqual(command({ command: 'custom-acp', args: ['--test'] }), ['custom-acp', ['--test'], {}]);
  process.env.CLAUDE_CODE_EXECUTABLE = 'pinned-claude';
  assert.deepEqual(command({})[2], {});
});
