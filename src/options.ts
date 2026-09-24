import { createRequire } from 'node:module';

export interface Options {
  /** Executable and argv, without shell expansion. Defaults to the bundled Zed adapter. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  nodeExecutable?: string;
  startupTimeoutMs?: number;
  /** Close inactive adapter processes; Claude's persisted session can be reloaded. */
  idleTimeoutMs?: number;
  /** Automatically approve ACP permission requests. Host tool permissions still apply. */
  permissionMode?: 'ask' | 'allow';
}

export function parseOptions(input: Record<string, unknown>): Options {
  const allowed = new Set(['command', 'args', 'env', 'nodeExecutable', 'startupTimeoutMs', 'idleTimeoutMs', 'permissionMode']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown Claude ACP option: ${key}`);
  for (const key of ['command', 'nodeExecutable']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key])) throw new Error(`${key} must be a non-empty string.`);
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string'))) throw new Error('args must be an array of strings.');
  if (input.args !== undefined && !input.command) throw new Error('args requires an explicit command.');
  if (input.env !== undefined && (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env) || Object.values(input.env).some((value) => typeof value !== 'string'))) throw new Error('env must map names to strings.');
  for (const key of ['startupTimeoutMs', 'idleTimeoutMs']) {
    if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isSafeInteger(input[key]) || input[key] <= 0 || input[key] > 2_147_483_647)) throw new Error(`${key} must be a positive 32-bit integer.`);
  }
  if (input.permissionMode !== undefined && input.permissionMode !== 'ask' && input.permissionMode !== 'allow') throw new Error('permissionMode must be ask or allow.');
  return input as Options;
}

export function command(options: Options): [string, string[]] {
  if (options.command) return [options.command, options.args ?? []];
  const adapter = createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/dist/index.js');
  return [options.nodeExecutable ?? 'node', [adapter]];
}
