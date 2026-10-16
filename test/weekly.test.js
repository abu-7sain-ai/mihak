const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_FILE = path.join(os.tmpdir(), `mihak-weekly-test-${process.pid}.json`);
const { _internals: S } = require('../server');
const st = require('../lib/strategies');

const DAY = 86_400_000, H4 = 4 * 3_600_000;
// آخر اثنين 00:05 UTC: شمعة الأحد سكّرت قبل 5 دقايق
const lastMonday = () => { const d = Math.floor(Date.now() / DAY) * DAY; let m = d; while (new Date(m).getUTCDay() !== 1) m -= DAY; return m; };

// سوق وهمي: كل عملة لها نمو يومي؛ آخر شمعة يومية = الأحد
function market(now, growth, last = {}) {
  const lastDay = Math.floor(now / DAY) * DAY - DAY;
  const series = (sym, ms, n, lastStart) => Array.from({ length: n }, (_, k) => {
    const g = growth[sym] ?? 0.001, p = 100 * (1 + g) ** (k * ms / DAY);
    return { t: lastStart - (n - 1 - k) * ms, open: p, high: p * 1.001, low: p * 0.999, close: p, quoteVolume: 1e6 };
  });
  const price = sym => (last[sym] ?? series(sym, DAY, 400, lastDay).at(-1).close);
  return {
    subscribe() {}, unsubscribe() {},
    price: async sym => price(sym),
    klines: async (sym, tf, limit) => {
      if (tf === '1d') { const c = series(sym, DAY, 400, lastDay); if (last[sym]) c.at(-1).close = last[sym]; return c; }
      return series(sym, H4, Math.min(limit || 250, 1000), Math.floor(now / H4) * H4 - H4);
    },
  };
}

test('rotation holds the 3 strongest coins above SMA200 with a -15% stop, once per week, and sells drop-outs', async () => {
  const now = lastMonday() + 5 * 60_000;
  const growth = { AUSDT: 0.004, BUSDT: 0.003, CUSDT: 0.002, DUSDT: 0.001, EUSDT: -0.002 };
  S.setUniverse(Object.keys(growth));
  S.setMarket(market(now, growth));
  await S.runCodeBots(now);
  const bot = S.state().bots['code-rotation'];
  const held = bot.trades.filter(t => t.status === 'active');
  assert.deepStrictEqual(held.map(t => t.symbol).sort(), ['AUSDT', 'BUSDT', 'CUSDT']);
  for (const t of held) assert.ok(Math.abs(t.stopLoss / t.entryPrice - 0.85) < 1e-9, 'stop -15% from entry');

  await S.runCodeBots(now + 60_000);                        // نفس الأسبوع: ولا شي
  assert.strictEqual(bot.trades.length, 3);

  const next = now + 7 * DAY;                              // الأسبوع الجاي: A تنزل 12% وتطلع من أقوى 3
  const aNow = 100 * 1.004 ** 399;                          // الشموع الوهمية نفسها كل أسبوع
  S.setMarket(market(next, growth, { AUSDT: aNow * 0.88 }));
  await S.runCodeBots(next);
  const now2 = bot.trades.filter(t => t.status === 'active').map(t => t.symbol).sort();
  assert.deepStrictEqual(now2, ['BUSDT', 'CUSDT', 'DUSDT']);
  assert.strictEqual(bot.trades.find(t => t.symbol === 'AUSDT').closeReason, 'signal-exit');
});

test('DCA buys BTC and ETH weekly, doubles below the 50-day SMA, and grows one position per coin', async () => {
  const id = 'code-dca';
  const bot = S.state().bots[id];
  Object.assign(bot, { codeState: { lastCandle: {} }, trades: [], balance: 1000 });
  const now = lastMonday() + 5 * 60_000;
  S.setUniverse(['BTCUSDT', 'ETHUSDT']);
  S.setMarket(market(now, { BTCUSDT: 0.002, ETHUSDT: -0.002 }));   // ETH نازل = تحت متوسط 50
  const before = bot.balance;
  await S.runCodeBots(now);
  const pos = sym => bot.trades.find(t => t.symbol === sym && t.status === 'active');
  assert.strictEqual(pos('BTCUSDT').amount, 30);
  assert.strictEqual(pos('ETHUSDT').amount, 60);
  assert.strictEqual(bot.balance, before - 90);
  assert.ok(pos('BTCUSDT').stopLoss <= 0 && pos('BTCUSDT').takeProfit == null);

  const next = now + 7 * DAY;
  S.setMarket(market(next, { BTCUSDT: 0.002, ETHUSDT: -0.002 }));
  await S.runCodeBots(next);
  assert.strictEqual(bot.trades.length, 2, 'still one position per coin');
  assert.strictEqual(pos('BTCUSDT').amount, 60);
  assert.strictEqual(pos('ETHUSDT').amount, 120);
  assert.strictEqual(pos('BTCUSDT').buys, 2);
});

test('pullback and bollinger give the same signals live (last 1000 candles) as in the backtest', () => {
  let x = 7, p = 100;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31; };
  const t0 = Date.UTC(2023, 0, 1);
  const c4 = Array.from({ length: 2400 }, (_, i) => { const o = p; p *= 1 + 0.0012 * Math.sin(i / 150) + 0.0006 + (rnd() - 0.5) * 0.03; return { t: t0 + i * H4, open: o, high: Math.max(o, p) * 1.004, low: Math.min(o, p) * 0.996, close: p, quoteVolume: 1e6 }; });
  const btc = Array.from({ length: 1000 }, (_, i) => ({ t: t0 - 500 * DAY + i * DAY, open: 1, high: 1, low: 1, close: 100 + i }));
  for (const id of ['pullback-rsi2-4h', 'bollinger-4h']) {
    const s = st.byId[id];
    const full = s.prepare(c4, { btc1d: btc });
    let n = 0;
    for (let end = c4.length - 300; end < c4.length; end++) {
      const live = c4.slice(end - 999, end + 1);
      const L = s.prepare(live, { btc1d: btc.filter(d => d.t + DAY <= live.at(-1).t + H4) });
      assert.strictEqual(s.entry(L, live.length - 1), s.entry(full, end), `${id} bar ${end}`);
      if (s.entry(full, end)) n++;
    }
    assert.ok(n > 0, `${id} should signal on the synthetic data`);
  }
});
