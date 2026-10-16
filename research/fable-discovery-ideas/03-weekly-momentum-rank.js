// Idea 03 — Weekly cross-coin momentum ranking with a BTC regime filter.
// Hypothesis: the coins with the strongest 30-day return keep leading for the next week, while BTC is above its SMA50 (risk-on).
// Params (4): lookback=30 days, btcSma=50, hold=4 coins, stopPct=10.
const I = require('../engine/indicators');
module.exports = {
  id: 'weekly-momentum-rank', tf: '1d', rank: true, hold: 4, stopPctFromEntry: 10, uses: ['btc1d'],
  prepare(c, ctx) {
    const closes = c.map(x => x.close);
    const btcSma = I.smaS(ctx.btc1d.map(x => x.close), 50);
    const bi = I.alignDaily(c, '1d', ctx.btc1d);
    const riskOn = c.map((_, i) => { const k = bi[i]; return k >= 0 && btcSma[k] != null && ctx.btc1d[k].close > btcSma[k]; });
    return { c, closes, riskOn };
  },
  isRebalance(S, i) { return new Date(S.c[i].t).getUTCDay() === 0; },
  score(S, i) {
    if (i < 30 || !S.riskOn[i]) return null;
    const r = S.closes[i] / S.closes[i - 30] - 1;
    return r > 0 ? r : null;
  },
};
