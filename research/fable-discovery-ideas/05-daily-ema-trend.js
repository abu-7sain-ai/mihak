// Idea 05 — Daily trend entry: close crosses above EMA20 while EMA20 > EMA50 and RSI14 > 50.
// Hypothesis: slow daily trend-following with few trades keeps fee drag low and catches the big 2021/2023/2024 legs.
// Params (5): ema20, ema50, rsiLen=14, rsiMin=50, stop=10%. Exit: daily close < EMA20... wait, exit close < EMA50 to avoid whipsaw.
const I = require('../engine/indicators');
module.exports = {
  id: 'daily-ema-trend', tf: '1d',
  prepare(c) {
    const closes = c.map(x => x.close);
    return { c, e20: I.emaS(closes, 20), e50: I.emaS(closes, 50), rsi: I.rsiS(closes, 14) };
  },
  entry(S, i) {
    if (i < 1 || S.e50[i] == null || S.rsi[i] == null || S.e20[i - 1] == null) return false;
    return S.e20[i] > S.e50[i] && S.rsi[i] > 50 && S.c[i - 1].close <= S.e20[i - 1] && S.c[i].close > S.e20[i];
  },
  initialStop(S, i) { return S.c[i].close * 0.90; },
  exit(S, i) { return S.e50[i] != null && S.c[i].close < S.e50[i]; },
  trail() { return null; },
};
