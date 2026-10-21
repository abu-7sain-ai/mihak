// ═══════════════════════════════════════════════════════════════════════════
//  حالات السوق وفترات السوق ومصفوفة الحالات (كود بس، بدون أي طلب OpenRouter)
//
//  node research/regimes.js              → فترات السوق + مصفوفة الفترات + مصفوفة الحالات (2021–2024)
//  node scripts/maestro-mapping.js       → يجمّد خريطة المايسترو من مصفوفة الحالات (مرة وحدة لكل نسخة)
//  node research/regimes.js --maestro    → المايسترو على 2021–2024 (داخل العينة)
//  node research/regimes.js --maestro-oos → المايسترو على 2025→الحين، مرة وحدة بس
//
//  الحالة الحية والاختبار نفس الدالة: lib/regime.js
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const B = require('./backtest');
const { regimeSeries, BUCKET_AR, DAY } = require('../lib/regime');
const { smaS } = require('../lib/strategies');

const OUT = path.join(__dirname, 'out');
const RULES_FILE = path.join(OUT, 'live-rules.json');
B.useLiveRules(JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8')));

const CONTESTANTS = [
  ['code-breakout-btc', 'breakout-btc-4h'], ['code-breakout-nobtc', 'base-breakout'], ['code-rotation', 'rotation-1d'],
  ['code-pullback', 'pullback-rsi2-4h'], ['code-bollinger', 'bollinger-4h'], ['code-dca', 'dca'],
  ['strat-fable', 'strat-fable'], ['strat-gpt', 'strat-gpt'], ['strat-qwen', 'strat-qwen'], ['strat-deepseek', 'strat-deepseek'],
  ['fable-discovery', 'fable-discovery'],
];
const RESEARCH = [Date.UTC(2021, 0, 1), Date.UTC(2025, 0, 1)];
const OOS = [Date.UTC(2025, 0, 1), Infinity];
const day = t => new Date(t).toISOString().slice(0, 10);
const r1 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const r2 = v => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

// ── البيانات ─────────────────────────────────────────────────────────────────
const btc = B.load('BTCUSDT', '1d').filter(d => d.t >= Date.UTC(2021, 0, 1));
const btcAll = B.load('BTCUSDT', '1d');
const series = regimeSeries(btcAll);                     // يوم بيوم، معروف بعد إغلاق كل يوم
const seriesAt = new Map(btcAll.map((d, k) => [d.t, series[k]]));
const cl = btc.map(d => d.close);
const sma200All = smaS(btcAll.map(d => d.close), 200);
const sma200At = new Map(btcAll.map((d, k) => [d.t, sma200All[k]]));

// الحالة المعروفة وقت T (آخر يوم بتكوين سكّر لين T)
const sortedT = btcAll.map(d => d.t);
function bucketAt(T) {
  let lo = 0, hi = sortedT.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sortedT[m] + DAY <= T) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 && series[k] ? series[k].bucket : 'none';
}

// ── أ) فترات بنظرة لورا (للفهم بس) ──────────────────────────────────────────
// 1) نقاط الانعكاس: زيغزاغ على الإغلاق اليومي بانعكاس thr
function zigzag(v, thr) {
  const piv = [0];
  let mode = 0, ext = 0;
  for (let i = 1; i < v.length; i++) {
    if (mode === 0) {
      if (v[i] >= v[0] * (1 + thr)) { mode = 1; ext = i; } else if (v[i] <= v[0] * (1 - thr)) { mode = -1; ext = i; }
      continue;
    }
    if (mode === 1) { if (v[i] > v[ext]) ext = i; else if (v[i] <= v[ext] * (1 - thr)) { piv.push(ext); mode = -1; ext = i; } }
    else { if (v[i] < v[ext]) ext = i; else if (v[i] >= v[ext] * (1 + thr)) { piv.push(ext); mode = 1; ext = i; } }
  }
  if (piv.at(-1) !== v.length - 1) piv.push(v.length - 1);
  return [...new Set(piv)];
}
const MIN_DAYS = 21, SIDE_DAYS = 45, SIDE_BAND = 1.12 / 0.88;   // ±12%

