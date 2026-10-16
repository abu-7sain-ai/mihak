// ═══════════════════════════════════════════════════════════════════════════
//  مواصفات استراتيجية بصيغة JSON (مو كود): النماذج تكتبها، والسيرفر ينفذها.
//  validate(spec) يرفض أي حقل غريب أو رقم برا الحدود.
//  compile(spec) يرجع استراتيجية بنفس واجهة lib/strategies.js، فالاختبار
//  التاريخي والمتسابق الحي يشغّلون نفس الشي بالضبط.
//
//  {
//    "name": "short English name",
//    "timeframe": "4h",
//    "entry": [ condition, ... ],            // 1–6 شروط، كلها لازم تتحقق (AND) على إغلاق شمعة 4 ساعات
//    "exit": {
//      "stopAtr": 2.5,                       // وقف أولي = الإغلاق − stopAtr × ATR14 (محصور 1%–15%)
//      "trailAtr": 3 | null,                 // وقف ملاحق = أعلى سعر من الدخول − trailAtr × ATR14 (يطلع بس)
//      "conditions": [ condition, ... ],     // 0–3 شروط خروج، أي وحد يتحقق = خروج (OR) على الإغلاق
//      "maxHoldBars": 42 | null              // أطول مدة بعدد شموع 4 ساعات
//    }
//  }
//  condition = { "left": operand, "op": ">"|"<"|"crossAbove"|"crossBelow", "right": operand, "mult"?: number }
//            | { "filter": "btcUp" }        // البتكوين: إغلاق يومي فوق متوسط 200 يوم
//  operand   = number | { "ind": name, "len"?: int, "k"?: number, "ago"?: int }
// ═══════════════════════════════════════════════════════════════════════════
const st = require('./strategies');

const LIMITS = {
  len: [2, 300], k: [0.5, 4], ago: [1, 10], mult: [0.5, 3],
  stopAtr: [1, 4], trailAtr: [1, 6], maxHoldBars: [6, 180],
  entry: [1, 6], exitConditions: [0, 3], params: 6,
  stopPct: [1, 15],
};
// المؤشرات المسموحة: هل تحتاج طول، و k، وش نوع الأرقام اللي ينقارن فيها
const IND = {
  close: {}, open: {}, high: {}, low: {},
  ema: { len: true }, sma: { len: true },
  rsi: { len: true, scale: [0, 100] },
  atrPct: { scale: [0, 50] },                         // ATR14 كنسبة من السعر
  donchianHigh: { len: true }, donchianLow: { len: true },   // أعلى/أدنى آخر len شمعة (بدون الحالية)
  bbUpper: { len: true, k: true }, bbMid: { len: true }, bbLower: { len: true, k: true },
  macdLine: { zeroOnly: true }, macdSignal: { zeroOnly: true }, macdHist: { zeroOnly: true },   // 12/26/9
  volume: {}, volSma: { len: true },                  // حجم التداول بالدولار
};
const PRICE_LIKE = new Set(['close', 'open', 'high', 'low', 'ema', 'sma', 'donchianHigh', 'donchianLow', 'bbUpper', 'bbMid', 'bbLower']);
const OPS = new Set(['>', '<', 'crossAbove', 'crossBelow']);
const group = ind => (PRICE_LIKE.has(ind) ? 'price' : ind.startsWith('macd') ? 'macd' : ind === 'volume' || ind === 'volSma' ? 'volume' : ind);

const isInt = x => Number.isInteger(x);
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const inRange = (x, [lo, hi]) => isNum(x) && x >= lo && x <= hi;
const onlyKeys = (o, keys, where, errs) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`${where}: unknown field "${k}"`);
};

