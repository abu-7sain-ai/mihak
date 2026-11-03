const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_FILE = path.join(os.tmpdir(), `mihak-winloss-test-${process.pid}.json`);
const { _internals: S } = require('../server');
const acc = require('../lib/accounting');

const closed = (pnlUSD, i) => ({ id: `t${i}`, status: pnlUSD > 0 ? 'won' : 'lost', pnlUSD, feesUSD: 0.1 });

test('wins / losses / winRatePct: 5 wins + 15 losses = 25%; open trades and break-even', () => {
  const trades = [
    ...Array.from({ length: 5 }, (_, i) => closed(3, i)),
    ...Array.from({ length: 14 }, (_, i) => closed(-2, 10 + i)),
    closed(0, 99),                                          // صفر بعد الرسوم = خاسرة
    { id: 'open', status: 'active', pnlUSD: 50, feesUSD: 0.1 },   // المفتوحة ما تنحسب
  ];
  const s = acc.computeStats({ trades, balance: 1000, balanceHistory: [] }, 1000);
  assert.deepStrictEqual([s.wins, s.losses, s.winRatePct, s.closedTrades], [5, 15, 25, 20]);
  assert.strictEqual(s.closedTrades, s.wins + s.losses);
  assert.strictEqual(acc.computeStats({ trades: [{ status: 'active', pnlUSD: 9 }], balance: 1000, balanceHistory: [] }, 1000).winRatePct, null);
});

test('leaderboard and get_bot carry wins, losses, winRatePct; trades = wins + losses; no closed trades = null («—»)', () => {
  const id = 'code-breakout-nobtc';
  const bot = S.state().bots[id];
  bot.trades = [
    ...Array.from({ length: 5 }, (_, i) => closed(4, i)),
    ...Array.from({ length: 15 }, (_, i) => closed(-1, 20 + i)),
    { id: 'o', status: 'active', symbol: 'ETHUSDT', qty: 1, amount: 10, entryPrice: 10, currentPrice: 10, pnlUSD: 0, feesUSD: 0 },
  ];
  const snap = S.clientSnapshot();
  const row = snap.leaderboard.find(r => r.id === id);
  assert.deepStrictEqual([row.wins, row.losses, row.winRatePct, row.trades], [5, 15, 25, 20]);
  const b = snap.bots[id];
  assert.deepStrictEqual([b.wins, b.losses, b.winRatePct], [5, 15, 25]);
  for (const r of snap.leaderboard) assert.strictEqual(r.trades, r.wins + r.losses, r.id);

  const empty = 'code-trend200-vol';
  S.state().bots[empty].trades = [];
  const e = S.clientSnapshot().leaderboard.find(r => r.id === empty);
  assert.deepStrictEqual([e.wins, e.losses, e.winRatePct], [0, 0, null]);
});