function mergeShort(segs) {
  let changed = true;
  while (changed && segs.length > 1) {
    changed = false;
    for (let k = 0; k < segs.length; k++) {
      const [s, e] = segs[k];
      if (e - s + 1 >= MIN_DAYS) continue;
      if (k > 0) segs[k - 1] = [segs[k - 1][0], e]; else segs[k + 1] = [s, segs[k + 1][1]];
      const keepSide = segs[k].side;
      segs.splice(k, 1);
      if (keepSide && k > 0) segs[k - 1].side = segs[k - 1].side || false;
      changed = true;
      break;
    }
  }
  return segs;
}

function hindsight(thr) {
  const piv = zigzag(cl, thr);
  let segs = [];
  for (let k = 0; k < piv.length - 1; k++) segs.push([k === 0 ? piv[k] : piv[k] + 1, piv[k + 1]]);
  segs = mergeShort(segs);
  // 2) تقسيم العرضي: 45 يوم أو أكثر داخل نطاق ±12%
  const out = [];
  for (const [s, e] of segs) {
    let i = s, cur = s;
    while (i <= e) {
      let j = i, mx = cl[i], mn = cl[i];
      while (j + 1 <= e) { const nx = Math.max(mx, cl[j + 1]), nn = Math.min(mn, cl[j + 1]); if (nx / nn > SIDE_BAND) break; mx = nx; mn = nn; j++; }
      if (j - i + 1 >= SIDE_DAYS) {
        if (i > cur) out.push(Object.assign([cur, i - 1], { side: false }));
        out.push(Object.assign([i, j], { side: true }));
        cur = j + 1; i = j + 1;
      } else i++;
    }
    if (cur <= e) out.push(Object.assign([cur, e], { side: false }));
  }
  // 3) القطع الصغيرة (أقل من 21 يوم) تنضم للي جنبها
  let segs2 = out;
  let changed = true;
  while (changed && segs2.length > 1) {
    changed = false;
    for (let k = 0; k < segs2.length; k++) {
      const [s, e] = segs2[k];
      if (e - s + 1 >= MIN_DAYS) continue;
      const into = k > 0 ? k - 1 : k + 1;
      const [a, b] = segs2[into];
      const merged = Object.assign([Math.min(a, s), Math.max(b, e)], { side: segs2[into].side });
      segs2.splice(Math.min(k, into), 2, merged);
      changed = true;
      break;
    }
  }
  // 4) "عرضي" بس إذا الفترة نفسها (بعد الدمج) باقية داخل ±12% و 45 يوم أو أكثر
  const isSide = (s, e) => { let mx = -Infinity, mn = Infinity; for (let i = s; i <= e; i++) { mx = Math.max(mx, cl[i]); mn = Math.min(mn, cl[i]); } return e - s + 1 >= SIDE_DAYS && mx / mn <= SIDE_BAND; };
  let res = segs2.map(([s, e]) => describe(s, e, isSide(s, e)));
  // 5) فترتين ورا بعض بنفس الاسم = فترة وحدة (مثل ما يسميها المحلل)
  for (let changed = true; changed;) {
    changed = false;
    for (let k = 0; k + 1 < res.length; k++) {
      if (res[k].type !== res[k + 1].type) continue;
      const s = res[k]._s, e = res[k + 1]._e;
      res.splice(k, 2, describe(s, e, isSide(s, e)));
      changed = true;
      break;
    }
  }
  return res;
}

