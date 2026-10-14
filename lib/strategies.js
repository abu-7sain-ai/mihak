// ═══════════════════════════════════════════════════════════════════════════
//  استراتيجيات الكود — نفس الملف للاختبار التاريخي (research/backtest.js)
//  وللمتسابقين الحيين في السيرفر، عشان اللي انختبر هو اللي يتداول.
//
//  كل استراتيجية تشتغل على الشموع المغلقة بس:
//    prepare(candles, ctx)  → سلاسل المؤشرات (نفس طول الشموع، null قبل ما تكتمل)
//    entry(S, i)            → إشارة دخول على إغلاق الشمعة i (التنفيذ على السعر اللي بعدها)
//    initialStop(S, i)      → وقف أولي (سعر) أو null
//    exit(S, i, pos)        → إشارة خروج على إغلاق الشمعة i
//    trail(S, i, pos)       → وقف جديد (يطلع بس، ما ينزل) أو null
//  الإعدادات افتراضية من الكتب، مو معدّلة على البيانات.
// ═══════════════════════════════════════════════════════════════════════════

const DAY = 86_400_000;
const TF_MS = { '4h': 4 * 3_600_000, '1d': DAY };

// ── سلاسل المؤشرات ──────────────────────────────────────────────────────────
const closes = c => c.map(x => x.close);

