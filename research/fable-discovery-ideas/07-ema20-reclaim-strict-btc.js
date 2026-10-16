// Idea 07 — variant of 04: same EMA20 reclaim, but the BTC regime requires BTC 4h EMA50 > EMA200 as well as close > EMA200.
// Hypothesis: 2022 losses in idea 04 came from bear-market rallies where BTC briefly popped above its 4h EMA200; a slower regime (golden cross) filters them.
// Params (4): emaFast=20, emaMid=50, emaSlow=200, stop=8%. Exit: close < EMA50.
const I = require('../engine/indicators');
module.exports = {
  id: 'ema20-reclaim-strict-btc', tf: '4h', uses: ['btc4h'],
  prepare(c, ctx) {
    const closes = c.map(x => x.close);
    const e20 = I.emaS(closes, 20), e50 = I.emaS(closes, 50), e200 = I.emaS(closes, 200);
    const bc = ctx.btc4h.map(x => x.close);
    const b50 = I.emaS(bc, 50), b200 = I.emaS(bc, 200);
    const bMap = new Map(ctx.btc4h.map((x, k) => [x.t, k]));
    const btcUp = c.map(x => { const k = bMap.get(x.t); return k != null && b200[k] != null && bc[k] > b200[k] && b50[k] > b200[k]; });
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