const NAMES = { up2: 'صاعد قوي', up1: 'صاعد هادي', side: 'عرضي متذبذب', corr: 'تصحيح', down: 'هابط', crash: 'انهيار' };
function describe(s, e, side) {
  const startPrice = s > 0 ? cl[s - 1] : btc[0].open;
  const chg = (cl[e] / startPrice - 1) * 100;
  const days = e - s + 1;
  let peak = startPrice, dd = 0;
  const rets = [];
  for (let i = s; i <= e; i++) { peak = Math.max(peak, cl[i]); dd = Math.max(dd, (1 - cl[i] / peak) * 100); if (i > 0) rets.push(Math.log(cl[i] / cl[i - 1])); }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(365) * 100;
  const dists = [];
  for (let i = s; i <= e; i++) { const m = sma200At.get(btc[i].t); if (m) dists.push((cl[i] / m - 1) * 100); }
  const avgDist = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null;
  const startSma = sma200At.get(btc[s].t);
  let type;
  if (side) type = 'side';
  else if (chg <= -35 && days <= 75) type = 'crash';
  else if (chg <= -20) type = 'down';
  else if (chg < 0) type = startSma && startPrice > startSma ? 'corr' : 'down';
  else if (chg >= 60) type = 'up2';
  else type = 'up1';
  const name = NAMES[type];
  const where = avgDist == null ? '' : `، ${avgDist > 0 ? 'فوق' : 'تحت'} متوسط 200 بمتوسط ${Math.abs(r1(avgDist))}%`;
  return {
    _s: s, _e: e, type, name, startT: btc[s].t, endT: btc[e].t, start: day(btc[s].t), end: day(btc[e].t), days,
    btcStart: Math.round(startPrice), btcEnd: Math.round(cl[e]), btcChangePct: r1(chg), maxDrawdownPct: r1(dd), volatilityPct: r1(vol),
    avgDistSma200Pct: r1(avgDist),
    desc: `${name}: البتكوين ${chg > 0 ? '+' : ''}${r1(chg)}% خلال ${days} يوم (من ${Math.round(startPrice).toLocaleString('en-US')} إلى ${Math.round(cl[e]).toLocaleString('en-US')})، أكبر نزول ${r1(dd)}%، تذبذب سنوي ${r1(vol)}%${where}`,
  };
}

// ── ب) الفترات مثل ما شافها الكاشف الحي ─────────────────────────────────────
function causalPeriods() {
  const out = [];
  for (const d of btc) {
    const r = seriesAt.get(d.t);
    const b = r ? r.bucket : 'none';
    if (out.length && out.at(-1).bucket === b) { out.at(-1).endT = d.t; out.at(-1).days++; }
    else out.push({ bucket: b, startT: d.t, endT: d.t, days: 1 });
  }
  return out.map(p => ({ ...p, start: day(p.startT), end: day(p.endT), name: BUCKET_AR[p.bucket] || 'ما فيه حالة (قبل ما يكتمل متوسط 200)' }));
}

// ── ج) تأخر الاكتشاف ─────────────────────────────────────────────────────────
const EXPECT = { up2: 'bull', up1: 'bull', corr: 'correction', down: 'bear', crash: 'bear', side: 'choppy' };
function lag(p) {
  const want = EXPECT[p.type];
  const match = r => (want === 'choppy' ? r.choppy : r.state === want);
  const days = btc.filter(d => d.t >= p.startT && d.t <= p.endT);
  let first = null, ok = 0, flips = 0, prev = null, known = 0;
  days.forEach((d, k) => {
    const r = seriesAt.get(d.t);
    if (!r) return;
    known++;
    const m = match(r);
    if (m) { ok++; if (first == null) first = k; }
    const key = want === 'choppy' ? String(r.choppy) : r.state;
    if (prev != null && key !== prev && !m) flips++;
    prev = key;
  });
  return {
    expected: want, knownDays: known,
    lagDays: known === 0 ? null : first == null ? null : first + 1,     // +1: القراءة تنطبق من اليوم اللي بعده
    detected: first != null, correctDaysPct: known ? r1(ok / known * 100) : null, wrongFlips: flips,
  };
}

// ── د) و هـ) المصفوفات ───────────────────────────────────────────────────────
function runOne(stratId, period) {
  if (stratId === 'dca') { const r = B.dcaSim(period); return { returnPct: r1(r.live.returnPct), trades: r.trades, pf: null, maxDDPct: r1(r.live.maxDDPct) }; }
  const r = B.portfolio(B.byId[stratId], period);
  return { returnPct: r1(r.total / 1000 * 100), trades: r.trades, pf: r2(r.profitFactor), maxDDPct: r1(r.maxDDPct), tradeList: r.tradeList };
}
const pfOf = list => { const w = list.filter(x => x.pnl > 0).reduce((s, x) => s + x.pnl, 0), l = -list.filter(x => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0); return l > 0 ? w / l : (w > 0 ? Infinity : null); };

function regimeSplit(tradeList) {
  const g = {};
  for (const tr of tradeList) (g[bucketAt(tr.entryT)] ??= []).push(tr);
  return Object.fromEntries(['bull', 'correction', 'bear', 'choppy', 'none'].map(b => {
    const L = g[b] || [];
    const pnl = L.reduce((s, x) => s + x.pnl, 0);
    return [b, { trades: L.length, pnlUSD: r2(pnl), returnPct: r1(pnl / 1000 * 100), pf: L.length ? r2(pfOf(L)) : null, winRate: L.length ? r1(L.filter(x => x.pnl > 0).length / L.length * 100) : null }];
  }));
}

