const test = require('node:test');
const assert = require('node:assert');
const { _internals: S } = require('../server');

test('meeting stats score experts and chairs against the hypothetical outcome', () => {
  S.setMarket({ unsubscribe() {}, subscribe() {} });
  const st = S.state();
  const mk = (won, trend, news, model, rule) => ({
    source: 'now-qwen', symbol: 'ETHUSDT', status: 'open', amount: 100, qty: 1, entryPrice: 100,
    takeProfit: 101, stopLoss: 99.5, at: Date.now(), maxTimeMs: 1e9,
    votes: { trend: { vote: trend, confidence: 70 }, news: { vote: news, confidence: 60 } },
    chairModel: { decision: model }, chairRule: { decision: rule }, _won: won,
  });
  st.opportunities = [
    mk(true, 'ENTER', 'SKIP', 'ENTER', 'ENTER'),
    mk(false, 'SKIP', 'SKIP', 'SKIP', 'ENTER'),
    mk(false, 'ENTER', 'ENTER', 'SKIP', 'SKIP'),
    mk(true, 'ENTER', 'ENTER', 'ENTER', 'SKIP'),
  ];
  st.rules.feePercent = 0; st.rules.slippagePercent = 0;
  for (const o of st.opportunities) S.closeOpportunity(o, o._won ? 'take-profit' : 'stop-loss', o._won ? 101 : 99.5);
  const m = S.meetingStats('now-qwen');
  assert.strictEqual(m.closed, 4);
  assert.strictEqual(m.scoutWinRate, 50);
  assert.strictEqual(m.members.trend.accuracy, 75);   // right on 3 of 4
  assert.strictEqual(m.members.news.accuracy, 50);
  assert.strictEqual(m.chairs.model.accuracy, 100);
  assert.strictEqual(m.chairs.model.rejectedThatLost, 2);
  assert.strictEqual(m.chairs.rule.accuracy, 50);
  assert.ok(m.chairs.model.approvedAvgPnl > 0 && m.chairs.model.rejectedAvgPnl < 0);
});
