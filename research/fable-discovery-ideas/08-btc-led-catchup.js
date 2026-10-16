// Idea 08 — BTC-led catch-up: BTC closes a 4h candle up more than 2% and the alt rose less than BTC (lagged), BTC above its 4h EMA200.
// Hypothesis: alts follow BTC with a lag; buying the laggards right after a strong BTC candle and holding 6 candles captures the catch-up.
// Params (4): btcMove=2%, emaSlow=200, maxHold=6, stop=5%. No signal exit (time exit only).
const I = require('../engine/indicators');
module.exports = {
  id: 'btc-led-catchup', tf: '4h', uses: ['btc4h'], maxHoldBars: 6,
  prepare(c, ctx) {
    const bc = ctx.btc4h.map(x => x.close);
    const b200 = I.emaS(bc, 200);
    const bMap = new Map(ctx.btc4h.map((x, k) => [x.t, k]));
    const sig = c.map((x, i) => {
      const k = bMap.get(x.t);
      if (k == null || k < 1 || b200[k] == null || i < 1) return false;
      const bRet = bc[k] / bc[k - 1] - 1, aRet = x.close / c[i - 1].close - 1;
      return bc[k] > b200[k] && bRet > 0.02 && aRet < bRet;
    });
    return { c, sig };
  },
  entry(S, i) { return S.sig[i]; },
  initialStop(S, i) { return S.c[i].close * 0.95; },
  exit() { return false; },
  trail() { return null; },
};
