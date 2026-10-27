// ═══════════════════════════════════════════════════════════════════════════
//  «البتكوين فوق متوسط 200 + تحكم بالتذبذب» — حساب بحت (بدون شبكة)
//  - إغلاق يومي فوق متوسط 200 يوم → نمسك بتكوين، غير كذا كاش 100%
//  - الوزن = min(1, 0.40 / التذبذب السنوي)، والتذبذب = الانحراف المعياري لآخر 30
//    عائد يومي لوغاريتمي × √365 (أرقام ثابتة من الأبحاث، مو معدّلة على البيانات)
//  - نعيد التوزيع بس إذا الفرق بين الوزن المطلوب والحالي أكثر من 10 نقاط
// ═══════════════════════════════════════════════════════════════════════════
const PARAMS = { smaLen: 200, volDays: 30, targetVol: 0.40, band: 0.10, annualDays: 365 };

function sma(values, n) {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

// الانحراف المعياري (عيّنة، n−1) لآخر n عائد لوغاريتمي × √365
function realizedVol(closes, n = PARAMS.volDays) {
  if (closes.length < n + 1) return null;
  const r = [];
  for (let i = closes.length - n; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const mean = r.reduce((a, b) => a + b, 0) / n;
  const varS = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(varS) * Math.sqrt(PARAMS.annualDays);
}

// closes: إغلاقات يومية مغلقة، من الأقدم للأحدث
function targetWeight(closes) {
  const close = closes.at(-1);
  const avg = sma(closes, PARAMS.smaLen);
  const vol = realizedVol(closes);
  if (avg == null || vol == null) return { weight: 0, above: null, sma200: avg, vol, close, reason: 'ما فيه بيانات كفاية' };
  const above = close > avg;
  const weight = above ? Math.min(1, PARAMS.targetVol / vol) : 0;
  return { weight, above, sma200: avg, vol, close, reason: above ? 'فوق متوسط 200' : 'تحت متوسط 200 → كاش' };
}

const needsRebalance = (current, target, band = PARAMS.band) => Math.abs(target - current) > band + 1e-12;

module.exports = { PARAMS, sma, realizedVol, targetWeight, needsRebalance };
