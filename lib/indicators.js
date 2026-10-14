// ═══════════════════════════════════════════════════════════════════════════
//  المؤشرات الفنية — تنحسب بالكود من شموع حقيقية، والموديل يقرأ النتيجة بس
//  candles: [{ open, high, low, close, volume }] من الأقدم للأحدث
// ═══════════════════════════════════════════════════════════════════════════

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const out = [prev];
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function macdHistogram(values) {
  const fast = ema(values, 12), slow = ema(values, 26);
  if (!slow.length) return null;
  const offset = fast.length - slow.length;
  const line = slow.map((s, i) => fast[i + offset] - s);
  const signal = ema(line, 9);
  if (!signal.length) return null;
  return line.at(-1) - signal.at(-1);
}

function bollingerPosition(values, period = 20) {
  if (values.length < period) return null;
  const w = values.slice(-period);
  const mean = w.reduce((s, v) => s + v, 0) / period;
  const sd = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  if (sd === 0) return 0.5;
  // 0 = الحد السفلي، 1 = الحد العلوي
  return (values.at(-1) - (mean - 2 * sd)) / (4 * sd);
}

function atrPercent(candles, period = 14) {
  if (candles.length <= period) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p)));
  }
  const atr = trs.slice(-period).reduce((s, v) => s + v, 0) / period;
  return atr / candles.at(-1).close * 100;
}

const r2 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

/** ملخص فريم واحد بأرقام قليلة يفهمها الموديل */
function summarize(candles) {
  const closes = candles.map(c => c.close);
  const price = closes.at(-1);
  const pctFrom = (x) => (x ? r2((price / x - 1) * 100) : null);
  const e20 = ema(closes, 20).at(-1), e50 = ema(closes, 50).at(-1), e200 = ema(closes, 200).at(-1);
  const vols = candles.map(c => c.volume);
  const avgVol = vols.slice(-21, -1).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(20, vols.length - 1));
  return {
    price: r2(price),
    vsEma20: pctFrom(e20),
    vsEma50: pctFrom(e50),
    vsEma200: pctFrom(e200),
    rsi14: r2(rsi(closes)),
    macdHist: r2(macdHistogram(closes)),
    bollingerPos: r2(bollingerPosition(closes)),
    atrPct: r2(atrPercent(candles)),
    volumeVsAvg: avgVol ? r2(vols.at(-1) / avgVol) : null,
    candles: candles.length,
  };
}

module.exports = { ema, rsi, macdHistogram, bollingerPosition, atrPercent, summarize };
