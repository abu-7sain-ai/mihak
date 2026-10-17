// ═══════════════════════════════════════════════════════════════════════════
//  مراقب حالة السوق (كود بس، بدون ذكاء اصطناعي)
//  نفس تعريف فلتر code-breakout-btc: إغلاق البتكوين اليومي مقابل متوسط 200 يوم.
//  "صاعد" = قفل فوق المتوسط يومين ورا بعض، و"هابط" = قفل تحته يومين ورا بعض.
//  يوم واحد بس عكس الحالة ما يقلبها (عشان ما يتذبذب التنبيه).
// ═══════════════════════════════════════════════════════════════════════════
const { smaS } = require('./strategies');

const DAY = 86_400_000;
const CONFIRM_DAYS = 2;

// daily: شموع يومية مغلقة للبتكوين، من الأقدم للأحدث
function computeRegime(daily) {
  const cl = daily.map(d => d.close);
  const sma = smaS(cl, 200);
  let state = null, sinceT = null, above = 0, below = 0;
  for (let i = 0; i < daily.length; i++) {
    if (sma[i] == null) continue;
    if (cl[i] > sma[i]) { above++; below = 0; } else { below++; above = 0; }
    if (state !== 'bull' && above >= CONFIRM_DAYS) { state = 'bull'; sinceT = daily[i].t; }
    else if (state !== 'bear' && below >= CONFIRM_DAYS) { state = 'bear'; sinceT = daily[i].t; }
  }
  const last = daily.length - 1;
  if (last < 0 || sma[last] == null) return null;
  const r2 = v => Math.round(v * 100) / 100;
  return {
    state: state || (cl[last] > sma[last] ? 'bull' : 'bear'),
    btcClose: r2(cl[last]),
    sma200: r2(sma[last]),
    distancePct: r2((cl[last] / sma[last] - 1) * 100),
    daysAbove: above,
    daysBelow: below,
    since: sinceT != null ? new Date(sinceT).toISOString().slice(0, 10) : null,   // يوم الإغلاق اللي ثبّت الحالة
    asOf: new Date(daily[last].t).toISOString().slice(0, 10),                     // آخر يوم مغلق
    asOfT: daily[last].t,
  };
}

const n0 = v => Math.round(v).toLocaleString('en-US');
function regimeLine(r) {
  if (!r) return 'حالة السوق: ما انحسبت بعد';
  const pct = `${r.distancePct > 0 ? '+' : ''}${r.distancePct}%`;
  const pos = r.distancePct > 0 ? 'فوق' : 'تحت';
  const run = r.daysAbove > 0 ? `له ${r.daysAbove} يوم فوق` : `له ${r.daysBelow} يوم تحت`;
  const head = r.state === 'bull' ? '🐂 السوق صاعد' : '🐻 السوق هابط';
  return `${head}: البتكوين ${n0(r.btcClose)} ${pos} متوسط 200 يوم (${n0(r.sma200)}) بـ ${pct} · ${run}`;
}

module.exports = { computeRegime, regimeLine, CONFIRM_DAYS, DAY };
