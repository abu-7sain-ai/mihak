const test = require('node:test');
const assert = require('node:assert');
const { regimeSeries, bucketsFor, computeRegime } = require('../lib/regime');
const { buildMaestro } = require('../lib/maestro');

const DAY = 86_400_000, H4 = 4 * 3_600_000;

// بتكوين يومي صناعي ثابت (نفس النتيجة كل مرة)، فيه صعود ونزول وتذبذب
function daily(n = 900) {
  let x = 3, p = 100;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x / 2 ** 31; };
  const t0 = Date.UTC(2022, 0, 1);
  return Array.from({ length: n }, (_, i) => {
    const o = p; p *= 1 + 0.004 * Math.sin(i / 60) + (rnd() - 0.5) * 0.04;
    return { t: t0 + i * DAY, open: o, high: Math.max(o, p) * (1 + rnd() * 0.02), low: Math.min(o, p) * (1 - rnd() * 0.02), close: p };
  });
}

test('the regime series has no lookahead: each day equals the series computed with data up to that day only', () => {
  const d = daily();
  const full = regimeSeries(d);
  for (const n of [260, 400, 555, 700, 899]) {
    const cut = regimeSeries(d.slice(0, n + 1));
    assert.deepStrictEqual(cut[n], full[n], `day ${n}`);
  }
  const buckets = new Set(full.filter(Boolean).map(r => r.bucket));
  for (const b of ['bull', 'correction', 'bear', 'choppy']) assert.ok(buckets.has(b), `synthetic data visits ${b}`);
  const live = computeRegime(d);
  assert.strictEqual(live.bucket, full.at(-1).bucket);
  assert.ok('choppy' in live && 'adx14' in live);
});

test('a 4h candle only sees BTC days that had closed by its own close', () => {
  const d = daily(300);
  const s = regimeSeries(d);
  const dayK = 280;
  const c4 = [
    { t: d[dayK].t + 16 * 3_600_000 },   // 16:00–20:00: اليوم نفسه ما سكّر → حالة أمس
    { t: d[dayK].t + 20 * 3_600_000 },   // 20:00–24:00: يسكّر مع اليوم → حالة اليوم
  ];
  const b = bucketsFor(c4, H4, d, s);
  assert.strictEqual(b[0], s[dayK - 1].bucket);
  assert.strictEqual(b[1], s[dayK].bucket);
});

test('maestro enters only with strategies that are ON for the candle\'s regime, and exits by the opener\'s rules', () => {
  const d = daily(400);
  const s = regimeSeries(d);
  const c4 = d.slice(250).flatMap(x => [0, 1, 2, 3, 4, 5].map(h => ({ t: x.t + h * H4, open: 1, high: 1, low: 1, close: 1 })));
  const stub = (id, exitWhen) => ({ id, tf: '4h', prepare: () => ({}), entry: () => true, initialStop: () => 0.9, exit: (S, i) => exitWhen(i), trail: () => null });
  const byId = { A: stub('A', () => false), B: { ...stub('B', () => true), maxHoldBars: 6 } };
  const m = buildMaestro({ version: 'test', on: { bull: ['A'], bear: ['B'], correction: [], choppy: [] } }, byId);
  const S = m.prepare(c4, { btc1d: d });
  const want = bucketsFor(c4, H4, d, s);
  for (let i = 0; i < c4.length; i++) {
    const e = m.entry(S, i);
    assert.strictEqual(e, want[i] === 'bull' || want[i] === 'bear', `candle ${i} (${want[i]})`);
    if (e) assert.strictEqual(m.subIdAt(S, i), want[i] === 'bull' ? 'A' : 'B');
  }
  assert.strictEqual(m.exit(S, 10, { sub: 'A' }), false);
  assert.strictEqual(m.exit(S, 10, { sub: 'B' }), true);
  assert.strictEqual(m.exit(S, 3, { sub: 'A', idx: 2 }), false, "A has no max hold");
  const bearAt = want.indexOf('bear');
  if (bearAt >= 0) { m.entry(S, bearAt); assert.strictEqual(m.holdBarsAt(S, bearAt), 6); }
  assert.throws(() => buildMaestro({ on: { bull: ['X'] } }, byId), /unknown strategy X/);
});
