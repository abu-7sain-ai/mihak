const test = require('node:test');
const assert = require('node:assert');
const ind = require('../lib/indicators');
const { parseVote, memberPrompts, chairPrompt } = require('../lib/ai');

test('EMA of a constant series is that constant', () => {
  assert.deepStrictEqual(ind.ema([5, 5, 5, 5, 5], 3), [5, 5, 5]);
});

test('RSI is 100 on a straight rise and near 0 on a straight fall', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.strictEqual(ind.rsi(up), 100);
  assert.ok(ind.rsi(down) < 1);
});

test('summary reports price above EMAs in an uptrend', () => {
  const candles = Array.from({ length: 260 }, (_, i) => {
    const c = 100 * 1.01 ** i;
    return { open: c / 1.01, high: c * 1.005, low: c / 1.015, close: c, volume: 1000 };
  });
  const s = ind.summarize(candles);
  assert.ok(s.vsEma20 > 0 && s.vsEma50 > 0 && s.vsEma200 > 0);
  assert.ok(s.rsi14 > 70);
  assert.ok(s.atrPct > 0);
});

test('vote parser keeps reasons short and rejects bad votes', () => {
  const v = parseVote('{"vote":"enter","confidence":"81","reason":"one two three four five six seven eight nine ten eleven twelve thirteen"}');
  assert.strictEqual(v.vote, 'ENTER');
  assert.strictEqual(v.confidence, 81);
  assert.ok(v.reason.split(' ').length <= 12);
  assert.strictEqual(parseVote('{"decision":"SKIP","confidence":40,"reason":"x"}', 'decision').vote, 'SKIP');
  assert.throws(() => parseVote('{"vote":"MAYBE","confidence":50}'));
});

test('each expert prompt only carries its own data', () => {
  const rules = { takeProfitPercent: 1, stopLossPercent: -0.5, maxTradeTimeMinutes: 120, feePercent: 0.1, slippagePercent: 0.05 };
  const plan = { takeProfitPercent: 4, stopLossPercent: -2, maxHoldHours: 12 };
  const p = memberPrompts({ symbol: 'ETHUSDT', rules, plan, trend: { h4: { rsi14: 61 }, d1: { rsi14: 55 } }, news: 'NEWS_TEXT', risk: { atr4hPct: 2.1 } });
  assert.ok(p.trend.includes('rsi14') && !p.trend.includes('NEWS_TEXT'));
  assert.ok(p.news.includes('NEWS_TEXT') && !p.news.includes('rsi14'));
  assert.ok(p.risk.includes('atr4hPct') && !p.risk.includes('NEWS_TEXT'));
  assert.ok(p.risk.includes('stop -2%') && p.trend.includes('target +4%'));
  const c = chairPrompt({ symbol: 'ETHUSDT', plan, scoutReason: 'r', scoutConfidence: 70, votes: { trend: { vote: 'ENTER', confidence: 70, reason: 'up' } } });
  assert.ok(c.includes('trend: ENTER (confidence 70) — up'));
});
