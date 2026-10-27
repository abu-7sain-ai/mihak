const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_FILE = path.join(os.tmpdir(), `mihak-newbots-test-${process.pid}.json`);
const { _internals: S } = require('../server');
const tv = require('../lib/trendvol');
const { createFunding, fundingAllows } = require('../lib/funding');

const DAY = 86_400_000;

// ── «فوق متوسط 200 + تحكم بالتذبذب»: الحساب ─────────────────────────────────
test('SMA200 rule: above → hold, below → 100% cash', () => {
  const up = Array.from({ length: 260 }, (_, i) => 100 * 1.002 ** i);
  const down = Array.from({ length: 260 }, (_, i) => 100 * 0.998 ** i);
  assert.ok(tv.targetWeight(up).above && tv.targetWeight(up).weight > 0);
  const d = tv.targetWeight(down);
  assert.strictEqual(d.above, false);
  assert.strictEqual(d.weight, 0);
  assert.strictEqual(tv.targetWeight(up.slice(0, 150)).weight, 0, 'not enough history = cash');
});

test('volatility weight math: weight = min(1, 0.40 / (stdev of 30 daily log returns × √365))', () => {
  // عوائد لوغاريتمية متناوبة +a / −a: الانحراف (n−1) = a × √(30/29)
  const a = 0.03;
  const closes = [100];
  for (let i = 0; i < 260; i++) closes.push(closes.at(-1) * Math.exp(i % 2 ? -a : a) * 1.0004);
  const vol = tv.realizedVol(closes);
  const rets = closes.slice(-31).map((c, i, x) => (i ? Math.log(c / x[i - 1]) : null)).slice(1);
  const mean = rets.reduce((s, r) => s + r, 0) / 30;
  const expect = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / 29) * Math.sqrt(365);
  assert.ok(Math.abs(vol - expect) < 1e-12);
  const w = tv.targetWeight(closes);
  assert.ok(w.above);
  assert.ok(Math.abs(w.weight - Math.min(1, 0.40 / vol)) < 1e-12);
  assert.ok(w.weight < 1, 'high volatility → smaller position');
  const calm = Array.from({ length: 260 }, (_, i) => 100 * 1.001 ** i);   // تذبذب شبه صفر
  assert.strictEqual(tv.targetWeight(calm).weight, 1, 'capped at 100%');
});

test('rebalance band: only when the target differs by more than 10 points', () => {
  assert.strictEqual(tv.needsRebalance(0.50, 0.59), false);
  assert.strictEqual(tv.needsRebalance(0.50, 0.60), false, 'exactly 10 points: no trade');
  assert.strictEqual(tv.needsRebalance(0.50, 0.61), true);
  assert.strictEqual(tv.needsRebalance(0.50, 0.39), true);
  assert.strictEqual(tv.needsRebalance(0, 0.05), false);
});

// ── البوت نفسه على السوق الوهمي ──────────────────────────────────────────────
function market(closes, now) {
  const lastStart = Math.floor(now / DAY) * DAY - DAY;
  const c = closes.map((x, k) => ({ t: lastStart - (closes.length - 1 - k) * DAY, open: x, high: x, low: x, close: x, quoteVolume: 1 }));
  return { subscribe() {}, unsubscribe() {}, price: async () => closes.at(-1), klines: async () => c };
}
test('code-trend200-vol: buys its vol weight, decides once per closed day, keeps the band, sells to cash below SMA200', async () => {
  const id = 'code-trend200-vol';
  const bot = S.state().bots[id];
  const now = Date.UTC(2026, 9, 27, 0, 30);
  const closes = [100];
  for (let i = 0; i < 260; i++) closes.push(closes.at(-1) * Math.exp(i % 2 ? -0.02 : 0.021));
  S.setMarket(market(closes, now));
  await S.runTrendVolBot(S.BOT[id], now);
  const w = tv.targetWeight(closes).weight;
  const t = bot.trades.find(x => x.status === 'active');
  assert.ok(t && t.symbol === 'BTCUSDT');
  assert.ok(Math.abs(t.amount - w * 1000) < 0.01, `bought ${t.amount} ≈ ${w * 1000}`);
  assert.ok(t.takeProfit == null && t.stopLoss <= 0 && t.maxTimeMs == null, 'no TP / SL / max hold');
  assert.strictEqual(bot.decisions[0].action, 'BUY');

  const n = bot.decisions.length;
  await S.runTrendVolBot(S.BOT[id], now + 60_000);          // نفس اليوم: ما يقرر مرة ثانية
  assert.strictEqual(bot.decisions.length, n);

  const next = now + DAY;                                   // يوم جديد بنفس الوزن تقريباً → داخل النطاق
  S.setMarket(market([...closes.slice(1), closes.at(-1) * 1.001], next));
  await S.runTrendVolBot(S.BOT[id], next);
  assert.strictEqual(bot.decisions[0].action, 'WAIT');

  const crash = now + 2 * DAY;                              // تحت متوسط 200 → كاش كامل
  const low = [...closes.slice(2), closes.at(-1) * 1.001, closes.at(-1) * 0.3];
  S.setMarket(market(low, crash));
  await S.runTrendVolBot(S.BOT[id], crash);
  assert.strictEqual(bot.decisions[0].action, 'SELL');
  assert.strictEqual(bot.trades.filter(x => x.status === 'active').length, 0, 'all cash');
});

