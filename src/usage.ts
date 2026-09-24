import { Usage } from '@opencode/ai';

type Tokens = { inputTokens: number; outputTokens: number; totalTokens: number;
  cachedReadTokens?: number; cachedWriteTokens?: number; thoughtTokens?: number };
type Context = { used: number; size: number; model: string; reportedAt: string };
type Cost = { amount: number; currency: string; reportedAt: string };
export type UsageReport = { version: 1; nativeSessionID: string; model: string; completedTurns: number;
  reportedTurns: number; totals?: Tokens; lastTurn?: Tokens; context?: Context; cost?: Cost;
  status: 'running' | 'completed'; updatedAt: string };
export interface UsageStorage { get(key: string): Promise<unknown>; set(key: string, value: UsageReport): Promise<void> }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function tokens(value: unknown): Tokens | undefined {
  const raw = object(value);
  if (!count(raw.inputTokens) || !count(raw.outputTokens) || !count(raw.totalTokens)) return;
  return { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, totalTokens: raw.totalTokens,
    ...(count(raw.cachedReadTokens) ? { cachedReadTokens: raw.cachedReadTokens } : {}),
    ...(count(raw.cachedWriteTokens) ? { cachedWriteTokens: raw.cachedWriteTokens } : {}),
    ...(count(raw.thoughtTokens) ? { thoughtTokens: raw.thoughtTokens } : {}) };
}

/** Claude ACP's inputTokens excludes cache reads/writes; OpenCode's includes them. */
export function nativeUsage(value: unknown, context?: Context): Usage | undefined {
  const raw = tokens(value);
  if (!raw && !context) return;
  return new Usage({ ...(context ? { contextTokens: context.used } : {}), ...(raw ? {
    inputTokens: raw.inputTokens + (raw.cachedReadTokens ?? 0) + (raw.cachedWriteTokens ?? 0),
    nonCachedInputTokens: raw.inputTokens, outputTokens: raw.outputTokens, totalTokens: raw.totalTokens,
    cacheReadInputTokens: raw.cachedReadTokens, cacheWriteInputTokens: raw.cachedWriteTokens,
    reasoningTokens: raw.thoughtTokens,
  } : {}) });
}

/** Stores observations, never sums cumulative cost readings or infers a billing pool. */
export class UsageLedger {
  constructor(private storage: UsageStorage) {}
  async get(id: string): Promise<UsageReport | undefined> {
    const saved = await this.storage.get(`usage:${id}`);
    return object(saved).version === 1 ? saved as UsageReport : undefined;
  }
  async begin(id: string, nativeSessionID: string, model: string) {
    const prior = await this.get(id);
    const sameSession = prior?.nativeSessionID === nativeSessionID;
    const report: UsageReport = { version: 1, nativeSessionID, model,
      completedTurns: prior?.completedTurns ?? 0, reportedTurns: prior?.reportedTurns ?? 0,
      ...(prior?.totals ? { totals: prior.totals } : {}),
      ...(sameSession && prior?.model === model && prior.context ? { context: prior.context } : {}),
      ...(sameSession && prior?.cost ? { cost: prior.cost } : {}),
      status: 'running', updatedAt: new Date().toISOString() };
    await this.storage.set(`usage:${id}`, report);
    return report;
  }
  async update(id: string, report: UsageReport, value: unknown): Promise<number | undefined> {
    const raw = object(value);
    const now = new Date().toISOString();
    let size: number | undefined;
    if (count(raw.used) && count(raw.size) && raw.size > 0) {
      size = raw.size;
      report.context = { used: raw.used, size, model: report.model, reportedAt: now };
    }
    const cost = object(raw.cost);
    if (typeof cost.amount === 'number' && Number.isFinite(cost.amount) && cost.amount >= 0 &&
        typeof cost.currency === 'string' && /^[A-Z]{3}$/.test(cost.currency)) {
      report.cost = { amount: cost.amount, currency: cost.currency, reportedAt: now };
    }
    report.updatedAt = now;
    await this.storage.set(`usage:${id}`, report);
    return size;
  }
  async finish(id: string, report: UsageReport, value: unknown) {
    const raw = tokens(value);
    report.completedTurns++;
    report.lastTurn = raw;
    if (raw) {
      report.reportedTurns++;
      const previous = report.totals;
      report.totals = { ...raw };
      for (const key of Object.keys(raw) as (keyof Tokens)[]) {
        report.totals[key] = (previous?.[key] ?? 0) + raw[key]!;
      }
      // Retain observed optional counters even if a later response omits them.
      for (const key of ['cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens'] as const) {
        if (raw[key] === undefined && previous?.[key] !== undefined) report.totals[key] = previous[key];
      }
    }
    report.status = 'completed';
    report.updatedAt = new Date().toISOString();
    await this.storage.set(`usage:${id}`, report);
    return nativeUsage(raw, report.context);
  }
}

export function formatUsage(report?: UsageReport): string {
  if (!report) return 'No Claude ACP usage has been reported for this OpenCode session yet.';
  const lines = ['## Claude ACP usage', '', `Model: ${report.model}`,
    `Token reports: ${report.reportedTurns} of ${report.completedTurns} completed turns.`,
    ...(report.status === 'running' ? ['The latest turn is active or was interrupted; its final token totals have not been recorded.'] : []), '',
    '| Tokens | Last completed turn | Observed completed-turn total |', '| --- | ---: | ---: |'];
  for (const [label, key] of [['Input (uncached)', 'inputTokens'], ['Cache read', 'cachedReadTokens'],
    ['Cache write', 'cachedWriteTokens'], ['Output (includes thinking)', 'outputTokens'],
    ['Thinking, if separately reported', 'thoughtTokens'], ['Total', 'totalTokens']] as const) {
    lines.push(`| ${label} | ${report.lastTurn?.[key] ?? 'Not reported'} | ${report.totals?.[key] ?? 'Not reported'} |`);
  }
  lines.push('', report.context ? `Context: ${report.context.used} / ${report.context.size} tokens (${(report.context.used / report.context.size * 100).toFixed(1)}%). Reported ${report.context.reportedAt}.` : 'Context usage/capacity: not reported.',
    report.cost ? `ACP-reported cumulative cost: ${report.cost.amount} ${report.cost.currency}. Reported ${report.cost.reportedAt}.` : 'ACP-reported cost: not reported.',
    '', 'Cost is the latest adapter reading, not a sum of updates or reconnects and not proof of a charge to your subscription or extra usage. OpenCode’s price-table dollar counter is separate.',
    'Token totals cover reported completed turns observed by this plugin; interrupted/unreported turns and earlier history may be missing. Claude’s main-loop token report can exclude subagents/internal calls.',
    'Context capacity is supplied by ACP (the adapter may initially estimate it). Output-token limits are not reported by this adapter; OpenCode’s fallback remains.');
  return lines.join('\n');
}