function smaS(v, n) {
  const out = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function emaS(v, n) {
  const out = new Array(v.length).fill(null);
  if (v.length < n) return out;
  const k = 2 / (n + 1);
  let prev = v.slice(0, n).reduce((s, x) => s + x, 0) / n;
  out[n - 1] = prev;
  for (let i = n; i < v.length; i++) { prev = v[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

// متوسط Wilder (مثل ta.rma في TradingView)
function rmaS(v, n) {
  const out = new Array(v.length).fill(null);
  let start = v.findIndex(x => x != null);
  if (start < 0 || v.length - start < n) return out;
  let prev = 0;
  for (let i = start; i < start + n; i++) prev += v[i];
  prev /= n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < v.length; i++) { prev = (prev * (n - 1) + v[i]) / n; out[i] = prev; }
  return out;
}

function trueRange(c) {
  return c.map((x, i) => (i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
}
const atrS = (c, n = 14) => rmaS(trueRange(c), n);

// أعلى/أدنى قيمة في آخر n شموع قبل الحالية (بدون الحالية)
function prevHighestS(v, n) {
  const out = new Array(v.length).fill(null);
  for (let i = n; i < v.length; i++) { let m = -Infinity; for (let j = i - n; j < i; j++) if (v[j] > m) m = v[j]; out[i] = m; }
  return out;
}
function prevLowestS(v, n) {
  const out = new Array(v.length).fill(null);
  for (let i = n; i < v.length; i++) { let m = Infinity; for (let j = i - n; j < i; j++) if (v[j] < m) m = v[j]; out[i] = m; }
  return out;
}
// شامل الشمعة الحالية (لإيشيموكو)
function highestInclS(v, n) {
  const out = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) { let m = -Infinity; for (let j = i - n + 1; j <= i; j++) if (v[j] > m) m = v[j]; out[i] = m; }
  return out;
}
function lowestInclS(v, n) {
  const out = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) { let m = Infinity; for (let j = i - n + 1; j <= i; j++) if (v[j] < m) m = v[j]; out[i] = m; }
  return out;
}

function stdevS(v, n) {
  const mean = smaS(v, n);
  return v.map((_, i) => {
    if (mean[i] == null) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - mean[i]) ** 2;
    return Math.sqrt(s / n);
  });
}

function macdS(v, fast = 12, slow = 26, sig = 9) {
  const f = emaS(v, fast), s = emaS(v, slow);
  const line = v.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const first = line.findIndex(x => x != null);
  const signal = new Array(v.length).fill(null);
  if (first >= 0) emaS(line.slice(first), sig).forEach((x, k) => { signal[first + k] = x; });
  return { line, signal };
}

function adxS(c, n = 14) {
  const plus = [0], minus = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, down = c[i - 1].low - c[i].low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const tr = rmaS(trueRange(c), n), p = rmaS(plus, n), m = rmaS(minus, n);
  const dx = c.map((_, i) => {
    if (tr[i] == null || !tr[i]) return null;
    const pdi = 100 * p[i] / tr[i], mdi = 100 * m[i] / tr[i];
    return pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  });
  return rmaS(dx, n);
}

function supertrendS(c, n = 10, mult = 3) {
  const atr = atrS(c, n);
  const dir = new Array(c.length).fill(null);
  let fu = null, fl = null, d = 1;
  for (let i = 0; i < c.length; i++) {
    if (atr[i] == null) continue;
    const hl2 = (c[i].high + c[i].low) / 2, ub = hl2 + mult * atr[i], lb = hl2 - mult * atr[i];
    const pc = c[i - 1]?.close;
    const nfu = fu == null || ub < fu || pc > fu ? ub : fu;
    const nfl = fl == null || lb > fl || pc < fl ? lb : fl;
    if (fu != null) {
      if (d === -1 && c[i].close > fu) d = 1;       // نقارن بالخط السابق مثل TradingView
      else if (d === 1 && c[i].close < fl) d = -1;
    }
    fu = nfu; fl = nfl;
    dir[i] = d;
  }
  return dir;
}

// لكل شمعة: رقم آخر شمعة يومية مغلقة وقت إغلاقها (للاستراتيجيات اللي تشوف اليومي)
function alignDaily(candles, tf, daily) {
  const out = new Array(candles.length).fill(-1);
  let k = -1;
  for (let i = 0; i < candles.length; i++) {
    const closeAt = candles[i].t + TF_MS[tf];
    while (k + 1 < daily.length && daily[k + 1].t + DAY <= closeAt) k++;
    out[i] = k;
  }
  return out;
}

// ── الاستراتيجيات ────────────────────────────────────────────────────────────
const cross = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDown = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];
const ok = (...xs) => xs.every(x => x != null && Number.isFinite(x));

// نفس منطق سكربت "الماضي" (tradingview/al-madi.pine):
//  الاتجاه: إغلاق فوق EMA200 و EMA200 طالع (أعلى من قبل 5 شموع)
//  وقف أولي داخل الشمعة: 2.5 ATR (محصور 1%–15%)
//  خروج على الإغلاق: تحت الوقف الملاحق (أعلى إغلاق − 3 ATR) أو تحت EMA200
const pineCore = {
  prepare(c) {
    const cl = closes(c);
    return { c, cl, hh: prevHighestS(c.map(x => x.high), 20), ema200: emaS(cl, 200), atr: atrS(c, 14), e20: emaS(cl, 20), e50: emaS(cl, 50) };
  },
  uptrend: (S, i) => ok(S.ema200[i], S.ema200[i - 5], S.atr[i]) && S.cl[i] > S.ema200[i] && S.ema200[i] > S.ema200[i - 5],
  initialStop(S, i) {
    const pct = Math.min(Math.max(2.5 * S.atr[i] / S.cl[i] * 100, 1), 15);
    return S.cl[i] * (1 - pct / 100);
  },
  // يحدّث الوقف الملاحق ويقرر الخروج (مرة وحدة لكل شمعة مغلقة)
  exit(S, i, pos) {
    const prev = pos.trail ?? pos.stop;
    pos.trail = Math.max(prev ?? -Infinity, S.cl[i] - 3 * S.atr[i]);
    return S.cl[i] < pos.trail || S.cl[i] < S.ema200[i];
  },
  trail: () => null,
};
const breakoutCore = { ...pineCore, entry: (S, i) => pineCore.uptrend(S, i) && ok(S.hh[i]) && S.cl[i] > S.hh[i] };

const STRATEGIES = [
  // ── المرجع (للتحقق من محرك الاختبار) ──
  { id: 'base-breakout', baseline: true, tf: '4h', name: 'Breakout (baseline)', nameAr: 'بريك أوت (المرجع)', ...breakoutCore },
  {
    id: 'base-ema-cross', baseline: true, tf: '4h', name: 'EMA20/50 cross (baseline)', nameAr: 'تقاطع EMA20/50 (المرجع)',
    ...pineCore,
    entry: (S, i) => pineCore.uptrend(S, i) && cross(S.e20, S.e50, i),
  },

  // ── المرشحين ──
  {
    id: 'donchian-1d', tf: '1d', name: 'Donchian 55/20 (Turtle)', nameAr: 'دونشيان 55/20 (السلاحف)',
    prepare(c) { const cl = closes(c); return { cl, hh: prevHighestS(c.map(x => x.high), 55), ll: prevLowestS(c.map(x => x.low), 20), atr: atrS(c, 20) }; },
    entry: (S, i) => ok(S.hh[i], S.atr[i]) && S.cl[i] > S.hh[i],
    initialStop: (S, i) => S.cl[i] - 2 * S.atr[i],          // 2N
    exit: (S, i) => ok(S.ll[i]) && S.cl[i] < S.ll[i],
    trail: () => null,
  },
  {
    id: 'squeeze-4h', tf: '4h', name: 'Bollinger squeeze breakout', nameAr: 'انفجار بعد انضغاط بولنجر',
    prepare(c) {
      const cl = closes(c), mid = smaS(cl, 20), sd = stdevS(cl, 20);
      const bw = cl.map((_, i) => (mid[i] ? 4 * sd[i] / mid[i] : null));
      const bwLow = bw.map((_, i) => {                       // أضيق عرض في آخر 125 شمعة (تعريف بولنجر)
        if (i < 125 + 19) return null;
        let m = Infinity; for (let j = i - 124; j <= i; j++) if (bw[j] < m) m = bw[j];
        return m;
      });
      const recentSqueeze = bw.map((_, i) => {
        for (let j = Math.max(0, i - 10); j <= i; j++) if (bwLow[j] != null && bw[j] <= bwLow[j]) return true;
        return false;
      });
      return { cl, mid, upper: mid.map((m, i) => (m == null ? null : m + 2 * sd[i])), recentSqueeze, atr: atrS(c, 14) };
    },
    entry: (S, i) => ok(S.upper[i], S.atr[i]) && S.recentSqueeze[i] && S.cl[i] > S.upper[i],
    initialStop: (S, i) => S.cl[i] - 2 * S.atr[i],
    exit: (S, i) => ok(S.mid[i]) && S.cl[i] < S.mid[i],
    trail: () => null,
  },
  {
    id: 'mtf-breakout-4h', tf: '4h', uses: ['d1'], name: '4h breakout + daily EMA50 trend', nameAr: 'بريك أوت 4 ساعات + اتجاه يومي',
    prepare(c, ctx) {
      const S = breakoutCore.prepare(c);
      const dEma = emaS(closes(ctx.d1), 50), map = alignDaily(c, '4h', ctx.d1);
      S.dailyUp = map.map(k => (k >= 0 && dEma[k] != null ? ctx.d1[k].close > dEma[k] : null));
      return S;
    },
    entry: (S, i) => breakoutCore.entry(S, i) && S.dailyUp[i] === true,
    initialStop: pineCore.initialStop,
    exit: (S, i, pos) => pineCore.exit(S, i, pos) || S.dailyUp[i] === false,
    trail: () => null,
  },
  {
    id: 'golden-cross-1d', tf: '1d', name: 'Golden cross SMA50/200', nameAr: 'التقاطع الذهبي SMA50/200',
    prepare(c) { const cl = closes(c); return { cl, f: smaS(cl, 50), s: smaS(cl, 200) }; },
    entry: (S, i) => cross(S.f, S.s, i),
    initialStop: () => null,
    exit: (S, i) => crossDown(S.f, S.s, i),
    trail: () => null,
  },
  {
    id: 'trend-btc-1d', tf: '1d', uses: ['btc1d'], name: 'Above SMA100 + BTC above SMA200', nameAr: 'فوق SMA100 والبتكوين فوق SMA200',
    prepare(c, ctx) {
      const cl = closes(c), sma = smaS(cl, 100);
      const bSma = smaS(closes(ctx.btc1d), 200), map = alignDaily(c, '1d', ctx.btc1d);
      const btcUp = map.map(k => (k >= 0 && bSma[k] != null ? ctx.btc1d[k].close > bSma[k] : null));
      return { cl, sma, btcUp };
    },
    entry: (S, i) => ok(S.sma[i]) && S.btcUp[i] === true && S.cl[i] > S.sma[i],
    initialStop: () => null,
    exit: (S, i) => (ok(S.sma[i]) && S.cl[i] < S.sma[i]) || S.btcUp[i] === false,
    trail: () => null,
  },
  {
    // يختار بين كل العملات: كل أسبوع (إغلاق الأحد UTC) نمسك أقوى 3 على 90 يوم وهي فوق SMA100
    id: 'momentum-rank-1d', tf: '1d', rank: true, name: 'Weekly top-3 momentum (90d, above SMA100)', nameAr: 'أقوى 3 كل أسبوع (زخم 90 يوم)',
    hold: 3, lookback: 90,
    prepare(c) { const cl = closes(c); return { c, cl, sma: smaS(cl, 100) }; },
    isRebalance: (S, i) => new Date(S.c[i].t).getUTCDay() === 0,
    score(S, i) {
      if (i < this.lookback || !ok(S.sma[i]) || S.cl[i] <= S.sma[i]) return null;
      return S.cl[i] / S.cl[i - this.lookback] - 1;
    },
    entry: () => false, initialStop: () => null, exit: () => false, trail: () => null,
  },
  {
    id: 'macd-zero-4h', tf: '4h', name: 'MACD crosses zero + EMA200', nameAr: 'ماكد يقطع الصفر + EMA200',
    prepare(c) { const cl = closes(c); const m = macdS(cl); return { cl, line: m.line, ema200: emaS(cl, 200) }; },
    entry: (S, i) => ok(S.line[i - 1], S.line[i], S.ema200[i]) && S.line[i - 1] <= 0 && S.line[i] > 0 && S.cl[i] > S.ema200[i],
    initialStop: () => null,
    exit: (S, i) => ok(S.line[i]) && S.line[i] < 0,
    trail: () => null,
  },
  {
    id: 'supertrend-4h', tf: '4h', name: 'Supertrend (10, 3)', nameAr: 'سوبرترند (10، 3)',
    prepare(c) { return { dir: supertrendS(c, 10, 3) }; },
    entry: (S, i) => S.dir[i - 1] === -1 && S.dir[i] === 1,
    initialStop: () => null,
    exit: (S, i) => S.dir[i] === -1,
    trail: () => null,
  },
  {
    id: 'keltner-4h', tf: '4h', name: 'Keltner breakout + 3 ATR chandelier', nameAr: 'اختراق كيلتنر + وقف ملاحق 3 ATR',
    prepare(c) {
      const cl = closes(c), mid = emaS(cl, 20), a10 = atrS(c, 10);
      return { c, cl, upper: mid.map((m, i) => (m != null && a10[i] != null ? m + 2 * a10[i] : null)), atr: atrS(c, 14) };
    },
    entry: (S, i) => ok(S.upper[i], S.atr[i]) && S.cl[i] > S.upper[i],
    initialStop: (S, i) => S.cl[i] - 3 * S.atr[i],
    exit: () => false,
    trail: (S, i, pos) => (ok(S.atr[i]) ? pos.highestHigh - 3 * S.atr[i] : null),
  },
  {
    id: 'pullback-4h', tf: '4h', name: 'EMA20 pullback in strong trend (ADX>25)', nameAr: 'ارتداد من EMA20 في اتجاه قوي',
    prepare(c) {
      const cl = closes(c);
      return { c, cl, e20: emaS(cl, 20), e50: emaS(cl, 50), e200: emaS(cl, 200), adx: adxS(c, 14), atr: atrS(c, 14) };
    },
    entry: (S, i) => ok(S.e20[i], S.e50[i], S.e200[i], S.adx[i], S.atr[i])
      && S.e50[i] > S.e200[i] && S.adx[i] > 25 && S.c[i].low <= S.e20[i] && S.cl[i] > S.e20[i],
    initialStop: (S, i) => S.cl[i] - 2 * S.atr[i],
    exit: (S, i) => ok(S.e50[i]) && S.cl[i] < S.e50[i],
    trail: () => null,
  },
  {
    id: 'ichimoku-1d', tf: '1d', name: 'Ichimoku: above cloud + TK cross', nameAr: 'إيشيموكو: فوق السحابة + تقاطع',
    prepare(c) {
      const hi = c.map(x => x.high), lo = c.map(x => x.low), cl = closes(c);
      const mid = n => { const h = highestInclS(hi, n), l = lowestInclS(lo, n); return h.map((x, i) => (x == null ? null : (x + l[i]) / 2)); };
      const tenkan = mid(9), kijun = mid(26), spanB0 = mid(52);
      const spanA0 = tenkan.map((t, i) => (t != null && kijun[i] != null ? (t + kijun[i]) / 2 : null));
      const cloudTop = cl.map((_, i) => (i >= 26 && spanA0[i - 26] != null && spanB0[i - 26] != null ? Math.max(spanA0[i - 26], spanB0[i - 26]) : null));
      return { cl, tenkan, kijun, cloudTop };
    },
    entry: (S, i) => ok(S.cloudTop[i]) && S.cl[i] > S.cloudTop[i] && cross(S.tenkan, S.kijun, i),
    initialStop: () => null,
    exit: (S, i) => ok(S.kijun[i]) && S.cl[i] < S.kijun[i],
    trail: () => null,
  },
  {
    id: 'breakout-btc-4h', tf: '4h', uses: ['btc1d'], name: 'Breakout + BTC above daily SMA200', nameAr: 'بريك أوت + البتكوين فوق SMA200 اليومي',
    prepare(c, ctx) {
      const S = breakoutCore.prepare(c);
      const bSma = smaS(closes(ctx.btc1d), 200), map = alignDaily(c, '4h', ctx.btc1d);
      S.btcUp = map.map(k => (k >= 0 && bSma[k] != null ? ctx.btc1d[k].close > bSma[k] : null));
      return S;
    },
    entry: (S, i) => breakoutCore.entry(S, i) && S.btcUp[i] === true,
    initialStop: breakoutCore.initialStop,
    exit: breakoutCore.exit,
    trail: breakoutCore.trail,
  },
];

const byId = Object.fromEntries(STRATEGIES.map(s => [s.id, s]));

module.exports = {
  STRATEGIES, byId, TF_MS, DAY,
  smaS, emaS, rmaS, atrS, prevHighestS, prevLowestS, macdS, adxS, supertrendS, alignDaily,
};