function validate(spec) {
  const errs = [];
  const params = new Set();                           // نفس الرقم بنفس الدور ينحسب مرة وحدة
  const P = (role, v) => params.add(`${role}:${v}`);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['spec must be a JSON object'] };
  onlyKeys(spec, ['name', 'timeframe', 'entry', 'exit'], 'spec', errs);
  if (typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > 60) errs.push('name: string, 1–60 chars');
  if (spec.timeframe !== '4h') errs.push('timeframe must be "4h"');

  function operand(o, where) {
    if (isNum(o)) return { kind: 'const', value: o };
    if (!o || typeof o !== 'object' || Array.isArray(o)) { errs.push(`${where}: operand must be a number or {"ind": ...}`); return null; }
    onlyKeys(o, ['ind', 'len', 'k', 'ago'], where, errs);
    const def = IND[o.ind];
    if (!def) { errs.push(`${where}: unknown indicator "${o.ind}"`); return null; }
    if (def.len) { if (!isInt(o.len) || !inRange(o.len, LIMITS.len)) errs.push(`${where}: ${o.ind} needs integer "len" ${LIMITS.len.join('–')}`); else P('len', o.len); }
    else if (o.len !== undefined) errs.push(`${where}: ${o.ind} takes no "len"`);
    if (def.k) { if (!inRange(o.k, LIMITS.k)) errs.push(`${where}: ${o.ind} needs "k" ${LIMITS.k.join('–')}`); else P('k', o.k); }
    else if (o.k !== undefined) errs.push(`${where}: ${o.ind} takes no "k"`);
    if (o.ago !== undefined) { if (!isInt(o.ago) || !inRange(o.ago, LIMITS.ago)) errs.push(`${where}: "ago" must be an integer ${LIMITS.ago.join('–')}`); else P('ago', o.ago); }
    return { kind: 'ind', ind: o.ind, def };
  }

  function condition(c, where) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) { errs.push(`${where}: condition must be an object`); return; }
    if ('filter' in c) {
      onlyKeys(c, ['filter'], where, errs);
      if (c.filter !== 'btcUp') errs.push(`${where}: only filter allowed is "btcUp"`);
      return;
    }
    onlyKeys(c, ['left', 'op', 'right', 'mult'], where, errs);
    if (!OPS.has(c.op)) errs.push(`${where}: op must be one of > < crossAbove crossBelow`);
    const L = operand(c.left, `${where}.left`), R = operand(c.right, `${where}.right`);
    if (!L || !R) return;
    if (L.kind === 'const') { errs.push(`${where}: left side must be an indicator`); return; }
    if (c.mult !== undefined) {
      if (!inRange(c.mult, LIMITS.mult)) errs.push(`${where}: "mult" must be ${LIMITS.mult.join('–')}`);
      else P('mult', c.mult);
      if (R.kind === 'const') errs.push(`${where}: "mult" only scales an indicator on the right`);
    }
    if (R.kind === 'const') {
      const scale = L.def.scale || (L.def.zeroOnly ? [0, 0] : null);
      if (!scale) errs.push(`${where}: ${c.left.ind} can only be compared with another indicator (prices differ per coin)`);
      else if (!inRange(R.value, scale)) errs.push(`${where}: number for ${c.left.ind} must be ${scale[0]}–${scale[1]}`);
      else if (R.value !== 0) P('const', R.value);
    } else if (group(L.ind) !== group(R.ind)) {
      errs.push(`${where}: ${c.left.ind} and ${c.right.ind} are not comparable`);
    }
  }

  if (!Array.isArray(spec.entry) || spec.entry.length < LIMITS.entry[0] || spec.entry.length > LIMITS.entry[1]) errs.push(`entry: ${LIMITS.entry.join('–')} conditions`);
  else spec.entry.forEach((c, i) => condition(c, `entry[${i}]`));

  const x = spec.exit;
  if (!x || typeof x !== 'object' || Array.isArray(x)) errs.push('exit: object required');
  else {
    onlyKeys(x, ['stopAtr', 'trailAtr', 'conditions', 'maxHoldBars'], 'exit', errs);
    if (!inRange(x.stopAtr, LIMITS.stopAtr)) errs.push(`exit.stopAtr: ${LIMITS.stopAtr.join('–')} (required)`); else P('stopAtr', x.stopAtr);
    if (x.trailAtr != null) { if (!inRange(x.trailAtr, LIMITS.trailAtr)) errs.push(`exit.trailAtr: ${LIMITS.trailAtr.join('–')} or null`); else P('trailAtr', x.trailAtr); }
    if (x.maxHoldBars != null) { if (!isInt(x.maxHoldBars) || !inRange(x.maxHoldBars, LIMITS.maxHoldBars)) errs.push(`exit.maxHoldBars: integer ${LIMITS.maxHoldBars.join('–')} or null`); else P('maxHold', x.maxHoldBars); }
    const xc = x.conditions ?? [];
    if (!Array.isArray(xc) || xc.length > LIMITS.exitConditions[1]) errs.push(`exit.conditions: array of 0–${LIMITS.exitConditions[1]}`);
    else xc.forEach((c, i) => condition(c, `exit.conditions[${i}]`));
  }
  if (params.size > LIMITS.params) errs.push(`too many numeric parameters: ${params.size} (max ${LIMITS.params}; the same value in the same role counts once)`);
  return { ok: errs.length === 0, errors: errs, params: params.size };
}

