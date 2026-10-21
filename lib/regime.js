// ═══════════════════════════════════════════════════════════════════════════
//  مراقب حالة السوق (كود بس، بدون ذكاء اصطناعي) — نفس الدالة للمراقب الحي
//  وللبحث (research/regimes.js) وللمايسترو، فالحي = الاختبار.
//  إغلاق البتكوين اليومي مقابل متوسط 50 يوم ومتوسط 200 يوم:
//    "bull"       = قفل فوق متوسط 50 يومين ورا بعض، والإغلاق فوق متوسط 200
//    "correction" = فوق متوسط 200 بس تحت متوسط 50 (يومين ورا بعض)
//    "bear"       = قفل تحت متوسط 200 يومين ورا بعض
//  "choppy" (متذبذب) = علامة إضافية: ADX(14) اليومي تحت 20 يومين ورا بعض
//  (وتنطفي بعد يومين فوق 20). يوم واحد بس عكس الحالة ما يقلبها.
//  كل يوم ينحسب من الشموع اللي سكّرت لين ذاك اليوم بس (ما فيه نظر للمستقبل).
// ═══════════════════════════════════════════════════════════════════════════
const { smaS, adxS } = require('./strategies');

const DAY = 86_400_000;
const CONFIRM_DAYS = 2;
const CHOPPY_ADX = 20;

// يوم بيوم: الحالة والعلامة كما كانت معروفة بعد إغلاق كل يوم
function regimeSeries(daily) {
  const cl = daily.map(d => d.close);
  const s50 = smaS(cl, 50), s200 = smaS(cl, 200), adx = adxS(daily, 14);
  const out = new Array(daily.length).fill(null);
  let state = null, sinceT = null, choppy = false, choppySinceT = null;
  let a50 = 0, b50 = 0, a200 = 0, b200 = 0, lowAdx = 0, highAdx = 0;
  for (let i = 0; i < daily.length; i++) {
    if (s200[i] == null || s50[i] == null) continue;
    if (cl[i] > s50[i]) { a50++; b50 = 0; } else { b50++; a50 = 0; }
    if (cl[i] > s200[i]) { a200++; b200 = 0; } else { b200++; a200 = 0; }
    let next = null;
    if (b200 >= CONFIRM_DAYS) next = 'bear';
    else if (a50 >= CONFIRM_DAYS && cl[i] > s200[i]) next = 'bull';
    else if (a200 >= CONFIRM_DAYS && b50 >= CONFIRM_DAYS) next = 'correction';
    if (next && next !== state) { state = next; sinceT = daily[i].t; }
    if (adx[i] != null) {
      if (adx[i] < CHOPPY_ADX) { lowAdx++; highAdx = 0; } else { highAdx++; lowAdx = 0; }
      if (!choppy && lowAdx >= CONFIRM_DAYS) { choppy = true; choppySinceT = daily[i].t; }
      else if (choppy && highAdx >= CONFIRM_DAYS) { choppy = false; choppySinceT = daily[i].t; }
    }
    const st = state || (cl[i] < s200[i] ? 'bear' : cl[i] > s50[i] ? 'bull' : 'correction');
    out[i] = {
      t: daily[i].t, state: st, choppy, bucket: choppy ? 'choppy' : st,
      close: cl[i], sma50: s50[i], sma200: s200[i], adx: adx[i],
      a50, b50, a200, b200, sinceT, choppySinceT,
    };
  }
  return out;
}

// آخر يوم مغلق (للمراقب الحي و get_overview)
function computeRegime(daily) {
  const r = regimeSeries(daily).at(-1);
  if (!r) return null;
  const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
  return {
    state: r.state,
    choppy: r.choppy,
    bucket: r.bucket,                                   // اللي يستخدمه المايسترو: choppy يغلب
    btcClose: r2(r.close),
    sma50: r2(r.sma50),
    sma200: r2(r.sma200),
    adx14: r2(r.adx),
    distancePct: r2((r.close / r.sma200 - 1) * 100),     // المسافة عن متوسط 200
    distance50Pct: r2((r.close / r.sma50 - 1) * 100),    // المسافة عن متوسط 50
    daysAbove: r.a200, daysBelow: r.b200,               // أيام متتالية فوق/تحت متوسط 200
    daysAbove50: r.a50, daysBelow50: r.b50,             // أيام متتالية فوق/تحت متوسط 50
    since: r.sinceT != null ? new Date(r.sinceT).toISOString().slice(0, 10) : null,
    choppySince: r.choppySinceT != null ? new Date(r.choppySinceT).toISOString().slice(0, 10) : null,
    asOf: new Date(r.t).toISOString().slice(0, 10),
    asOfT: r.t,
  };
}

// لكل شمعة (4h أو 1d): "الخانة" المعروفة وقت إغلاقها = آخر يوم بتكوين سكّر لين ذاك الوقت
function bucketsFor(candles, tfMs, btcDaily, series = regimeSeries(btcDaily)) {
  const out = new Array(candles.length).fill(null);
  let k = -1;
  for (let i = 0; i < candles.length; i++) {
    const closeAt = candles[i].t + tfMs;
    while (k + 1 < btcDaily.length && btcDaily[k + 1].t + DAY <= closeAt) k++;
    out[i] = k >= 0 && series[k] ? series[k].bucket : null;
  }
  return out;
}

const LABEL = { bull: '🟢 صاعد', correction: '🟡 تصحيح', bear: '🔴 هابط' };
const BUCKET_AR = { bull: 'صاعد', correction: 'تصحيح', bear: 'هابط', choppy: 'متذبذب' };
const n0 = v => Math.round(v).toLocaleString('en-US');
function regimeLine(r) {
  if (!r || r.sma50 == null) return 'حالة السوق: ما انحسبت بعد';
  return `${LABEL[r.state]}${r.choppy ? ' · 〰️ متذبذب' : ''}: البتكوين ${n0(r.btcClose)} · متوسط 50: ${n0(r.sma50)} · متوسط 200: ${n0(r.sma200)}`;
}

// رسالة تيليجرام لما الحالة تتغير (علامة التذبذب ما ترسل تنبيه)
function changeMessage(r) {
  const nums = `البتكوين ${n0(r.btcClose)} · متوسط 50: ${n0(r.sma50)} (${r.distance50Pct > 0 ? '+' : ''}${r.distance50Pct}%) · متوسط 200: ${n0(r.sma200)} (${r.distancePct > 0 ? '+' : ''}${r.distancePct}%)`;
  if (r.state === 'bull') return `📈 البتكوين قفل يومين فوق متوسط 50 يوم وهو فوق متوسط 200 — التصحيح خلص، وقت نرجع الموديلات ونبدأ المسابقة\n${nums}`;
  if (r.state === 'correction') return `🟡 المحك: البتكوين قفل يومين تحت متوسط 50 يوم وهو فوق متوسط 200 — تصحيح\n${nums}`;
  return `🔴 المحك: البتكوين قفل يومين تحت متوسط 200 يوم — السوق هابط\n${nums}`;
}

module.exports = { regimeSeries, computeRegime, bucketsFor, regimeLine, changeMessage, BUCKET_AR, CONFIRM_DAYS, CHOPPY_ADX, DAY };
