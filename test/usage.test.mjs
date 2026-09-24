import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageLedger, nativeUsage, formatUsage } from '../dist/usage.js';

test('usage accounting preserves unknowns, cumulative cost snapshots, reconnects, and isolated sessions', async () => {
  const values = new Map();
  const storage = { get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => values.set(key, structuredClone(value)) };
  const ledger = new UsageLedger(storage);
  assert.match(formatUsage(await ledger.get('first')), /No Claude ACP usage/);
  const usage = { inputTokens: 11, outputTokens: 7, cachedReadTokens: 23, cachedWriteTokens: 5, totalTokens: 46 };
  let report = await ledger.begin('first', 'native1', 'model1');
  for (const amount of [0.1, 0.25, 0.25]) await ledger.update('first', report,
    { used: 500, size: 1000000, cost: { amount, currency: 'USD' } });
  const native = await ledger.finish('first', report, usage);
  assert.equal(native.inputTokens, 39);
  assert.equal(native.nonCachedInputTokens, 11);
  assert.equal(native.contextTokens, 500, 'context occupancy is not billed token totals');
  assert.equal(native.reasoningTokens, undefined, 'do not fabricate thinking breakdown');
  assert.equal(report.cost.amount, 0.25);
  assert.equal(report.totals.totalTokens, 46);
  // Reconstruct the ledger as on plugin restart, and keep the native history.
  const restarted = new UsageLedger(storage);
  report = await restarted.begin('first', 'native1', 'model2');
  assert.equal(report.context, undefined, 'a new model must not inherit stale context occupancy');
  await restarted.update('first', report, { used: 100, size: 500000, cost: { amount: 0.5, currency: 'USD' } });
  await restarted.finish('first', report, usage);
  assert.equal(report.totals.totalTokens, 92);
  assert.equal(report.cost.amount, 0.5, 'never sum cumulative cost values');
  report = await restarted.begin('first', 'native2', 'model2');
  assert.equal(report.cost, undefined, 'a fresh native session has no inherited cumulative cost');
  await restarted.update('first', report, { used: -1, size: 0, cost: { amount: Infinity, currency: 'USD' } });
  assert.equal(report.context, undefined);
  assert.equal(report.cost, undefined);
  await restarted.finish('first', report, undefined);
  assert.equal(report.lastTurn, undefined);
  assert.equal(report.totals.totalTokens, 92);
  assert.equal(report.completedTurns, 3);
  assert.equal(report.reportedTurns, 2);
  assert.match(formatUsage(report), /2 of 3/);
  assert.match(formatUsage(report), /cost: not reported/);
  assert.equal(nativeUsage({ ...usage, totalTokens: NaN }), undefined);
  const other = await restarted.begin('second', 'native-other', 'model1');
  await restarted.update('second', other, { used: 0, size: 200000, cost: { amount: 0, currency: 'EUR' } });
  await restarted.finish('second', other, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(other.totals.totalTokens, 0, 'zero is a reported value');
  assert.match(formatUsage(other), /0 EUR/);
  assert.equal((await restarted.get('first')).totals.totalTokens, 92, 'sessions stay isolated');
});
