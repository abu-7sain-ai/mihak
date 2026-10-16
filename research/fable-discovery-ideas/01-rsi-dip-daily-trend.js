// Idea 01 — RSI dip inside a daily uptrend.
// Hypothesis: in a daily uptrend (close above SMA50 daily), short 4h oversold dips (RSI14 < 30) tend to recover.
// Params (6): dailySma=50, rsiLen=14, rsiBuy=30, rsiSell=55, maxHold=30 bars, stop=6%.
const I = require('../engine/indicators');
module.exports = {
  id: 'rsi-dip-daily-trend', tf: '4h', uses: ['d1'], maxHoldBars: 30,
  prepare(c, ctx) {
    const closes = c.map(x => x.close);
    const rsi = I.rsiS(closes, 14);
    const dSma = I.smaS(ctx.d1.map(x => x.close), 50);
    const di = I.alignDaily(c, '4h', ctx.d1);
    const up = c.map((_, i) => { const k = di[i]; return k >= 0 && dSma[k] != null && ctx.d1[k].close > dSma[k]; });
    return { c, rsi, up };
  },
  entry(S, i) { return S.rsi[i] != null && S.up[i] && S.rsi[i] < 30; },
  initialStop(S, i) { return S.c[i].close * 0.94; },
  exit(S, i, pos) { return S.rsi[i] != null && S.rsi[i] > 55; },
  trail() { return null; },
};
