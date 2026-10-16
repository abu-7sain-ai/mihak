// Idea 02 — Bollinger lower-band dip while above the 4h EMA200.
// Hypothesis: a close below SMA20 - 2*stdev on 4h while the longer trend (EMA200) is up is a short-term washout that mean-reverts to the middle band.
// Params (6): bbLen=20, bbMult=2, emaLen=200, stop=7%, maxHold=24 bars, exit when close > SMA20 (no extra param).
const I = require('../engine/indicators');
module.exports = {
  id: 'bollinger-dip-ema200', tf: '4h', maxHoldBars: 24,
  prepare(c) {
    const closes = c.map(x => x.close);
    const sma = I.smaS(closes, 20), sd = I.stdevS(closes, 20), ema = I.emaS(closes, 200);
    return { c, sma, sd, ema };
  },
  entry(S, i) {
    if (S.sma[i] == null || S.ema[i] == null) return false;
    const x = S.c[i].close;
    return x > S.ema[i] && x < S.sma[i] - 2 * S.sd[i];
  },
  initialStop(S, i) { return S.c[i].close * 0.93; },
  exit(S, i) { return S.sma[i] != null && S.c[i].close > S.sma[i]; },
  trail() { return null; },
};
