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
function fakeMarket(now, { breakout = true, crash = false, btcDown = false } = {}) {
  const lastStart = Math.floor(now / H4) * H4 - H4;
  const c4 = Array.from({ length: 1000 }, (_, k) => {
    const i = k - 999, p = 100 * 1.002 ** (k);
    return { t: lastStart + i * H4, open: p, high: p * 1.004, low: p * 0.996, close: p * 1.001, quoteVolume: 1e6 };
  });
  const last = c4.at(-1);
  if (breakout) { last.close = last.high * 1.05; last.high = last.close; }
  if (crash) { last.close = last.open * 0.5; last.low = last.close; }
  const lastDay = Math.floor(now / DAY) * DAY - DAY;
  const d1 = Array.from({ length: 1000 }, (_, k) => ({ t: lastDay + (k - 999) * DAY, open: 1, high: 1, low: 1, close: 100 * (btcDown ? 0.999 : 1.001) ** k, quoteVolume: 1 }));
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

// code-breakout-nobtc = code-breakout-btc بدون فلتر البتكوين: على نفس الشموع يدخل كل ما دخل ذاك، وزيادة لما البتكوين تحت SMA200
test('no-BTC breakout signals whenever the BTC one does, and also when BTC is below its daily SMA200', () => {
  const withBtc = st.byId['breakout-btc-4h'], noBtc = st.byId[S.BOT['code-breakout-nobtc'].strategy];
  assert.strictEqual(S.BOT['code-breakout-nobtc'].kind, 'code');
  assert.strictEqual(noBtc.tf, withBtc.tf);
  for (const k of ['initialStop', 'exit', 'trail']) assert.strictEqual(noBtc[k], withBtc[k], `same ${k}`);
  const c4 = walk(2500, H4, 7), btc = walk(1400, DAY, 11, 0.003);
  const A = withBtc.prepare(c4, { btc1d: btc }), B = noBtc.prepare(c4, {});
  let both = 0, onlyNoBtcBtcDown = 0;
  for (let i = 250; i < c4.length; i++) {
    const a = withBtc.entry(A, i), b = noBtc.entry(B, i);
    if (a) { assert.ok(b, `bar ${i}: the BTC one signals, the no-BTC one must too`); both++; }
    if (b && !a) {
      assert.strictEqual(A.btcUp[i] === true, false, `bar ${i}: a difference may come only from the BTC filter`);
      if (A.btcUp[i] === false) onlyNoBtcBtcDown++;
    }
    if (b && A.btcUp[i] === true) assert.ok(a, `bar ${i}: BTC above its SMA200 -> identical`);
    if (ok_(A.cl[i])) assert.strictEqual(noBtc.initialStop(B, i), withBtc.initialStop(A, i));
  }
  assert.ok(both > 0, 'both signal somewhere');
  assert.ok(onlyNoBtcBtcDown > 0, 'and the no-BTC one also signals while BTC is below its daily SMA200');
});

test('live: with BTC below its daily SMA200 only code-breakout-nobtc enters, with the same stop rule', async () => {
  const now = Math.floor(Date.now() / H4) * H4 + 120_000;
  S.setUniverse(['SOLUSDT']);
  S.setMarket(fakeMarket(now, { btcDown: true }));
  const nb = S.state().bots['code-breakout-nobtc'], wb = S.state().bots['code-breakout-btc'];
  nb.trades = []; nb.codeState = { lastCandle: {} }; nb.cb = { consecutiveLosses: 0, pausedUntil: null };  // (the crash test above hit its daily loss limit)
  const before = wb.trades.length;
  await S.runCodeBots(now);
  const t = nb.trades.find(x => x.status === 'active' && x.symbol === 'SOLUSDT');
  assert.ok(t, 'the no-BTC contestant should enter');
  assert.strictEqual(wb.trades.length, before, 'the BTC-filtered one stays out');
  assert.ok(t.stopLoss < t.entryPrice && t.takeProfit == null && t.maxTimeMs == null);
  await S.runCodeBots(now + 60_000);
  assert.strictEqual(nb.trades.filter(x => x.symbol === 'SOLUSDT').length, 1, 'once per candle');
});

function ok_(x) { return x != null && Number.isFinite(x); }