// ── التشغيل ──────────────────────────────────────────────────────────────────
function main() {
  // أ) الفترات: 20% انعكاس؛ إذا طلع العدد برا 8–20 نجرب 15% أو 25% مرة وحدة
  let thr = 0.20, periods = hindsight(thr), note = 'انعكاس 20%';
  if (periods.length < 8) { thr = 0.15; periods = hindsight(thr); note = 'انعكاس 15% (20% عطى أقل من 8 فترات)'; }
  else if (periods.length > 20) { thr = 0.25; periods = hindsight(thr); note = 'انعكاس 25% (20% عطى أكثر من 20 فترة)'; }
  periods.forEach(p => { p.detection = lag(p); });
  const causal = causalPeriods();

  // د) كل متسابق على كل فترة
  console.log(`hindsight periods: ${periods.length} (${note})`);
  const matrix = {};
  for (const [cid, sid] of CONTESTANTS) {
    matrix[cid] = periods.map(p => { const { tradeList, ...r } = runOne(sid, [p.startT, p.endT + DAY]); return r; });
    process.stdout.write('.');
  }
  const hodl = periods.map(p => r1(B.hodlSim([p.startT, p.endT + DAY]).live.returnPct));
  console.log('');

  // ملخص لكل نوع فترة: متوسط العائد لكل متسابق
  const types = [...new Set(periods.map(p => p.type))];
  const byType = Object.fromEntries(types.map(tp => {
    const idx = periods.map((p, k) => (p.type === tp ? k : -1)).filter(k => k >= 0);
    const rows = CONTESTANTS.map(([cid]) => {
      const v = idx.map(k => matrix[cid][k].returnPct ?? 0);
      return { id: cid, avgReturnPct: r1(v.reduce((a, b) => a + b, 0) / v.length), positive: v.filter(x => x > 0).length, of: v.length };
    }).sort((a, b) => b.avgReturnPct - a.avgReturnPct);
    return [tp, { name: NAMES[tp], periods: idx.length, hodlAvgPct: r1(idx.reduce((s, k) => s + hodl[k], 0) / idx.length), ranking: rows }];
  }));

  // هـ) مصفوفة الحالات: 2021–2024 بس، الصفقات حسب حالة يوم الدخول
  const regimeMatrix = {};
  for (const [cid, sid] of CONTESTANTS) {
    if (sid === 'dca') continue;                          // ما يبيع، فما فيه معامل ربح
    const r = runOne(sid, RESEARCH);
    regimeMatrix[cid] = { strategy: sid, total: { returnPct: r.returnPct, trades: r.trades, pf: r.pf, maxDDPct: r.maxDDPct }, byRegime: regimeSplit(r.tradeList) };
    process.stdout.write('+');
  }
  console.log('');
  const regimeDays = {};
  for (const d of btc.filter(x => x.t < RESEARCH[1])) { const b = seriesAt.get(d.t)?.bucket || 'none'; regimeDays[b] = (regimeDays[b] || 0) + 1; }

  const generatedAt = new Date().toISOString();
  const dataEnd = day(btc.at(-1).t);
  fs.writeFileSync(path.join(__dirname, 'market-periods.json'), JSON.stringify({
    generatedAt, dataEnd, method: note,
    periods: periods.map(({ _s, _e, ...p }, k) => ({ ...p, hodlReturnPct: hodl[k] })),
    causal: causal.map(({ startT, endT, ...p }) => p),
    matrix, byType,
  }, null, 1) + '\n');
  fs.writeFileSync(path.join(__dirname, 'regime-matrix.json'), JSON.stringify({
    generatedAt, period: '2021-01-01 → 2024-12-31', rules: B.useLiveRules && JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8')),
    regimeDays, contestants: regimeMatrix,
  }, null, 1) + '\n');
  writePeriodsMd({ periods, hodl, causal, matrix, byType, note, dataEnd });
  writeRegimeMd({ regimeMatrix, regimeDays });
  console.log('written: research/market-periods.md/.json, research/regime-matrix.md/.json');
}

const pct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const pfS = v => (v == null ? '—' : v === Infinity ? '∞' : v.toFixed(2));

