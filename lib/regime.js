// ═══════════════════════════════════════════════════════════════════════════
//  مراقب حالة السوق (كود بس، بدون ذكاء اصطناعي) — إغلاق البتكوين اليومي مقابل
//  متوسط 50 يوم ومتوسط 200 يوم (نفس متوسط 200 اللي يستخدمه فلتر code-breakout-btc).
//    "bull"       = قفل فوق متوسط 50 يومين ورا بعض، والإغلاق فوق متوسط 200
//    "correction" = فوق متوسط 200 بس تحت متوسط 50 (يومين ورا بعض)
//    "bear"       = قفل تحت متوسط 200 يومين ورا بعض
//  يوم واحد بس عكس الحالة ما يقلبها (عشان ما يتذبذب التنبيه).
// ═══════════════════════════════════════════════════════════════════════════
const { smaS } = require('./strategies');

const DAY = 86_400_000;
const CONFIRM_DAYS = 2;

// daily: شموع يومية مغلقة للبتكوين، من الأقدم للأحدث
function computeRegime(daily) {
  const cl = daily.map(d => d.close);
  const s50 = smaS(cl, 50), s200 = smaS(cl, 200);
  let state = null, sinceT = null;
  let a50 = 0, b50 = 0, a200 = 0, b200 = 0;
  for (let i = 0; i < daily.length; i++) {
    if (s200[i] == null || s50[i] == null) continue;
    if (cl[i] > s50[i]) { a50++; b50 = 0; } else { b50++; a50 = 0; }
    if (cl[i] > s200[i]) { a200++; b200 = 0; } else { b200++; a200 = 0; }
    let next = null;
    if (b200 >= CONFIRM_DAYS) next = 'bear';
    else if (a50 >= CONFIRM_DAYS && cl[i] > s200[i]) next = 'bull';
    else if (a200 >= CONFIRM_DAYS && b50 >= CONFIRM_DAYS) next = 'correction';
    if (next && next !== state) { state = next; sinceT = daily[i].t; }
  }
  const last = daily.length - 1;
  if (last < 0 || s200[last] == null || s50[last] == null) return null;
  const r2 = v => Math.round(v * 100) / 100;
  const c = cl[last];
  return {
    state: state || (c < s200[last] ? 'bear' : c > s50[last] ? 'bull' : 'correction'),
    btcClose: r2(c),
    sma50: r2(s50[last]),
    sma200: r2(s200[last]),
    distancePct: r2((c / s200[last] - 1) * 100),      // المسافة عن متوسط 200
    distance50Pct: r2((c / s50[last] - 1) * 100),     // المسافة عن متوسط 50
    daysAbove: a200, daysBelow: b200,                 // أيام متتالية فوق/تحت متوسط 200
    daysAbove50: a50, daysBelow50: b50,               // أيام متتالية فوق/تحت متوسط 50
    since: sinceT != null ? new Date(sinceT).toISOString().slice(0, 10) : null,   // يوم الإغلاق اللي ثبّت الحالة
    asOf: new Date(daily[last].t).toISOString().slice(0, 10),                     // آخر يوم مغلق
    asOfT: daily[last].t,
  };
}

const LABEL = { bull: '🟢 صاعد', correction: '🟡 تصحيح', bear: '🔴 هابط' };
const n0 = v => Math.round(v).toLocaleString('en-US');
function regimeLine(r) {
  if (!r || r.sma50 == null) return 'حالة السوق: ما انحسبت بعد';
  return `${LABEL[r.state]}: البتكوين ${n0(r.btcClose)} · متوسط 50: ${n0(r.sma50)} · متوسط 200: ${n0(r.sma200)}`;
}

// رسالة تيليجرام لما الحالة تتغير
function changeMessage(r) {
  const nums = `البتكوين ${n0(r.btcClose)} · متوسط 50: ${n0(r.sma50)} (${r.distance50Pct > 0 ? '+' : ''}${r.distance50Pct}%) · متوسط 200: ${n0(r.sma200)} (${r.distancePct > 0 ? '+' : ''}${r.distancePct}%)`;
  if (r.state === 'bull') return `📈 البتكوين قفل يومين فوق متوسط 50 يوم وهو فوق متوسط 200 — التصحيح خلص، وقت نرجع الموديلات ونبدأ المسابقة\n${nums}`;
  if (r.state === 'correction') return `🟡 المحك: البتكوين قفل يومين تحت متوسط 50 يوم وهو فوق متوسط 200 — تصحيح\n${nums}`;
  return `🔴 المحك: البتكوين قفل يومين تحت متوسط 200 يوم — السوق هابط\n${nums}`;
}

module.exports = { computeRegime, regimeLine, changeMessage, CONFIRM_DAYS, DAY };