// ── التنفيذ: نفس واجهة lib/strategies.js ──────────────────────────────────────
function compile(spec, id) {
  const v = validate(spec);
  if (!v.ok) throw new Error(`invalid spec: ${v.errors.join('; ')}`);
  const x = spec.exit;
  const keyOf = o => (isNum(o) ? null : [o.ind, o.len ?? '', o.k ?? ''].join(':'));

  function series(o, c, cl, cache) {
    const key = keyOf(o);
    if (cache[key]) return cache[key];
    const { ind, len, k } = o;
    const qv = c.map(b => b.quoteVolume ?? b.volume * b.close);
    let s;
    switch (ind) {
      case 'close': case 'open': case 'high': case 'low': s = c.map(b => b[ind]); break;
      case 'ema': s = st.emaS(cl, len); break;
      case 'sma': s = st.smaS(cl, len); break;
      case 'rsi': s = rsiS(cl, len); break;
      case 'atrPct': { const a = st.atrS(c, 14); s = a.map((v, i) => (v == null ? null : v / cl[i] * 100)); break; }
      case 'donchianHigh': s = st.prevHighestS(c.map(b => b.high), len); break;
      case 'donchianLow': s = st.prevLowestS(c.map(b => b.low), len); break;
      case 'bbMid': s = st.smaS(cl, len); break;
      case 'bbUpper': case 'bbLower': {
        const m = st.smaS(cl, len), sign = ind === 'bbUpper' ? 1 : -1;
        s = m.map((mv, i) => {
          if (mv == null) return null;
          let q = 0; for (let j = i - len + 1; j <= i; j++) q += (cl[j] - mv) ** 2;
          return mv + sign * k * Math.sqrt(q / len);
        });
        break;
      }
      case 'macdLine': case 'macdSignal': case 'macdHist': {
        const m = st.macdS(cl);
        s = ind === 'macdLine' ? m.line : ind === 'macdSignal' ? m.signal
          : m.line.map((l, i) => (l != null && m.signal[i] != null ? l - m.signal[i] : null));
        break;
      }
      case 'volume': s = qv; break;
      case 'volSma': s = st.smaS(qv, len); break;
    }
    return (cache[key] = s);
  }

  const val = (S, o, i) => {
    if (isNum(o)) return o;
    const j = i - (o.ago || 0);
    const v = j >= 0 ? S.series[keyOf(o)][j] : null;
    return v == null || !Number.isFinite(v) ? null : v;
  };
  function test(S, c, i) {
    if (c.filter === 'btcUp') return S.btcUp[i] === true;
    const m = c.mult ?? 1;
    const a = val(S, c.left, i), b = val(S, c.right, i);
    if (a == null || b == null) return false;
    if (c.op === '>') return a > b * m;
    if (c.op === '<') return a < b * m;
    const a0 = val(S, c.left, i - 1), b0 = val(S, c.right, i - 1);
    if (a0 == null || b0 == null) return false;
    if (c.op === 'crossAbove') return a0 <= b0 * m && a > b * m;
    return a0 >= b0 * m && a < b * m;                // crossBelow
  }
  const conds = [...spec.entry, ...(x.conditions || [])];
  const usesBtc = conds.some(c => c.filter === 'btcUp');

  return {
    id, tf: '4h', spec: true, name: spec.name, nameAr: spec.name,
    uses: usesBtc ? ['btc1d'] : [],
    maxHoldBars: x.maxHoldBars ?? null,
    prepare(c, ctx) {
      const cl = c.map(b => b.close);
      const cache = {};
      for (const cnd of conds) for (const o of [cnd.left, cnd.right]) if (o && !isNum(o)) series(o, c, cl, cache);
      const S = { cl, c, series: cache, atr: st.atrS(c, 14), btcUp: [] };
      if (usesBtc) {
        const b = ctx.btc1d, sma = st.smaS(b.map(d => d.close), 200), map = st.alignDaily(c, '4h', b);
        S.btcUp = map.map(k => (k >= 0 && sma[k] != null ? b[k].close > sma[k] : null));
      }
      return S;
    },
    entry: (S, i) => S.atr[i] != null && spec.entry.every(cnd => test(S, cnd, i)),
    initialStop(S, i) {
      const pct = Math.min(Math.max(x.stopAtr * S.atr[i] / S.cl[i] * 100, LIMITS.stopPct[0]), LIMITS.stopPct[1]);
      return S.cl[i] * (1 - pct / 100);
    },
    exit: (S, i) => (x.conditions || []).some(cnd => test(S, cnd, i)),
    trail: (S, i, pos) => (x.trailAtr != null && S.atr[i] != null ? pos.highestHigh - x.trailAtr * S.atr[i] : null),
  };
}

// RSI بطريقة Wilder (نفس TradingView)
function rsiS(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n;
    l = (l * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

module.exports = { validate, compile, LIMITS, IND };