function writePeriodsMd({ periods, hodl, causal, matrix, byType, note, dataEnd }) {
  const L = ['# فترات السوق (البتكوين)', '',
    `_انحسبت ${day(Date.now())} على بيانات Binance لين ${dataEnd}. كود بس، بدون ذكاء اصطناعي. **الجدول الأول بنظرة لورا: للفهم بس، مو للتداول.**_`, '',
    '## أ) الفترات بنظرة لورا', '',
    `**الطريقة (ثابتة ومكتوبة قبل):** نقاط انعكاس من زيغزاغ على الإغلاق اليومي (${note})؛ أي جزء أقل من 21 يوم ينضم للي جنبه؛ 45 يوم أو أكثر داخل نطاق ±12% = «عرضي متذبذب» (تنفحص بعد الدمج)؛ فترتين ورا بعض بنفس الاسم = فترة وحدة.`,
    'التسمية: نزول 35% أو أكثر خلال 75 يوم أو أقل = «انهيار»؛ نزول 20% أو أكثر = «هابط»؛ نزول أقل من 20% بدأ فوق متوسط 200 = «تصحيح»؛ صعود 60% أو أكثر = «صاعد قوي»؛ صعود أقل = «صاعد هادي».', '',
    '| # | الفترة | من | إلى | الأيام | البتكوين | أكبر نزول | التذبذب السنوي | عن متوسط 200 | الوصف |', '|---|---|---|---|---|---|---|---|---|---|'];
  periods.forEach((p, k) => L.push(`| ${k + 1} | ${p.name} | ${p.start} | ${p.end} | ${p.days} | ${pct(p.btcChangePct)} | ${p.maxDrawdownPct}% | ${p.volatilityPct}% | ${pct(p.avgDistSma200Pct)} | ${p.desc} |`));
  L.push('', '## ب) الفترات مثل ما شافها الكاشف الحي (يوم بيوم)', '',
    '_نفس دالة المراقب الحي (`lib/regime.js`): صاعد / تصحيح / هابط بتأكيد إغلاقين، و«متذبذب» = ADX(14) يومي تحت 20 بتأكيد يومين (يغلب). القراءة تنطبق من اليوم اللي بعده._', '',
    '| # | الحالة | من | إلى | الأيام |', '|---|---|---|---|---|');
  causal.forEach((p, k) => L.push(`| ${k + 1} | ${p.name} | ${p.start} | ${p.end} | ${p.days} |`));
  L.push('', '## ج) تأخر الاكتشاف', '',
    '_كم يوم احتاج الكاشف الحي عشان يقرأ الفترة صح (صاعد → صاعد، تصحيح → تصحيح، هابط/انهيار → هابط، عرضي → متذبذب)، ونسبة الأيام اللي قرأها صح، وكم مرة قلب غلط داخلها._', '',
    '| # | الفترة | من | المتوقع | التأخر (يوم) | أيام صح | قلبات غلط |', '|---|---|---|---|---|---|---|');
  periods.forEach((p, k) => {
    const d = p.detection;
    L.push(`| ${k + 1} | ${p.name} | ${p.start} | ${BUCKET_AR[d.expected]} | ${d.knownDays === 0 ? 'قبل ما يبدأ الكاشف' : d.detected ? d.lagDays : 'ما اكتشفها'} | ${d.correctDaysPct == null ? '—' : d.correctDaysPct + '%'} | ${d.wrongFlips} |`);
  });
  L.push('', '## د) كل متسابق على كل فترة (العائد %، الصفقات، معامل الربح)', '',
    '_حساب المِحَك بالقوانين الحية (10 خانات، $100 للصفقة، حد خسارة يومي، إيقاف بعد 4 خسائر). الشراء الدوري بميزانيته موزّعة على أسابيع الفترة. hodl = كل الـ$1000 بتكوين._', '',
    `| المتسابق | ${periods.map((p, k) => `${k + 1}. ${p.name}`).join(' | ')} |`, `|---|${periods.map(() => '---').join('|')}|`);
  for (const [cid] of CONTESTANTS) L.push(`| ${cid} | ${matrix[cid].map(r => `${pct(r.returnPct)} · ${r.trades} · ${pfS(r.pf)}`).join(' | ')} |`);
  L.push(`| hodl | ${hodl.map(pct).join(' | ')} |`, '', '### من يربح في كل نوع فترة (متوسط العائد)', '');
  for (const [tp, v] of Object.entries(byType)) {
    L.push(`- **${v.name}** (${v.periods} فترة، hodl ${pct(v.hodlAvgPct)}): ${v.ranking.slice(0, 3).map(r => `${r.id} ${pct(r.avgReturnPct)} (ربح في ${r.positive}/${r.of})`).join('، ')} · الأضعف: ${v.ranking.at(-1).id} ${pct(v.ranking.at(-1).avgReturnPct)}`);
  }
  fs.writeFileSync(path.join(__dirname, 'market-periods.md'), L.join('\n') + '\n');
}

