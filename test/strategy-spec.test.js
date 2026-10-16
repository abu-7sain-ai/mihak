const test = require('node:test');
const assert = require('node:assert');
const { validate, compile } = require('../lib/strategy-spec');
const { parseAnswer, buildPrompt } = require('../scripts/strategy-prompt');
const ind = require('../lib/indicators');

const good = () => ({
  name: 'Calm breakout',
  timeframe: '4h',
  entry: [
    { left: { ind: 'close' }, op: '>', right: { ind: 'donchianHigh', len: 20 } },
    { left: { ind: 'close' }, op: '>', right: { ind: 'ema', len: 200 } },
    { left: { ind: 'ema', len: 200 }, op: '>', right: { ind: 'ema', len: 200, ago: 5 } },
    { filter: 'btcUp' },
  ],
  exit: { stopAtr: 2.5, trailAtr: 3, conditions: [{ left: { ind: 'close' }, op: '<', right: { ind: 'ema', len: 200 } }], maxHoldBars: null },
});

test('a sensible spec is valid and the same value in the same role counts once', () => {
  const v = validate(good());
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.params, 5);   // len 20, len 200, ago 5, stopAtr 2.5, trailAtr 3
});

test('the validator rejects unknown fields, bad ranges, too many numbers and meaningless comparisons', () => {
  const bad = (mutate, re) => { const s = good(); mutate(s); const v = validate(s); assert.ok(!v.ok && v.errors.some(e => re.test(e)), `${re} → ${v.errors}`); };
  bad(s => { s.leverage = 2; }, /unknown field "leverage"/);
  bad(s => { s.entry[0].right.foo = 1; }, /unknown field "foo"/);
  bad(s => { s.exit.stopAtr = 9; }, /stopAtr/);
  bad(s => { s.timeframe = '1h'; }, /timeframe/);
  bad(s => { s.entry[0].right = { ind: 'vwap' }; }, /unknown indicator/);
  bad(s => { s.entry[1] = { left: { ind: 'close' }, op: '>', right: 30000 }; }, /only be compared with another indicator/);
  bad(s => { s.entry[1] = { left: { ind: 'rsi', len: 14 }, op: '>', right: 150 }; }, /0–100/);
  bad(s => { s.entry[1] = { left: { ind: 'rsi', len: 14 }, op: '>', right: { ind: 'close' } }; }, /not comparable/);
  bad(s => { s.entry[1] = { left: { ind: 'rsi', len: 14 }, op: '>', right: 50, mult: 1.2 }; }, /mult/);
  bad(s => { s.entry.push({ left: { ind: 'rsi', len: 7 }, op: '>', right: 55 }, { left: { ind: 'volume' }, op: '>', right: { ind: 'volSma', len: 30 }, mult: 1.5 }); }, /too many numeric parameters/);
  bad(s => { s.exit.maxHoldBars = 2.5; }, /maxHoldBars/);
  bad(s => { s.entry[0].op = '>='; }, /op must be/);
});

test('a compiled spec trades on candles and keeps the stop between 1% and 15%', () => {
  let p = 100;
  const t0 = Date.UTC(2023, 0, 1);
  const c4 = Array.from({ length: 900 }, (_, i) => { const o = p; p *= 1 + 0.004 * Math.sin(i / 40) + 0.002; return { t: t0 + i * 4 * 3_600_000, open: o, high: Math.max(o, p) * 1.003, low: Math.min(o, p) * 0.997, close: p, quoteVolume: 1e6 }; });
  const btc = Array.from({ length: 400 }, (_, i) => ({ t: t0 - 250 * 86_400_000 + i * 86_400_000, open: 1, high: 1, low: 1, close: 100 + i }));
  const s = compile(good(), 'strat-test');
  const S = s.prepare(c4, { btc1d: btc });
  const hits = c4.map((_, i) => s.entry(S, i)).filter(Boolean).length;
  assert.ok(hits > 0);
  const i = c4.findIndex((_, k) => s.entry(S, k));
  const stopPct = (1 - s.initialStop(S, i) / S.cl[i]) * 100;
  assert.ok(stopPct >= 1 && stopPct <= 15);
});

test('RSI matches the existing indicator', () => {
  const v = Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 7) + i * 0.1);
  const s = compile({ name: 'r', timeframe: '4h', entry: [{ left: { ind: 'rsi', len: 14 }, op: '>', right: 50 }], exit: { stopAtr: 2 } }, 'r');
  const S = s.prepare(v.map((x, i) => ({ t: i, open: x, high: x, low: x, close: x, quoteVolume: 1 })), {});
  assert.ok(Math.abs(S.series['rsi:14:'].at(-1) - ind.rsi(v, 14)) < 1e-9);
});

test('the answer parser reads the three sections', () => {
  const txt = `### IDEA\nسطر 1\nسطر 2\n### SPEC\n\`\`\`json\n${JSON.stringify(good())}\n\`\`\`\n### LOSES\nفي السوق العرضي`;
  const a = parseAnswer(txt);
  assert.strictEqual(a.idea, 'سطر 1\nسطر 2');
  assert.strictEqual(a.loses, 'في السوق العرضي');
  assert.ok(validate(a.spec).ok);
  assert.ok(parseAnswer('### SPEC\n{oops').parseError);
});

test('the prompt carries the live rules', () => {
  const p = buildPrompt({ tradeAmount: 100, feePercent: 0.1, slippagePercent: 0.05, startingBalance: 1000, maxConcurrentTrades: 10, dailyLossLimitPercent: 5, cooldownHours: 6, consecutiveLossLimit: 4 });
  assert.match(p, /at most 10 open trades/);
  assert.match(p, /\$50 realized loss/);
  assert.match(p, /SEIUSDT/);
});
