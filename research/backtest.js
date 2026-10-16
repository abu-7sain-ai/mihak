// ═══════════════════════════════════════════════════════════════════════════
//  الاختبار التاريخي لاستراتيجيات lib/strategies.js على شموع research/data
//  نفس المحاسبة (lib/accounting.js): رسوم 0.1% + انزلاق 0.05% لكل جهة، $100 للصفقة.
//  الدخول على افتتاح الشمعة اللي بعد الإشارة. الوقف على سعره، أو الافتتاح إذا قفز تحته.
//
//  node research/backtest.js --period dev                 (كل المرشحين، 2022-2024)
//  node research/backtest.js --period oos --only a,b,c    (فحص وحيد على 2025→اليوم)
//  node research/backtest.js --period full --only base-breakout,base-ema-cross
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const acc = require('../lib/accounting');
const { STRATEGIES, byId: codeById, TF_MS, DAY } = require('../lib/strategies');
const { compile } = require('../lib/strategy-spec');

// الاستراتيجيات اللي كتبتها النماذج (strategies/*.json، مجمّدة)
const SPEC_DIR = path.join(__dirname, '..', 'strategies');
const byId = { ...codeById, 'fable-discovery': require('../lib/fable-discovery') };   // اكتشاف Fable (مجمّد)
if (fs.existsSync(SPEC_DIR)) for (const f of fs.readdirSync(SPEC_DIR).filter(f => f.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, f), 'utf-8'));
  if (j.valid) byId[j.id] = { ...compile(j.spec, j.id), name: `${j.name} (${j.modelUsed})` };
}

