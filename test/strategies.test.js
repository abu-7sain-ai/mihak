const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_FILE = path.join(os.tmpdir(), `mihak-code-test-${process.pid}.json`);
const { _internals: S } = require('../server');
const st = require('../lib/strategies');

const H4 = 4 * 3_600_000, DAY = 86_400_000;

// شموع صناعية ثابتة (نفس النتيجة كل مرة)
function walk(n, ms, seed, drift = 0.0015) {
  let x = seed, p = 100;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31; };
  const t0 = Math.floor(Date.now() / ms) * ms - n * ms;
  return Array.from({ length: n }, (_, i) => {
    const o = p, c = o * (1 + drift * Math.sin(i / 90) + (rnd() - 0.5) * 0.03);
    p = c;
    return { t: t0 + i * ms, open: o, high: Math.max(o, c) * (1 + rnd() * 0.01), low: Math.min(o, c) * (1 - rnd() * 0.01), close: c, volume: 1, quoteVolume: 1e6 };
  });
}

test('live (last 1000 candles) gives the same signals as the full-history backtest', () => {
  const strat = st.byId['breakout-btc-4h'];
  const c4 = walk(2500, H4, 7), btc = walk(1400, DAY, 11, 0.003);
  const full = strat.prepare(c4, { btc1d: btc });
  let compared = 0, signals = 0;
  for (let end = c4.length - 300; end < c4.length; end++) {
    const live = c4.slice(end - 999, end + 1);
    const btcLive = btc.filter(d => d.t + DAY <= live.at(-1).t + H4).slice(-1000);
    const L = strat.prepare(live, { btc1d: btcLive });
    const a = strat.entry(full, end), b = strat.entry(L, live.length - 1);
    assert.strictEqual(b, a, `bar ${end}`);
    compared++; if (a) signals++;
  }
  assert.strictEqual(compared, 300);
  assert.ok(signals > 0, 'the synthetic data should produce at least one entry');
});

test('indicator series match the existing ema()', () => {
  const ind = require('../lib/indicators');
  const v = walk(400, H4, 3).map(c => c.close);
  assert.ok(Math.abs(st.emaS(v, 50).at(-1) - ind.ema(v, 50).at(-1)) < 1e-9);
});

// سوق وهمي: شموع 4 ساعات تطلع بثبات وآخر شمعة تكسر القمة؛ البتكوين فوق متوسط 200 يوم
function fakeMarket(now, { breakout = true, crash = false } = {}) {
  const lastStart = Math.floor(now / H4) * H4 - H4;
  const c4 = Array.from({ length: 1000 }, (_, k) => {
    const i = k - 999, p = 100 * 1.002 ** (k);
    return { t: lastStart + i * H4, open: p, high: p * 1.004, low: p * 0.996, close: p * 1.001, quoteVolume: 1e6 };
  });
  const last = c4.at(-1);
  if (breakout) { last.close = last.high * 1.05; last.high = last.close; }
  if (crash) { last.close = last.open * 0.5; last.low = last.close; }
  const lastDay = Math.floor(now / DAY) * DAY - DAY;
  const d1 = Array.from({ length: 1000 }, (_, k) => ({ t: lastDay + (k - 999) * DAY, open: 1, high: 1, low: 1, close: 100 * 1.001 ** k, quoteVolume: 1 }));
  return {
    subscribe() {}, unsubscribe() {},
    price: async () => last.close,
    klines: async (sym, tf) => (tf === '1d' ? d1 : c4),
  };
}

test('code contestant enters on a fresh closed-candle breakout, once, and exits on the signal', async () => {
  const id = 'code-breakout-btc';
  const now = Math.floor(Date.now() / H4) * H4 + 120_000;      // دقيقتين بعد إغلاق شمعة
  S.setUniverse(['ETHUSDT']);
  S.setMarket(fakeMarket(now));
  await S.runCodeBots(now);
  const bot = S.state().bots[id];
  const t = bot.trades.find(x => x.status === 'active');
  assert.ok(t, 'should have opened a trade');
  assert.strictEqual(t.symbol, 'ETHUSDT');
  assert.ok(t.stopLoss < t.entryPrice && t.takeProfit == null && t.maxTimeMs == null);
  assert.strictEqual(t.strategy, 'breakout-btc-4h');

  await S.runCodeBots(now + 60_000);                              // نفس الشمعة: ما يدخل مرة ثانية
  assert.strictEqual(bot.trades.length, 1);

  const next = now + H4;                                          // الشمعة اللي بعدها تنهار تحت EMA200
  S.setMarket(fakeMarket(next, { breakout: false, crash: true }));
  await S.runCodeBots(next);
  assert.strictEqual(t.status === 'active', false);
  assert.strictEqual(t.closeReason, 'signal-exit');
});

test('after a long restart it does not enter on an old candle', async () => {
  const id = 'code-breakout-btc';
  const bot = S.state().bots[id];
  bot.codeState = { lastCandle: {} };
  const before = bot.trades.length;
  const now = Math.floor(Date.now() / H4) * H4 + 2 * 3_600_000;   // سكّرت قبل ساعتين
  S.setMarket(fakeMarket(now));
  await S.runCodeBots(now);
  assert.strictEqual(bot.trades.length, before);
});
