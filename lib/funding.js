// ═══════════════════════════════════════════════════════════════════════════
//  معدل التمويل للعقود الدائمة (قراءة بس — ما فيه أي تداول مشتقات)
//  المصادر بالترتيب: Binance fapi → OKX → Bybit. أول واحد يشتغل من السيرفر ينستخدم.
//  القيمة تتحوّل لكل 8 ساعات (بعض العملات تمويلها كل 4 ساعات) وتنحفظ 15 دقيقة.
//  العملة اللي ما لها عقد دائم → نستخدم تمويل البتكوين.
//  أي فشل = ما ندخل (آمن)، والسبب ينسجل.
// ═══════════════════════════════════════════════════════════════════════════
const THRESHOLD_8H = 0.0003;          // 0.03% لكل 8 ساعات (3× العادي 0.01%)
const CACHE_MS = 15 * 60_000;

class NoPerp extends Error {}
const coinOf = sym => sym.replace(/USDT$/, '');

function makeSources(fetchJson) {
  return {
    binance: {
      async rate(sym) {
        const j = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`, { allowError: true });
        if (j && j.code === -1121) throw new NoPerp(`${sym} ما له عقد دائم في Binance`);
        if (!j || j.lastFundingRate == null) throw new Error('Binance: رد بدون lastFundingRate');
        let hours = 8;   // fundingInfo يذكر بس العملات اللي مدتها مو 8 ساعات
        try {
          const info = await fetchJson('https://fapi.binance.com/fapi/v1/fundingInfo', { cacheKey: 'binance-fundingInfo', cacheMs: 24 * 3_600_000 });
          const x = Array.isArray(info) && info.find(e => e.symbol === sym);
          if (x && x.fundingIntervalHours) hours = Number(x.fundingIntervalHours);
        } catch { /* الافتراضي 8 */ }
        return { rate: Number(j.lastFundingRate), hours };
      },
    },
    okx: {
      async rate(sym) {
        const j = await fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${coinOf(sym)}-USDT-SWAP`, { allowError: true });
        if (j && j.code === '51001') throw new NoPerp(`${sym} ما له عقد دائم في OKX`);
        const d = j && j.data && j.data[0];
        if (!d || d.fundingRate == null) throw new Error(`OKX: ${j && j.msg ? j.msg : 'رد بدون fundingRate'}`);
        const hours = d.nextFundingTime && d.fundingTime ? (Number(d.nextFundingTime) - Number(d.fundingTime)) / 3_600_000 : 8;
        return { rate: Number(d.fundingRate), hours: hours > 0 ? hours : 8 };
      },
    },
    bybit: {
      async rate(sym) {
        const j = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`, { allowError: true });
        const d = j && j.result && j.result.list && j.result.list[0];
        if (j && (j.retCode === 10001 || (j.retCode === 0 && !d))) throw new NoPerp(`${sym} ما له عقد دائم في Bybit`);
        if (!d || d.fundingRate == null) throw new Error(`Bybit: ${j && j.retMsg ? j.retMsg : 'رد بدون fundingRate'}`);
        let hours = 8;
        try {
          const ins = await fetchJson(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${sym}`, { cacheKey: `bybit-ins-${sym}`, cacheMs: 24 * 3_600_000 });
          const m = ins && ins.result && ins.result.list && ins.result.list[0];
          if (m && m.fundingInterval) hours = Number(m.fundingInterval) / 60;
        } catch { /* الافتراضي 8 */ }
        return { rate: Number(d.fundingRate), hours };
      },
    },
  };
}

function createFunding({ fetchImpl = globalThis.fetch, now = () => Date.now(), order = ['binance', 'okx', 'bybit'], log = console } = {}) {
  const raw = new Map();     // كاش الردود الطويلة (fundingInfo …)
  async function fetchJson(url, { allowError = false, cacheKey = null, cacheMs = 0 } = {}) {
    if (cacheKey && raw.has(cacheKey) && now() - raw.get(cacheKey).at < cacheMs) return raw.get(cacheKey).j;
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    let j = null;
    try { j = await r.json(); } catch { /* مو JSON */ }
    if (!r.ok && !(allowError && j)) throw new Error(`HTTP ${r.status}`);
    if (cacheKey) raw.set(cacheKey, { at: now(), j });
    return j;
  }
  const sources = makeSources(fetchJson);
  let source = null;                       // المصدر اللي اشتغل من هالسيرفر
  const probeLog = [];
  const cache = new Map();                 // sym → { at, value }

  // يجرب المصادر بالترتيب على BTCUSDT ويختار أول واحد يشتغل
  async function probe() {
    probeLog.length = 0;
    for (const name of order) {
      try {
        const r = await sources[name].rate('BTCUSDT');
        if (!Number.isFinite(r.rate)) throw new Error('قيمة مو رقم');
        probeLog.push({ source: name, ok: true });
        source = name;
        return { ok: true, source, tried: [...probeLog] };
      } catch (e) {
        probeLog.push({ source: name, ok: false, error: String(e.message).slice(0, 120) });
      }
    }
    source = null;
    return { ok: false, source: null, tried: [...probeLog] };
  }

  // { rate8h, rate, hours, source, symbol (اللي انقرا تمويله), fallbackBtc }
  async function get(sym) {
    const hit = cache.get(sym);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    if (!source) { const p = await probe(); if (!p.ok) throw new Error('ولا مصدر تمويل يشتغل من السيرفر'); }
    let used = sym, fallbackBtc = false, r;
    try { r = await sources[source].rate(sym); }
    catch (e) {
      if (!(e instanceof NoPerp)) { source = null; throw e; }   // فشل شبكة: نجرب المصادر من جديد المرة الجاية
      used = 'BTCUSDT'; fallbackBtc = true;
      r = await sources[source].rate('BTCUSDT');
    }
    const value = { rate8h: r.rate * 8 / r.hours, rate: r.rate, hours: r.hours, source, symbol: used, fallbackBtc };
    cache.set(sym, { at: now(), value });
    return value;
  }

  return { probe, get, source: () => source, probeLog: () => [...probeLog] };
}

// القرار: نمنع الدخول إذا التمويل أعلى من الحد. بدون بيانات = منع (آمن)
function fundingAllows(value, threshold = THRESHOLD_8H) {
  if (!value || !Number.isFinite(value.rate8h)) return { allow: false, reason: 'ما فيه بيانات تمويل' };
  return value.rate8h > threshold
    ? { allow: false, reason: `التمويل ${(value.rate8h * 100).toFixed(4)}% لكل 8 ساعات فوق الحد ${(threshold * 100).toFixed(2)}%` }
    : { allow: true, reason: null };
}

module.exports = { createFunding, fundingAllows, THRESHOLD_8H, CACHE_MS, NoPerp };