// ── فلتر التمويل ─────────────────────────────────────────────────────────────
const fakeFetch = routes => async url => {
  for (const [re, body, status = 200] of routes) if (re.test(url)) return { ok: status < 400, status, json: async () => body };
  return { ok: false, status: 451, json: async () => ({ msg: 'blocked' }) };
};
test('funding filter: blocks above 0.03% per 8h, allows below, falls back to BTC for a coin without a perpetual', async () => {
  const f = createFunding({ fetchImpl: fakeFetch([
    [/premiumIndex\?symbol=BTCUSDT/, { lastFundingRate: '0.0001' }],
    [/premiumIndex\?symbol=ETHUSDT/, { lastFundingRate: '0.0005' }],
    [/premiumIndex\?symbol=SEIUSDT/, { code: -1121, msg: 'Invalid symbol.' }, 400],
    [/fundingInfo/, []],
  ]) });
  const p = await f.probe();
  assert.deepStrictEqual([p.ok, p.source], [true, 'binance']);
  const eth = await f.get('ETHUSDT');
  assert.strictEqual(fundingAllows(eth).allow, false, '0.05% > 0.03%');
  const btc = await f.get('BTCUSDT');
  assert.strictEqual(fundingAllows(btc).allow, true, '0.01% < 0.03%');
  const sei = await f.get('SEIUSDT');
  assert.strictEqual(sei.fallbackBtc, true);
  assert.strictEqual(sei.symbol, 'BTCUSDT');
  assert.strictEqual(fundingAllows(sei).allow, true);
});

test('funding: Binance geo-blocked → OKX is used, and a 4h funding interval is turned into per-8h', async () => {
  const t = Date.now();
  const f = createFunding({ fetchImpl: fakeFetch([
    [/okx\.com.*BTC-USDT-SWAP/, { code: '0', data: [{ fundingRate: '0.0002', fundingTime: String(t), nextFundingTime: String(t + 4 * 3_600_000) }] }],
  ]) });
  const p = await f.probe();
  assert.strictEqual(p.source, 'okx');
  assert.strictEqual(p.tried[0].ok, false);
  const v = await f.get('BTCUSDT');
  assert.ok(Math.abs(v.rate8h - 0.0004) < 1e-12, '0.02% per 4h = 0.04% per 8h');
  assert.strictEqual(fundingAllows(v).allow, false);
});

test('funding fail-safe: no source / missing data → the entry is skipped with a reason', async () => {
  const f = createFunding({ fetchImpl: fakeFetch([]) });
  assert.strictEqual((await f.probe()).ok, false);
  await assert.rejects(f.get('ETHUSDT'));
  assert.strictEqual(fundingAllows(null).allow, false);
  S.setFunding(f);
  const r = await S.fundingCheck('ETHUSDT');
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /ما انقرت بيانات التمويل/);
  S.setFunding(null);
  assert.strictEqual((await S.fundingCheck('ETHUSDT')).allow, false);
});

test('code-breakout-funding is an exact copy of code-breakout-nobtc plus the entry filter', () => {
  const a = S.BOT['code-breakout-funding'], b = S.BOT['code-breakout-nobtc'];
  assert.strictEqual(a.strategy, b.strategy);
  assert.strictEqual(a.kind, b.kind);
  assert.strictEqual(a.entryFilter, 'funding');
  assert.strictEqual(b.entryFilter, undefined);
});

test('with no funding source and no saved record, the funding bot is not added', async () => {
  const { _internals: T } = require('../server');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try { await T.setupFunding(); } finally { globalThis.fetch = realFetch; }
  assert.strictEqual(T.BOT['code-breakout-funding'], undefined);
  assert.ok(!T.BOTS.some(b => b.id === 'code-breakout-funding'));
  assert.ok(T.BOT['code-trend200-vol'], 'the trend bot stays');
});
