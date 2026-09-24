import type { Bridge } from './bridge.js';

// Provider packages are imported separately by OpenCode. A per-activation key prevents
// sessions in different Locations from sharing a bridge, including after plugin reload.
const key = Symbol.for('opencode-claude-acp.bridges.v1');
const global = globalThis as typeof globalThis & { [key]?: Map<string, Bridge> };
export const bridges = global[key] ??= new Map<string, Bridge>();
