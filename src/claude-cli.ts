import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ClaudeCli { path: string; version: string }
const semver = /^(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a: string, b: string) {
  const parts = (value: string) => (semver.exec(value) ?? []).slice(1).map(Number);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

const list = (directory: string) => { try { return readdirSync(directory); } catch { return []; } };
const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

// Claude desktop and the native installer keep Claude Code current in
// versioned directories. The adapter's pinned CLI lags behind them, and ACP's
// model list comes from whichever CLI runs, so new models need a newer build.
export function installedClis(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ClaudeCli[] {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) ?? homedir();
  const exe = platform === 'win32' ? 'claude.exe' : 'claude';
  const roots = [join(home, '.local', 'share', 'claude', 'versions')];
  if (platform === 'win32') {
    if (env.APPDATA) roots.push(join(env.APPDATA, 'Claude', 'claude-code'));
    // The Store (MSIX) desktop app virtualizes %APPDATA% under its package.
    const packages = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Packages') : undefined;
    if (packages) roots.push(...list(packages).filter((name) => name.startsWith('Claude_'))
      .map((name) => join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude-code')));
  } else if (platform === 'darwin') roots.push(join(home, 'Library', 'Application Support', 'Claude', 'claude-code'));
  else roots.push(join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude-code'));
  return roots.flatMap((root) => list(root).filter((version) => semver.test(version)).flatMap((version) => {
    const entry = join(root, version);
    const path = isFile(entry) ? entry : join(entry, exe);
    return isFile(path) && (platform !== 'win32' || path.toLowerCase().endsWith('.exe')) ? [{ path, version }] : [];
  }));
}

/** The CLI version pinned by the adapter's Claude Agent SDK, if resolvable. */
export function bundledVersion(adapter: string): string | undefined {
  try {
    const sdk = createRequire(adapter).resolve('@anthropic-ai/claude-agent-sdk');
    const version = JSON.parse(readFileSync(join(dirname(sdk), 'package.json'), 'utf8')).claudeCodeVersion;
    return typeof version === 'string' && semver.test(version) ? version : undefined;
  } catch { return undefined; }
}

/** The newest installed Claude Code that is newer than the bundled CLI. */
export function newestClaudeCli(adapter: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const bundled = bundledVersion(adapter) ?? '0.0.0';
  return installedClis(env, platform).filter((cli) => compareVersions(cli.version, bundled) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}