const COINS = ['BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'TRX', 'BCH', 'ADA', 'LINK', 'XLM', 'LTC', 'HBAR', 'AVAX', 'SUI', 'DOT', 'SEI'].map(c => `${c}USDT`);
const RULES = { feePercent: 0.1, slippagePercent: 0.05 };
const AMOUNT = 100;
let LIVE = { slots: 3, balance: 1000, dailyLossUSD: 50, lossStreak: 4, cooldownMs: 6 * 3_600_000 };
// قوانين السيرفر الحالية (state.rules من get_rules)
function useLiveRules(r) {
  LIVE = { slots: r.maxConcurrentTrades, balance: r.startingBalance, dailyLossUSD: r.startingBalance * r.dailyLossLimitPercent / 100,
    lossStreak: r.consecutiveLossLimit, cooldownMs: r.cooldownHours * 3_600_000 };
}
const PERIODS = {
  dev: [Date.UTC(2022, 0, 1), Date.UTC(2025, 0, 1)],
  oos: [Date.UTC(2025, 0, 1), Infinity],
  full: [Date.UTC(2022, 0, 1), Infinity],
};

const DATA = path.join(__dirname, 'data');
const cache = {};
const load = (sym, tf) => (cache[`${sym}_${tf}`] ??= JSON.parse(fs.readFileSync(path.join(DATA, `${sym}_${tf}.json`), 'utf-8')));

// ── مشغّل عملة وحدة: نفس الخطوات للاختبار لكل عملة وللمحفظة بقوانين المِحَك ──
function makeRunner(strat, sym, period) {
  const candles = load(sym, strat.tf);
  const ctx = { d1: load(sym, '1d'), btc1d: load('BTCUSDT', '1d'), btc4h: load('BTCUSDT', '4h') };
  const S = strat.prepare(candles, ctx);
  const [from, to] = period;
  const idx = [];
  for (let i = 0; i < candles.length; i++) if (candles[i].t >= from && candles[i].t < to) idx.push(i);
  const lastIdx = idx.at(-1);
  const R = {
    sym, candles, S, idx, pos: null, pending: null, pendingStop: null, realized: 0, trades: [], equity: new Map(), skipped: 0,
    close(price, reason, t) {
      const exit = acc.exitFill(reason, price, R.pos, RULES);
      const pnl = acc.tradePnl(R.pos, exit, RULES).pnl;
      R.realized += pnl;
      R.trades.push({ sym, entryT: R.pos.t, exitT: t, entry: R.pos.entryPrice, exit, pnl, reason });
      R.pos = null;
      return pnl;
    },
    // افتتاح الشمعة i: خروج معلّق
    execExit(i) {
      if (R.pending === 'exit' && R.pos) { R.pending = null; return R.close(candles[i].open, 'signal-exit', candles[i].t); }
      return null;
    },
    wantsEntry() { return R.pending === 'enter' && !R.pos; },
    execEntry(i, allowed = true) {
      if (!R.wantsEntry()) return;
      R.pending = null;
      if (!allowed) { R.skipped++; return; }
      const c = candles[i];
      const { fill, qty } = acc.openPosition(AMOUNT, c.open, RULES);
      const stop = strat.stopPctFromEntry ? fill * (1 - strat.stopPctFromEntry / 100) : R.pendingStop;
      R.pos = { t: c.t, idx: i, amount: AMOUNT, qty, entryPrice: fill, stop, highestHigh: c.high, highestClose: c.open };
    },
    // داخل الشمعة: الوقف
    stopCheck(i) {
      const p = R.pos, c = candles[i];
      if (!p || p.stop == null) return null;
      if (c.open <= p.stop) return R.close(c.open, 'stop-loss', c.t);
      if (c.low <= p.stop) return R.close(p.stop, 'stop-loss', c.t);
      return null;
    },
    // إغلاق الشمعة i: إشارات الخروج/الدخول، وتحديث الوقف الملاحق
    atClose(i) {
      const c = candles[i];
      R.pending = null;
      if (R.pos) {
        const p = R.pos;
        p.highestHigh = Math.max(p.highestHigh, c.high);
        p.highestClose = Math.max(p.highestClose, c.close);
        if (i === lastIdx) R.close(c.close, 'period-end', c.t);
        else if (strat.exit(S, i, p) || (strat.maxHoldBars && i - p.idx + 1 >= strat.maxHoldBars)) R.pending = 'exit';
        else {
          const t = strat.trail(S, i, p);
          if (t != null && Number.isFinite(t) && (p.stop == null || t > p.stop)) p.stop = t;
        }
      } else if (i !== lastIdx && strat.entry(S, i)) {
        R.pending = 'enter';
        R.pendingStop = strat.initialStop(S, i);
      }
      const end = c.t + TF_MS[strat.tf];
      if (end % DAY === 0) R.equity.set(end, R.realized + (R.pos ? acc.tradePnl(R.pos, c.close, RULES).pnl : 0));
    },
    // حجم التداول بالدولار آخر 20 يوم (لترتيب الدخول لما الخانات ما تكفي)
    volume(i) {
      const n = Math.round(20 * DAY / TF_MS[strat.tf]);
      let s = 0;
      for (let j = Math.max(0, i - n); j < i; j++) s += candles[j].quoteVolume;
      return s;
    },
  };
  return R;
}

function buyHold(sym, tf, period) {
  const c = load(sym, tf).filter(x => x.t >= period[0] && x.t < period[1]);
  if (c.length < 2) return 0;
  const pos = { amount: AMOUNT, ...acc.openPosition(AMOUNT, c[0].open, RULES) };
  return acc.tradePnl(pos, acc.exitFill('period-end', c.at(-1).close, pos, RULES), RULES).pnl;
}

function maxDrawdown(curves, base = 0) {
  const days = [...new Set(curves.flatMap(m => [...m.keys()]))].sort((a, b) => a - b);
  const last = curves.map(() => 0);
  let peak = 0, dd = 0, ddPct = 0;
  for (const d of days) {
    let v = 0;
    curves.forEach((m, k) => { if (m.has(d)) last[k] = m.get(d); v += last[k]; });
    peak = Math.max(peak, v);
    dd = Math.max(dd, peak - v);
    if (base) ddPct = Math.max(ddPct, (peak - v) / (base + peak) * 100);
  }
  return base ? { dd, ddPct } : dd;
}

// ── اختبار لكل عملة لحالها (للشروط) ──────────────────────────────────────────
function perCoin(strat, period) {
  const runners = COINS.map(sym => makeRunner(strat, sym, period));
  if (strat.rank) runRank(strat, runners, () => true);
  else for (const R of runners) for (const i of R.idx) { R.execExit(i); R.execEntry(i); R.stopCheck(i); R.atClose(i); }
  return summarize(strat, runners, period);
}

// الترتيب الأسبوعي: نمشي على الأيام كلها مع بعض
function runRank(strat, runners, allowEntry, onClose = () => {}) {
  const byDay = new Map();
  runners.forEach(R => R.idx.forEach(i => { const t = R.candles[i].t; if (!byDay.has(t)) byDay.set(t, []); byDay.get(t).push([R, i]); }));
  const days = [...byDay.keys()].sort((a, b) => a - b);
  days.forEach((t, k) => {
    const today = byDay.get(t);
    today.forEach(([R, i]) => onClose(R.execExit(i), t));
    today.forEach(([R, i]) => R.execEntry(i, R.wantsEntry() ? allowEntry(R, i) : true));
    today.forEach(([R, i]) => onClose(R.stopCheck(i), t));
    const last = k === days.length - 1;
    today.forEach(([R, i]) => {
      R.pending = null;
      if (R.pos) R.pos.highestHigh = Math.max(R.pos.highestHigh, R.candles[i].high);
      if (i === R.idx.at(-1) && R.pos) onClose(R.close(R.candles[i].close, 'period-end', R.candles[i].t), t);
      const end = R.candles[i].t + DAY;
      R.equity.set(end, R.realized + (R.pos ? acc.tradePnl(R.pos, R.candles[i].close, RULES).pnl : 0));
    });
    if (last || !strat.isRebalance(today[0][0].S, today[0][1])) return;
    const scored = today.map(([R, i]) => [R, strat.score(R.S, i)]).filter(([, s]) => s != null).sort((a, b) => b[1] - a[1]);
    const keep = new Set(scored.slice(0, strat.hold).map(([R]) => R));
    today.forEach(([R]) => {
      if (R.pos && !keep.has(R)) R.pending = 'exit';
      else if (!R.pos && keep.has(R)) { R.pending = 'enter'; R.pendingStop = null; }
    });
  });
}

// ── المحفظة بقوانين المِحَك الحية: 3 خانات، $1000، حد خسارة يومي، إيقاف بعد 4 خسائر ──
function portfolio(strat, period) {
  const runners = COINS.map(sym => makeRunner(strat, sym, period));
  const st = { balance: LIVE.balance, streak: 0, pausedUntil: 0, day: null, dayPnl: 0 };
  const onClose = (pnl, t) => {
    if (pnl == null) return;
    st.balance += AMOUNT + pnl;
    const d = Math.floor(t / DAY);
    if (d !== st.day) { st.day = d; st.dayPnl = 0; }
    st.dayPnl += pnl;
    if (pnl > 0) st.streak = 0;
    else if (++st.streak >= LIVE.lossStreak) { st.pausedUntil = t + TF_MS[strat.tf] + LIVE.cooldownMs; st.streak = 0; }
  };
  const open = () => runners.filter(R => R.pos).length;
  const allowed = (R, t) => {
    const d = Math.floor(t / DAY);
    if (d !== st.day) { st.day = d; st.dayPnl = 0; }
    return open() < LIVE.slots && st.balance >= AMOUNT && t >= st.pausedUntil && st.dayPnl > -LIVE.dailyLossUSD;
  };
  const take = R => { st.balance -= AMOUNT; return true; };

  if (strat.rank) {
    runRank(strat, runners, (R, i) => allowed(R, R.candles[i].t) && take(R), onClose);
    return summarize(strat, runners, period);
  }
  const byT = new Map();
  runners.forEach(R => R.idx.forEach(i => { const t = R.candles[i].t; if (!byT.has(t)) byT.set(t, []); byT.get(t).push([R, i]); }));
  for (const t of [...byT.keys()].sort((a, b) => a - b)) {
    const bar = byT.get(t);
    bar.forEach(([R, i]) => onClose(R.execExit(i), t));
    bar.filter(([R]) => R.wantsEntry())
      .sort((a, b) => b[0].volume(b[1]) - a[0].volume(a[1]))
      .forEach(([R, i]) => R.execEntry(i, allowed(R, t) && take(R)));
    bar.forEach(([R, i]) => onClose(R.stopCheck(i), t));
    bar.forEach(([R, i]) => {
      const before = R.trades.length;
      R.atClose(i);
      if (R.trades.length > before) onClose(R.trades.at(-1).pnl, t);
    });
  }
  return summarize(strat, runners, period);
}

function summarize(strat, runners, period) {
  const coins = runners.map(R => ({
    sym: R.sym, pnl: R.realized, trades: R.trades.length,
    wins: R.trades.filter(x => x.pnl > 0).length,
    bh: buyHold(R.sym, strat.tf, period), skipped: R.skipped,
  }));
  const total = coins.reduce((s, c) => s + c.pnl, 0);
  const trades = coins.reduce((s, c) => s + c.trades, 0);
  const top = coins.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  return {
    id: strat.id, name: strat.name, tf: strat.tf,
    total, trades,
    winRate: trades ? coins.reduce((s, c) => s + c.wins, 0) / trades * 100 : 0,
    coinsProfitable: coins.filter(c => c.pnl > 0).length,
    beatsBH: coins.filter(c => c.pnl > c.bh).length,
    topCoin: top.sym, topShare: total > 0 ? top.pnl / total * 100 : null,
    maxDD: maxDrawdown(runners.map(R => R.equity)),
    maxDDPct: maxDrawdown(runners.map(R => R.equity), LIVE.balance).ddPct,
    profitFactor: (() => {
      const all = runners.flatMap(R => R.trades);
      const w = all.filter(x => x.pnl > 0).reduce((s, x) => s + x.pnl, 0), l = -all.filter(x => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0);
      return l > 0 ? w / l : null;
    })(),
    skipped: coins.reduce((s, c) => s + c.skipped, 0),
    coins,
  };
}

// الشروط (لكل فترة): ربح، 10 عملات من 16 رابحة، تغلب الشراء والاحتفاظ في 9 على الأقل، وأكبر عملة ≤ 30%
function verdict(r) {
  const fails = [];
  if (!(r.total > 0)) fails.push('خسران');
  if (r.coinsProfitable < 10) fails.push(`${r.coinsProfitable}/16 عملات رابحة`);
  if (r.beatsBH < 9) fails.push(`يغلب الشراء والاحتفاظ في ${r.beatsBH}/16 بس`);
  if (r.topShare != null && r.topShare > 30) fails.push(`${r.topCoin} = ${r.topShare.toFixed(0)}% من الربح`);
  return fails;
}

// ── الشراء الدوري (DCA) والشراء والاحتفاظ: بنفس المحاسبة ─────────────────────
// الاختبار: نفس القاعدة (الميزانية تكفي كل الأسابيع حتى لو كل الشراء مضاعف)، بس على أسابيع الفترة كلها
function dcaSim(period) {
  const { DCA } = require('../lib/strategies');
  const { smaS } = require('../lib/strategies');
  const coins = DCA.coins.map(sym => {
    const c = load(sym, '1d');
    return { sym, c, sma: smaS(c.map(x => x.close), DCA.smaLen) };
  });
  const days = coins[0].c.filter(x => x.t >= period[0] && x.t < period[1]);
  const mondays = days.filter(x => new Date(x.t).getUTCDay() === 1);
  const base = LIVE.balance / (coins.length * mondays.length * (DCA.double / DCA.base));
  let cash = LIVE.balance, buys = 0;
  const hold = coins.map(() => ({ qty: 0, invested: 0 }));
  const curve = new Map();
  for (const d of days) {
    coins.forEach((co, k) => {
      const j = co.c.findIndex(x => x.t === d.t);
      if (j < 1 || new Date(d.t).getUTCDay() !== 1) return;
      const below = co.sma[j - 1] != null && co.c[j - 1].close < co.sma[j - 1];   // آخر إغلاق يومي (الأحد)
      const amt = below ? base * DCA.double / DCA.base : base;
      if (cash < amt - 1e-9) return;
      const { qty } = acc.openPosition(amt, co.c[j].open, RULES);
      hold[k].qty += qty; hold[k].invested += amt; cash -= amt; buys++;
    });
    const value = coins.reduce((s, co, k) => {
      const x = co.c.find(y => y.t === d.t);
      return s + (x ? acc.liquidationValue(hold[k].qty, acc.exitFill('period-end', x.close, null, RULES), RULES).net : 0);
    }, 0);
    curve.set(d.t, cash + value - LIVE.balance);
  }
  return finish('dca', curve, buys, null);
}
function hodlSim(period) {
  const c = load('BTCUSDT', '1d').filter(x => x.t >= period[0] && x.t < period[1]);
  const { qty } = acc.openPosition(LIVE.balance, c[0].open, RULES);
  const curve = new Map(c.map(x => [x.t, acc.liquidationValue(qty, acc.exitFill('period-end', x.close, null, RULES), RULES).net - LIVE.balance]));
  return finish('hodl', curve, 1, null);
}
function finish(id, curve, trades, pf) {
  const v = [...curve.values()];
  const { dd, ddPct } = maxDrawdown([curve], LIVE.balance);
  const total = v.at(-1);
  return { id, name: id, total, trades, coinsProfitable: null, beatsBH: null, topShare: null, maxDD: dd, profitFactor: pf, winRate: null, fails: [],
    live: { slots: LIVE.slots, total, returnPct: total / LIVE.balance * 100, trades, maxDD: dd, maxDDPct: ddPct, profitFactor: pf, skipped: 0 } };
}

if (require.main === module) {
  const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
  const periodName = arg('period') || 'dev';
  if (arg('rules')) useLiveRules(JSON.parse(fs.readFileSync(arg('rules'), 'utf-8')));
  const only = arg('only') ? arg('only').split(',') : null;
  if (periodName !== 'dev' && !only) { console.error('oos/full تحتاج --only (الفحص على 2025 مرة وحدة بس، للقائمة القصيرة)'); process.exit(1); }
  const SPECIAL = { dca: dcaSim, hodl: hodlSim };
  const list = only ? only.map(id => SPECIAL[id] ? { id, special: SPECIAL[id] } : byId[id] || (() => { throw new Error(`unknown ${id}`); })()) : STRATEGIES.filter(s => !s.baseline && !s.contestant);
  const period = PERIODS[periodName];
  const out = list.map(s => {
    if (s.special) return s.special(period);
    const a = perCoin(s, period), b = portfolio(s, period);
    return { ...a, fails: verdict(a), live: { slots: LIVE.slots, total: b.total, returnPct: b.total / LIVE.balance * 100, trades: b.trades, maxDD: b.maxDD, maxDDPct: b.maxDDPct, profitFactor: b.profitFactor, skipped: b.skipped, winRate: b.winRate } };
  });
  const dir = path.join(__dirname, 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${periodName}${only ? '-' + only.length : ''}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ period: periodName, ranAt: new Date().toISOString(), results: out }, null, 1));
  const f = (v, d = 0) => (v == null ? '—' : v.toFixed(d));
  console.log(`period ${periodName} → ${path.basename(file)}`);
  console.log('id'.padEnd(18), 'total$'.padStart(8), 'coins'.padStart(6), 'B&H'.padStart(4), 'top%'.padStart(5), 'DD$'.padStart(6), 'trades'.padStart(7), 'win%'.padStart(5), '| live$'.padStart(8), 'liveDD'.padStart(7), 'skip'.padStart(5), ' fails');
  for (const r of out) {
    console.log(r.id.padEnd(18), f(r.total).padStart(8), `${r.coinsProfitable}/16`.padStart(6), String(r.beatsBH).padStart(4), f(r.topShare).padStart(5), f(r.maxDD).padStart(6),
      String(r.trades).padStart(7), f(r.winRate).padStart(5), '|', f(r.live.total).padStart(6), f(r.live.maxDD).padStart(7), String(r.live.skipped).padStart(5), ' ', r.fails.join('; ') || 'PASS');
  }
}

module.exports = { perCoin, portfolio, verdict, makeRunner, useLiveRules, byId, PERIODS, COINS };
