// Idea 06 — Weekly ranking by risk-adjusted momentum (30-day return / 30-day daily-return stdev), BTC above SMA50.
// Hypothesis: dividing by volatility spreads the picks beyond the single hottest coin (idea 03 was 57% SOL) and avoids the most erratic names.
// Params (4): lookback=30 days, btcSma=50, hold=4, stopPct=10.
const I = require('../engine/indicators');
module.exports = {
  id: 'weekly-riskadj-momentum', tf: '1d', rank: true, hold: 4, stopPctFromEntry: 10, uses: ['btc1d'],
  prepare(c, ctx) {
    const closes = c.map(x => x.close);
    const rets = closes.map((x, i) => (i ? x / closes[i - 1] - 1 : 0));
    const sd = I.stdevS(rets, 30);
    const btcSma = I.smaS(ctx.btc1d.map(x => x.close), 50);
    const bi = I.alignDaily(c, '1d', ctx.btc1d);
    const riskOn = c.map((_, i) => { const k = bi[i]; return k >= 0 && btcSma[k] != null && ctx.btc1d[k].close > btcSma[k]; });
    return { c, closes, sd, riskOn };
  },
  isRebalance(S, i) { return new Date(S.c[i].t).getUTCDay() === 0; },
  score(S, i) {
    if (i < 30 || !S.riskOn[i] || !S.sd[i]) return null;
    const r = S.closes[i] / S.closes[i - 30] - 1;
    return r > 0 ? r / S.sd[i] : null;
  },
};
