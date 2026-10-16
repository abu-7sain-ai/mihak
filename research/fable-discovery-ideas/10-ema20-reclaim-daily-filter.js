// Idea 10 — variant of 07: adds the coin's own daily regime (last closed daily close > daily SMA50).
// Hypothesis: skipping coins that are still in a daily downtrend removes more of the 2022 losers and the 2024 chop.
// Params (5): emaFast=20, emaMid=50, emaSlow=200, dailySma=50, stop=8%. Exit: close < EMA50.
const I = require('../engine/indicators');
module.exports = {
  id: 'ema20-reclaim-daily-filter', tf: '4h', uses: ['btc4h', 'd1'],
  prepare(c, ctx) {
    const closes = c.map(x => x.close);
    const e20 = I.emaS(closes, 20), e50 = I.emaS(closes, 50), e200 = I.emaS(closes, 200);
    const bc = ctx.btc4h.map(x => x.close);
    const b50 = I.emaS(bc, 50), b200 = I.emaS(bc, 200);
    const bMap = new Map(ctx.btc4h.map((x, k) => [x.t, k]));
    const btcUp = c.map(x => { const k = bMap.get(x.t); return k != null && b200[k] != null && bc[k] > b200[k] && b50[k] > b200[k]; });
    const dSma = I.smaS(ctx.d1.map(x => x.close), 50);
    const di = I.alignDaily(c, '4h', ctx.d1);
    const dailyUp = c.map((_, i) => { const k = di[i]; return k >= 0 && dSma[k] != null && ctx.d1[k].close > dSma[k]; });
    return { c, e20, e50, e200, btcUp, dailyUp };
  },
  entry(S, i) {
    if (i < 1 || S.e200[i] == null || S.e20[i - 1] == null) return false;
    return S.btcUp[i] && S.dailyUp[i] && S.e50[i] > S.e200[i] && S.c[i - 1].close < S.e20[i - 1] && S.c[i].close > S.e20[i];
  },
  initialStop(S, i) { return S.c[i].close * 0.92; },
  exit(S, i) { return S.e50[i] != null && S.c[i].close < S.e50[i]; },
  trail() { return null; },
};
