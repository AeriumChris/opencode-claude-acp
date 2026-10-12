import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const versionPattern = /^\d+\.\d+\.\d+$/;
interface ClaudeCli { version: string; path: string }

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = left[i]! - right[i]!;
    if (difference) return difference;
  }
  return 0;
}

function entries(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function installedClis(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeCli[] {
  const home = (platform === 'win32' ? env.USERPROFILE : env.HOME) || homedir();
  const roots = [join(home, '.local', 'share', 'claude', 'versions')];
  if (platform === 'win32') {
    if (env.APPDATA) roots.push(join(env.APPDATA, 'Claude', 'claude-code'));
    if (env.LOCALAPPDATA) {
      const packages = join(env.LOCALAPPDATA, 'Packages');
      for (const name of entries(packages)) if (name.startsWith('Claude_')) {
        roots.push(join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
      }
    }
  } else if (platform === 'darwin') roots.push(join(home, 'Library', 'Application Support', 'Claude', 'claude-code'));
  else if (platform === 'linux') roots.push(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude-code'));
  return roots.flatMap((root) => entries(root).flatMap((version) => {
    if (!versionPattern.test(version)) return [];
    const entry = join(root, version);
    const path = [entry, join(entry, platform === 'win32' ? 'claude.exe' : 'claude')]
      .find((path) => (platform !== 'win32' || path.endsWith('.exe')) && isFile(path));
    return path ? [{ version, path }] : [];
  }));
}

export function bundledVersion(adapterPath: string): string | undefined {
  try {
    // The SDK exports its entrypoint, but not package.json.
    const sdk = createRequire(adapterPath).resolve('@anthropic-ai/claude-agent-sdk');
    const { claudeCodeVersion } = JSON.parse(readFileSync(join(dirname(sdk), 'package.json'), 'utf8'));
    return typeof claudeCodeVersion === 'string' && versionPattern.test(claudeCodeVersion) ? claudeCodeVersion : undefined;
  } catch { return undefined; }
}

export function newestClaudeCli(adapterPath: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const bundled = bundledVersion(adapterPath);
  if (!bundled) return undefined;
  return installedClis(env, platform).filter((cli) => compareVersions(cli.version, bundled) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0]?.path;
}
