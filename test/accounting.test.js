const test = require('node:test');
const assert = require('node:assert');
const acc = require('../lib/accounting');
const { parseDecision } = require('../lib/ai');

const rules = { feePercent: 0.1, slippagePercent: 0.05 };

test('take-profit +1% nets about +0.8% after fees and entry slippage', () => {
  const { fill, qty } = acc.openPosition(100, 100, rules);
  assert.ok(Math.abs(fill - 100.05) < 1e-9);
  const trade = { amount: 100, qty, takeProfit: fill * 1.01 };
  const exit = acc.exitFill('take-profit', 999, trade, rules); // limit fills at TP, not observed price
  assert.strictEqual(exit, trade.takeProfit);
  const { pnl } = acc.tradePnl(trade, exit, rules);
  // 100 * 0.999 * 1.01 * 0.999 - 100
  assert.ok(Math.abs(pnl - (100 * 0.999 * 1.01 * 0.999 - 100)) < 1e-9);
  assert.ok(pnl > 0.79 && pnl < 0.81);
});

test('stop-loss -0.5% costs about -0.75% and fills below stop on a gap', () => {
  const { fill, qty } = acc.openPosition(100, 100, rules);
  const trade = { amount: 100, qty, stopLoss: fill * 0.995 };
  const observed = trade.stopLoss * 0.99; // price gapped 1% under the stop
  const exit = acc.exitFill('stop-loss', observed, trade, rules);
  assert.ok(exit < trade.stopLoss);
  const { pnl } = acc.tradePnl(trade, exit, rules);
  assert.ok(pnl < -1.5, `gap should hurt more than the stop: ${pnl}`);
});

test('win rate counts trades, not dollars', () => {
  const t = (pnl) => ({ status: pnl > 0 ? 'won' : 'lost', pnlUSD: pnl, feesUSD: 0.2 });
  const trades = [...Array(10)].map(() => t(1)).concat([...Array(10)].map(() => t(-0.5)));
  const s = acc.computeStats({ trades, balance: 1005, equity: 1005, balanceHistory: [] }, 1000);
  assert.strictEqual(s.winRate, 50); // old app would show 66.7
  assert.strictEqual(s.profitFactor, 2);
  assert.strictEqual(s.returnPct, 0.5);
  assert.strictEqual(s.feesPaid, 4);
});

test('max drawdown uses equity history', () => {
  const hist = [1000, 1100, 990, 1050].map(b => ({ balance: b }));
  const s = acc.computeStats({ trades: [], balance: 1050, equity: 1050, balanceHistory: hist }, 1000);
  assert.strictEqual(s.maxDrawdown, 10);
});

test('decision parser accepts valid JSON and rejects coins outside the list', () => {
  const allowed = ['BTCUSDT', 'ETHUSDT'];
  const d = parseDecision('Sure: {"action":"buy","symbol":"ethusdt","confidence":72,"reason":"x"}', allowed);
  assert.deepStrictEqual([d.action, d.symbol, d.confidence], ['BUY', 'ETHUSDT', 72]);
  assert.strictEqual(parseDecision('{"action":"WAIT","symbol":null,"confidence":10,"reason":"y"}', allowed).action, 'WAIT');
  assert.throws(() => parseDecision('{"action":"BUY","symbol":"DOGEUSDT","confidence":90}', allowed));
  assert.throws(() => parseDecision('no json here', allowed));
  // انتظار مع أقوى مرشح وخطته
  const w = parseDecision('{"action":"WAIT","symbol":"ETH","takeProfitPercent":5,"stopLossPercent":-2.5,"maxHoldHours":12,"confidence":30,"reason":"z"}', allowed);
  assert.deepStrictEqual([w.action, w.symbol, w.plan.stopLossPercent], ['WAIT', 'ETHUSDT', -2.5]);
});

test('trade plan from the recommendation is clamped to the limits', () => {
  const { _internals } = require('../server');
  const clamp = _internals.clampPlan;
  const r = { takeProfitPercent: 3, stopLossPercent: -2, maxTradeTimeMinutes: 1440, minStopPercent: 1, maxStopPercent: 5, minRewardRisk: 1.5, maxTakeProfitPercent: 20, minHoldHours: 1, maxHoldHours: 48 };
  const ok = clamp({ takeProfitPercent: 6, stopLossPercent: -3, maxHoldHours: 12 }, r);
  assert.deepStrictEqual([ok.takeProfitPercent, ok.stopLossPercent, ok.maxHoldHours, ok.adjusted], [6, -3, 12, false]);
  const tight = clamp({ takeProfitPercent: 1, stopLossPercent: 0.3, maxHoldHours: 200 }, r);
  assert.deepStrictEqual([tight.stopLossPercent, tight.takeProfitPercent, tight.maxHoldHours, tight.adjusted], [-1, 1.5, 48, true]);
  const none = clamp({}, r);
  assert.deepStrictEqual([none.stopLossPercent, none.takeProfitPercent, none.maxHoldHours], [-2, 4, 24]);
});