function writeRegimeMd({ regimeMatrix, regimeDays }) {
  const order = ['bull', 'correction', 'bear', 'choppy'];
  const L = ['# مصفوفة حالات السوق (2021–2024)', '',
    '_كل متسابق كحساب مِحَك واحد بالقوانين الحية على 2021-01-01 → 2024-12-31، والصفقات مقسّمة حسب حالة السوق يوم الدخول (المعروفة وقتها، نفس دالة المراقب الحي). العائد = ربح الصفقات ÷ $1000. الشراء الدوري مستبعد (ما يبيع)._', '',
    `أيام كل حالة في فترة البحث: ${order.concat('none').map(b => `${BUCKET_AR[b] || 'ما فيه حالة'} ${regimeDays[b] || 0}`).join(' · ')}`, '',
    `| المتسابق | الكل | ${order.map(b => BUCKET_AR[b]).join(' | ')} |`, `|---|---|${order.map(() => '---').join('|')}|`];
  for (const [cid, v] of Object.entries(regimeMatrix)) {
    const cell = x => `${pct(x.returnPct)} · ${x.trades} صفقة · PF ${pfS(x.pf)} · فوز ${x.winRate == null ? '—' : x.winRate + '%'}`;
    L.push(`| ${cid} | ${pct(v.total.returnPct)} · ${v.total.trades} · PF ${pfS(v.total.pf)} | ${order.map(b => cell(v.byRegime[b])).join(' | ')} |`);
  }
  fs.writeFileSync(path.join(__dirname, 'regime-matrix.md'), L.join('\n') + '\n');
}

// ── المايسترو ────────────────────────────────────────────────────────────────
function maestroRun(oos) {
  const { MAESTRO_MAPPING } = require('../lib/maestro');
  if (!B.byId.maestro) throw new Error(`${MAESTRO_MAPPING} not found: run scripts/maestro-mapping.js first`);
  const file = path.join(__dirname, oos ? 'maestro-oos.json' : 'maestro-insample.json');
  if (oos && fs.existsSync(file)) throw new Error('the 2025→now run was already done once (research/maestro-oos.json) — refusing to run it again');
  const period = oos ? OOS : RESEARCH;
  const rows = ['maestro', 'breakout-btc-4h'].map(id => {
    const r = B.portfolio(B.byId[id], period);
    const byRegime = regimeSplit(r.tradeList);
    return { id: id === 'maestro' ? 'maestro' : 'code-breakout-btc', returnPct: r1(r.total / 1000 * 100), trades: r.trades, pf: r2(r.profitFactor), maxDDPct: r1(r.maxDDPct), winRate: r1(r.winRate), byRegime };
  });
  const h = B.hodlSim(period);
  rows.push({ id: 'hodl', returnPct: r1(h.live.returnPct), trades: 1, pf: null, maxDDPct: r1(h.live.maxDDPct) });
  const res = { ranAt: new Date().toISOString(), period: oos ? `2025-01-01 → ${day(btc.at(-1).t)}` : '2021-01-01 → 2024-12-31', mapping: MAESTRO_MAPPING, rows };
  fs.writeFileSync(file, JSON.stringify(res, null, 1) + '\n', { flag: oos ? 'wx' : 'w' });
  for (const r of rows) console.log(`${r.id.padEnd(18)} ${String(r.returnPct).padStart(7)}%  trades ${String(r.trades).padStart(5)}  PF ${pfS(r.pf)}  maxDD ${r.maxDDPct}%`);
  return res;
}

if (require.main === module) {
  if (process.argv.includes('--maestro')) maestroRun(false);
  else if (process.argv.includes('--maestro-oos')) maestroRun(true);
  else main();
}

module.exports = { regimeSplit, bucketAt, hindsight, CONTESTANTS };
