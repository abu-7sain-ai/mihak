// Idea 04 — EMA20 reclaim inside an aligned 4h trend (coin EMA50 > EMA200, BTC above its 4h EMA200).
// Hypothesis: a pullback below the 20 EMA that is reclaimed (close crosses back above) while the trend is up resumes the move.
// Not a breakout: the entry is a cross of a moving average, not a prior high.
// Params (4): emaFast=20, emaMid=50, emaSlow=200, stop=8%. Exit: close < EMA50.
const I = require('../engine/indicators');
module.exports = {
  id: 'ema20-reclaim-trend', tf: '4h', uses: ['btc4h'],
  prepare(c, ctx) {
    const closes = c.map(x => x.close);
    const e20 = I.emaS(closes, 20), e50 = I.emaS(closes, 50), e200 = I.emaS(closes, 200);
    const bEma = I.emaS(ctx.btc4h.map(x => x.close), 200);
    const bMap = new Map(ctx.btc4h.map((x, k) => [x.t, k]));
    const btcUp = c.map(x => { const k = bMap.get(x.t); return k != null && bEma[k] != null && ctx.btc4h[k].close > bEma[k]; });
    return { c, e20, e50, e200, btcUp };
  },
  entry(S, i) {
    if (i < 1 || S.e200[i] == null || S.e20[i - 1] == null) return false;
    return S.btcUp[i] && S.e50[i] > S.e200[i] && S.c[i - 1].close < S.e20[i - 1] && S.c[i].close > S.e20[i];
  },
  initialStop(S, i) { return S.c[i].close * 0.92; },
  exit(S, i) { return S.e50[i] != null && S.c[i].close < S.e50[i]; },
  trail() { return null; },
};
