// ═══════════════════════════════════════════════════════════════════════════
//  المِحَك (Mihak) — مسابقة: "الحين" ضد "الماضي" مع حَكَمين
//  كل المتسابقين يتداولون ورقياً (بدون فلوس حقيقية) بنفس القوانين.
// ═══════════════════════════════════════════════════════════════════════════
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const acc = require('./lib/accounting');
const ai = require('./lib/ai');
const { LiveMarket, MockMarket } = require('./lib/market');
const ind = require('./lib/indicators');
const { createMcpHandler } = require('./lib/mcp');
const strategies = require('./lib/strategies');

// ── الإعداد من متغيرات البيئة (ملف .env) ─────────────────────────────────────
const ENV = process.env;
const PORT = Number(ENV.PORT) || 3000;
const DEMO = ENV.DEMO === '1';                       // وضع التجربة: أسعار وقرارات وهمية
const DB_PATH = path.resolve(__dirname, ENV.DB_FILE || 'db.json'); // على Railway: DB_FILE=/data/db.json (Volume)
const KEYS = {
  xai: ENV.XAI_API_KEY || '',
  openrouter: ENV.OPENROUTER_API_KEY || '',
  webhook: ENV.WEBHOOK_SECRET || '',
  dashboard: ENV.DASHBOARD_PASSWORD || '',
  mcp: ENV.MCP_SECRET || '',              // موصّل Claude: الرابط /mcp/<MCP_SECRET>
};
// حسابات أخبار معروفة على X (البحث فيها يتحاسب لكل تغريدة، فنحصره)
const NEWS_X_HANDLES = (ENV.NEWS_X_HANDLES || 'WatcherGuru,whale_alert,CoinDesk,tier10k')
  .split(',').map(s => s.trim()).filter(Boolean);
const MODELS = {
  news: ENV.NEWS_MODEL || 'x-ai/grok-4.7',          // نبض تويتر
  webNews: ENV.WEB_NEWS_MODEL || 'perplexity/sonar', // أخبار المواقع
  qwen: ENV.QWEN_MODEL || 'qwen/qwen3.8-max-prime',
  deepseek: ENV.DEEPSEEK_MODEL || '~deepseek/deepseek-pro-latest',
  member: ENV.MEMBER_MODEL || '~deepseek/deepseek-flash-latest',   // خبراء الاجتماع (رخيص)
  chair: ENV.CHAIR_MODEL || ENV.QWEN_MODEL || 'qwen/qwen3.8-max-prime', // رئيس الاجتماع
  fable: ENV.FABLE_MODEL || 'fable (Claude Code)',   // كشّاف يشتغل على جهاز المالك، مو على السيرفر
};
const FABLE_WINDOW_MS = 5 * 60_000;                  // كم ينتظر السيرفر قرار Fable بعد بداية الجولة

// ── قوانين المسابقة (نفسها للكل، وتنقفل عند البداية) ──────────────────────────
const DEFAULT_RULES = {
  startingBalance: 1000,        // رصيد وهمي لكل متسابق
  tradeAmount: 100,             // مبلغ كل صفقة
  takeProfitPercent: 3.0,       // احتياطي: إذا التوصية ما حددت هدف
  stopLossPercent: -2,          // احتياطي: إذا التوصية ما حددت وقف
  maxTradeTimeMinutes: 1440,    // احتياطي: إذا التوصية ما حددت مدة
  minStopPercent: 1,            // أقرب وقف تقدر التوصية تحطه (%)
  maxStopPercent: 5,            // أبعد وقف تقدر التوصية تحطه (%)
  minRewardRisk: 1.5,           // الهدف لازم يكون على الأقل هالقدر × الوقف
  maxTakeProfitPercent: 20,     // أبعد هدف مسموح (%)
  minHoldHours: 1,              // أقل مدة تقدر التوصية تحددها
  maxHoldHours: 48,             // أطول مدة تقدر التوصية تحددها
  shadowMeetings: true,         // اجتماع على أقوى فرصة حتى لو الكشّاف قال انتظر (للقياس بس)
  maxConcurrentTrades: 3,       // أقصى صفقات مفتوحة لكل متسابق
  feePercent: 0.1,              // رسوم كل جهة (دخول/خروج)
  slippagePercent: 0.05,        // انزلاق أوامر السوق
  dailyLossLimitPercent: 5,     // إيقاف المتسابق باقي اليوم إذا خسر هالنسبة من رصيده
  consecutiveLossLimit: 4,      // عدد الخسائر المتتالية اللي توقف المتسابق مؤقتاً
  cooldownHours: 6,             // مدة الإيقاف المؤقت، ثم يرجع تلقائياً
  decisionIntervalMinutes: 15,  // كل كم دقيقة يقرر "الحين" والعشوائي
  newsIntervalMinutes: 60,      // كل كم دقيقة أخبار المواقع (Perplexity، رخيص)
  xIntervalMinutes: 240,        // كل كم دقيقة نبض تويتر (Grok، أغلى)
  minConfidence: 50,            // أقل ثقة للدخول
  randomEntryProbability: 0.5,  // احتمال دخول العشوائي في كل جولة
  strategyStopLossPercent: -3,  // وقف افتراضي لـ"الماضي" إذا الإشارة ما حددت وقف
  ruleChairMinVotes: 2,         // المدير بالكود: كم خبير لازم يقول ENTER (من 3)
  ruleChairMinConfidence: 60,   // المدير بالكود: أقل متوسط ثقة للموافقين
};

const RULE_LIMITS = {
  startingBalance: [100, 1e7], tradeAmount: [1, 1e6], takeProfitPercent: [0.1, 50],
  stopLossPercent: [-50, -0.1], maxTradeTimeMinutes: [1, 100000], maxConcurrentTrades: [1, 20],
  feePercent: [0, 2], slippagePercent: [0, 2], dailyLossLimitPercent: [0.5, 100],
  consecutiveLossLimit: [1, 50], cooldownHours: [0, 168], decisionIntervalMinutes: [1, 1440],
  newsIntervalMinutes: [5, 1440], xIntervalMinutes: [15, 2880], minConfidence: [0, 100], randomEntryProbability: [0, 1],
  strategyStopLossPercent: [-50, -0.1], ruleChairMinVotes: [1, 3], ruleChairMinConfidence: [0, 100],
  minStopPercent: [0.2, 20], maxStopPercent: [0.5, 50], minRewardRisk: [0.5, 10], maxTakeProfitPercent: [1, 100],
  minHoldHours: [0.25, 168], maxHoldHours: [0.5, 720],
};

// خطة الصفقة من التوصية، بعد ما نحصرها داخل الحدود
function clampPlan(raw = {}, r = R()) {
  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.abs(Number(v)));
  let sl = num(raw.stopLossPercent) ?? Math.abs(r.stopLossPercent);
  sl = Math.min(Math.max(sl, r.minStopPercent), r.maxStopPercent);
  let tp = num(raw.takeProfitPercent) ?? Math.max(Math.abs(r.takeProfitPercent), sl * 2);
  tp = Math.min(Math.max(tp, sl * r.minRewardRisk), Math.max(r.maxTakeProfitPercent, sl * r.minRewardRisk));
  let h = num(raw.maxHoldHours) ?? r.maxTradeTimeMinutes / 60;
  h = Math.min(Math.max(h, r.minHoldHours), r.maxHoldHours);
  const round2 = x => Math.round(x * 100) / 100;
  const plan = { takeProfitPercent: round2(tp), stopLossPercent: -round2(sl), maxHoldHours: round2(h) };
  const adjusted = ['takeProfitPercent', 'stopLossPercent', 'maxHoldHours'].some(k => num(raw[k]) == null || Math.abs(num(raw[k]) - Math.abs(plan[k])) > 0.005);
  return { ...plan, adjusted, proposed: { takeProfitPercent: raw.takeProfitPercent ?? null, stopLossPercent: raw.stopLossPercent ?? null, maxHoldHours: raw.maxHoldHours ?? null } };
}
const planOpts = p => ({ tpPercent: p.takeProfitPercent, slPercent: p.stopLossPercent, maxMinutes: Math.round(p.maxHoldHours * 60) });

// ── المتسابقين ───────────────────────────────────────────────────────────────
// كل كشّاف (Qwen / DeepSeek) له ثلاث فروع على نفس الفرص بالضبط:
//   لحاله ← يدخل فوراً | + اجتماع بمدير موديل | + اجتماع بمدير كود
const BOTS = [
  { id: 'now-qwen', name: 'Qwen · لحاله', kind: 'ai', model: MODELS.qwen, team: 'now', family: 'qwen',
    desc: 'كل 15 دقيقة: Grok يجيب الأخبار، وQwen يدوّر أقوى فرصة ويدخل فوراً.' },
  { id: 'now-qwen-chair', name: 'Qwen · اجتماع (مدير موديل)', kind: 'meeting', chair: 'model', source: 'now-qwen', team: 'now', family: 'qwen', model: MODELS.chair,
    desc: 'نفس فرص Qwen. قبل الدخول ينعقد اجتماع (اتجاه، أخبار، مخاطر)، ومدير موديل يقرر.' },
  { id: 'now-qwen-rule', name: 'Qwen · اجتماع (مدير كود)', kind: 'meeting', chair: 'rule', source: 'now-qwen', team: 'now', family: 'qwen',
    desc: 'نفس فرص Qwen ونفس أصوات الخبراء، لكن القرار بقاعدة ثابتة بالكود.' },
  { id: 'now-qwen-always', name: 'Qwen · يدخل دائماً', kind: 'always', source: 'now-qwen', team: 'now', family: 'qwen', model: MODELS.qwen,
    desc: 'نفس كشّاف Qwen، لكن يدخل أقوى فرصة سمّاها في كل جولة حتى لو Qwen قال انتظر. يقيس: هل انتظار Qwen يفيد؟' },
  { id: 'now-deepseek', name: 'DeepSeek · لحاله', kind: 'ai', model: MODELS.deepseek, team: 'now', family: 'deepseek',
    desc: 'نفس الأخبار ونفس السوق، لكن DeepSeek يدوّر الفرصة ويدخل فوراً.' },
  { id: 'now-deepseek-chair', name: 'DeepSeek · اجتماع (مدير موديل)', kind: 'meeting', chair: 'model', source: 'now-deepseek', team: 'now', family: 'deepseek', model: MODELS.chair,
    desc: 'نفس فرص DeepSeek. اجتماع خبراء، ومدير موديل يقرر.' },
  { id: 'now-deepseek-rule', name: 'DeepSeek · اجتماع (مدير كود)', kind: 'meeting', chair: 'rule', source: 'now-deepseek', team: 'now', family: 'deepseek',
    desc: 'نفس فرص DeepSeek ونفس أصوات الخبراء، والقرار بقاعدة ثابتة بالكود.' },
  { id: 'now-deepseek-always', name: 'DeepSeek · يدخل دائماً', kind: 'always', source: 'now-deepseek', team: 'now', family: 'deepseek', model: MODELS.deepseek,
    desc: 'نفس كشّاف DeepSeek، لكن يدخل أقوى فرصة سمّاها في كل جولة حتى لو DeepSeek قال انتظر.' },
  { id: 'now-fable', name: 'Fable · لحاله', kind: 'ai', remote: true, model: MODELS.fable, team: 'now', family: 'fable',
    desc: 'كشّاف Fable يشتغل على جهاز المالك عن طريق Claude Code، بنفس اللقطة ونفس الأخبار ونفس الطلب. إذا ما وصل قراره خلال 5 دقايق، الجولة تنحسب "فاتته".' },
  { id: 'now-fable-chair', name: 'Fable · اجتماع (مدير موديل)', kind: 'meeting', chair: 'model', source: 'now-fable', team: 'now', family: 'fable', model: MODELS.chair,
    desc: 'نفس فرص Fable. اجتماع خبراء (نفس موديلات العائلات الثانية)، ومدير موديل يقرر.' },
  { id: 'now-fable-rule', name: 'Fable · اجتماع (مدير كود)', kind: 'meeting', chair: 'rule', source: 'now-fable', team: 'now', family: 'fable',
    desc: 'نفس فرص Fable ونفس أصوات الخبراء، والقرار بقاعدة ثابتة بالكود.' },
  { id: 'now-fable-always', name: 'Fable · يدخل دائماً', kind: 'always', source: 'now-fable', team: 'now', family: 'fable', model: MODELS.fable,
    desc: 'نفس كشّاف Fable، لكن يدخل أقوى فرصة سمّاها في كل جولة حتى لو Fable قال انتظر.' },
  { id: 'code-breakout-btc', name: 'الكود · بريك أوت + فلتر البتكوين', kind: 'code', strategy: 'breakout-btc-4h', team: 'code',
    desc: 'استراتيجية بالكود بدون ذكاء اصطناعي، نجحت في الاختبار التاريخي (2022–2024) والفحص المستقل (2025→2026): كسر أعلى 20 شمعة (4 ساعات) والاتجاه صاعد فوق EMA200 والبتكوين فوق متوسط 200 يوم. وقف 2.5 ATR، ووقف ملاحق 3 ATR على الإغلاق. التفاصيل في strategy-research.md.' },
  { id: 'past-strategy', name: 'الماضي · استراتيجية', kind: 'webhook', team: 'past',
    desc: 'استراتيجية مختبرة على سنين في TradingView، ترسل إشاراتها هنا.' },
  { id: 'random', name: 'العشوائي', kind: 'random', referee: true,
    desc: 'حَكَم: يختار العملة والتوقيت بالقرعة، وياخذ نفس الهدف والوقف والمدة اللي حددها آخر كشّاف. إذا ما غلبته، اختيار الذكاء ما أضاف شي.' },
  { id: 'hodl', name: 'اشترِ واحتفظ BTC', kind: 'hodl', referee: true,
    desc: 'حَكَم: يشتري بتكوين بكل الرصيد أول يوم ويقعد. إذا ما غلبته، أحسن لك تشتري وترتاح.' },
];
const BOT = Object.fromEntries(BOTS.map(b => [b.id, b]));

// ── السجل ────────────────────────────────────────────────────────────────────
const ts = () => new Date().toISOString();
const log = {
  info: m => console.log(`[${ts()}] ℹ  ${m}`),
  ok: m => console.log(`[${ts()}] ✓  ${m}`),
  warn: m => console.warn(`[${ts()}] ⚠  ${m}`),
  err: m => console.error(`[${ts()}] ✗  ${m}`),
  trade: m => console.log(`[${ts()}] ◈  ${m}`),
};

// ── الحالة ───────────────────────────────────────────────────────────────────
function freshBot(rules) {
  return {
    balance: rules.startingBalance,
    trades: [],
    balanceHistory: [{ time: Date.now(), balance: rules.startingBalance }],
    decisions: [],
    aiCostUSD: 0,
    cb: { consecutiveLosses: 0, pausedUntil: null },
    system: { lastRun: null, lastError: null, note: null },
  };
}

let state = {
  version: 3,
  rules: { ...DEFAULT_RULES },
  competition: { startedAt: null, locked: false },
  bots: Object.fromEntries(BOTS.map(b => [b.id, freshBot(DEFAULT_RULES)])),
  news: { text: null, at: null, searches: 0, error: null },
  opportunities: [],   // كل فرصة لقاها كشّاف + أصوات الاجتماع + نتيجتها الافتراضية
  fable: freshFable(), // جولات كشّاف Fable: كم وحدة رد فيها وكم فاتته
  system: { bootAt: Date.now(), nextDecisionAt: null, universe: [] },
};

function freshFable() {
  // presentRounds: الجولات اللي رد فيها Fable — المقارنة العادلة بين العائلات تكون عليها بس
  return { rounds: 0, present: 0, missed: 0, skipped: 0, presentRounds: [], lastRound: null };
}

let universe = [];          // رموز العملات الحلال المتاحة على Binance (BTCUSDT...)
let dirty = true;
let market;

// ── التخزين ──────────────────────────────────────────────────────────────────
function loadDb() {
  try {
    const saved = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    if (saved.version !== 3) {
      const backup = DB_PATH.replace(/\.json$/, `.v${saved.version || 2}-backup.json`);
      fs.copyFileSync(DB_PATH, backup);
      log.warn(`db.json من نسخة قديمة — انحفظ في ${path.basename(backup)} وبدينا من جديد`);
      return;
    }
    state = {
      ...state, ...saved,
      // ترقية: قبل تقسيم الأخبار، newsIntervalMinutes كان لـ Grok. الحين صار للمواقع (رخيص) فنرجعه لساعة.
      rules: { ...DEFAULT_RULES, ...saved.rules,
        ...(saved.rules && saved.rules.xIntervalMinutes == null ? { newsIntervalMinutes: 60 } : {}),
        // ترقية: الهدف والوقف صاروا من التوصية. الأرقام الثابتة القديمة صارت احتياطي بس.
        ...(saved.rules && saved.rules.minStopPercent == null ? { takeProfitPercent: DEFAULT_RULES.takeProfitPercent, stopLossPercent: DEFAULT_RULES.stopLossPercent, maxTradeTimeMinutes: DEFAULT_RULES.maxTradeTimeMinutes } : {}) },
      bots: Object.fromEntries(BOTS.map(b => [b.id, { ...freshBot(DEFAULT_RULES), ...(saved.bots?.[b.id] || {}) }])),
      fable: { ...freshFable(), ...(saved.fable || {}) },
      system: { ...state.system, ...saved.system, bootAt: Date.now() },
    };
    log.ok('الحالة انقرأت من db.json');
  } catch (e) {
    if (e.code !== 'ENOENT') log.err(`قراءة db.json: ${e.message}`);
    else log.info('ما فيه db.json — بداية جديدة');
  }
}

let saving = false;
async function saveDb() {
  if (saving) return;
  saving = true;
  try {
    const tmp = DB_PATH + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(state));
    await fsp.rename(tmp, DB_PATH);
  } catch (e) {
    log.err(`حفظ db.json: ${e.message}`);
  } finally {
    saving = false;
  }
}

// ── أدوات الحساب ─────────────────────────────────────────────────────────────
const R = () => state.rules;
const activeTrades = id => state.bots[id].trades.filter(t => t.status === 'active');
const dayKey = t => new Date(t).toLocaleDateString('en-CA', { timeZone: ENV.TZ || 'Asia/Kuwait' });

function equityOf(id) {
  const bot = state.bots[id];
  let eq = bot.balance;
  for (const t of activeTrades(id)) {
    eq += acc.liquidationValue(t.qty, t.currentPrice, R()).net;
  }
  return eq;
}

function todayRealized(id) {
  const today = dayKey(Date.now());
  return state.bots[id].trades
    .filter(t => t.status !== 'active' && t.closeTime && dayKey(t.closeTime) === today)
    .reduce((s, t) => s + t.pnlUSD, 0);
}

/** هل يقدر المتسابق يفتح صفقة جديدة؟ يرجع null إذا نعم، أو سبب الرفض */
function blockReason(id) {
  const bot = state.bots[id];
  const r = R();
  if (bot.cb.pausedUntil && Date.now() < bot.cb.pausedUntil)
    return `موقوف مؤقتاً بعد ${r.consecutiveLossLimit} خسائر متتالية`;
  if (bot.cb.pausedUntil && Date.now() >= bot.cb.pausedUntil) {
    bot.cb.pausedUntil = null; bot.cb.consecutiveLosses = 0;
  }
  if (todayRealized(id) <= -r.startingBalance * r.dailyLossLimitPercent / 100)
    return 'وصل حد الخسارة اليومي';
  if (activeTrades(id).length >= r.maxConcurrentTrades) return 'كل الخانات مشغولة';
  if (bot.balance < r.tradeAmount) return 'الرصيد ما يكفي';
  return null;
}

// ── فتح وإغلاق الصفقات ──────────────────────────────────────────────────────
async function enterTrade(id, { symbol, confidence = null, reason = null, tpPercent, slPercent, maxMinutes, round = null, extra = null }) {
  const bot = state.bots[id];
  const r = R();
  if (activeTrades(id).some(t => t.symbol === symbol)) return { error: `فيه صفقة مفتوحة على ${symbol}` };
  const blocked = blockReason(id);
  if (blocked) return { error: blocked };

  let price;
  try { price = await market.price(symbol); }
  catch (e) { return { error: `ما قدرنا نجيب سعر ${symbol}: ${e.message}` }; }

  const amount = r.tradeAmount;
  const { fill, qty, feeIn } = acc.openPosition(amount, price, r);
  const tp = tpPercent ?? null;
  const sl = slPercent ?? r.stopLossPercent;

  const trade = {
    id: `trade-${crypto.randomUUID()}`,
    bot: id,
    symbol,
    amount,
    qty,
    marketPriceAtEntry: price,
    entryPrice: fill,
    takeProfit: tp != null ? fill * (1 + tp / 100) : null,
    stopLoss: fill * (1 + sl / 100),
    tpPercent: tp,
    slPercent: sl,
    maxTimeMs: maxMinutes ? maxMinutes * 60_000 : null,
    status: 'active',
    startTime: Date.now(),
    currentPrice: price,
    pnlUSD: 0,
    pnlPercent: 0,
    feesUSD: feeIn,
    closePrice: null,
    closeTime: null,
    closeReason: null,
    confidence,
    signalReason: reason,
    round,              // الجولة اللي انفتحت فيها (للمقارنة العادلة)
    ...(extra || {}),   // متسابقين الكود: الوقف الملاحق وأعلى سعر من الدخول
    priceHistory: [{ t: Date.now(), p: price }],
  };
  const live = acc.tradePnl(trade, price, r);
  trade.pnlUSD = acc.round(live.pnl);
  trade.pnlPercent = acc.round(live.pnlPercent);

  bot.balance -= amount;
  bot.trades.unshift(trade);
  market.subscribe(symbol);
  dirty = true;
  saveDb();
  log.trade(`OPEN  [${id}] ${symbol} @ ${fill.toPrecision(6)} | TP ${trade.takeProfit?.toPrecision(6) ?? '—'} | SL ${trade.stopLoss.toPrecision(6)}`);
  return { trade };
}

function closeTrade(trade, reason, observedPrice) {
  if (trade.status !== 'active') return;
  const r = R();
  const bot = state.bots[trade.bot];
  const exit = acc.exitFill(reason, observedPrice, trade, r);
  const { pnl, pnlPercent, feeOut } = acc.tradePnl(trade, exit, r);

  trade.status = pnl > 0 ? 'won' : 'lost';
  trade.closePrice = exit;
  trade.currentPrice = exit;
  trade.pnlUSD = acc.round(pnl);
  trade.pnlPercent = acc.round(pnlPercent);
  trade.feesUSD = acc.round(trade.feesUSD + feeOut, 4);
  trade.closeTime = Date.now();
  trade.closeReason = reason;
  delete trade.priceHistory;

  bot.balance += trade.amount + pnl;

  if (pnl > 0) bot.cb.consecutiveLosses = 0;
  else if (reason !== 'manual-close') {
    bot.cb.consecutiveLosses++;
    if (bot.cb.consecutiveLosses >= r.consecutiveLossLimit) {
      bot.cb.pausedUntil = Date.now() + r.cooldownHours * 3_600_000;
      log.warn(`[${trade.bot}] إيقاف مؤقت ${r.cooldownHours} ساعات بعد ${bot.cb.consecutiveLosses} خسائر متتالية`);
    }
  }

  log.trade(`CLOSE [${trade.bot}] ${trade.symbol} | ${reason} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  releaseSymbol(trade.symbol);
  dirty = true;
  saveDb();
}

function symbolNeeded(symbol) {
  if (symbol === 'BTCUSDT') return true; // اشترِ واحتفظ يحتاج سعر BTC دايم
  return BOTS.some(b => activeTrades(b.id).some(t => t.symbol === symbol))
    || state.opportunities.some(o => o.status === 'open' && o.symbol === symbol);
}
function releaseSymbol(symbol) {
  if (!symbolNeeded(symbol)) market.unsubscribe(symbol);
}

// ── تحديث الأسعار وفحص الهدف والوقف ─────────────────────────────────────────
function onPrice(symbol, price) {
  for (const b of BOTS) {
    for (const t of activeTrades(b.id)) {
      if (t.symbol !== symbol) continue;
      t.currentPrice = price;
      const live = acc.tradePnl(t, price, R());
      t.pnlUSD = acc.round(live.pnl);
      t.pnlPercent = acc.round(live.pnlPercent);
      const last = t.priceHistory?.at(-1);
      if (t.priceHistory && (!last || Date.now() - last.t > 30_000)) {
        t.priceHistory.push({ t: Date.now(), p: price });
        if (t.priceHistory.length > 120) t.priceHistory.shift();
      }
      if (t.takeProfit != null && price >= t.takeProfit) closeTrade(t, 'take-profit', price);
      else if (price <= t.stopLoss) closeTrade(t, 'stop-loss', price);
      dirty = true;
    }
  }
  for (const o of state.opportunities) {
    if (o.status !== 'open' || o.symbol !== symbol) continue;
    o.currentPrice = price;
    if (price >= o.takeProfit) closeOpportunity(o, 'take-profit', price);
    else if (price <= o.stopLoss) closeOpportunity(o, 'stop-loss', price);
  }
}

function checkTimeouts() {
  const now = Date.now();
  for (const b of BOTS) {
    for (const t of activeTrades(b.id)) {
      if (t.maxTimeMs && now - t.startTime >= t.maxTimeMs) closeTrade(t, 'timeout', t.currentPrice);
    }
  }
  for (const o of state.opportunities) {
    if (o.status === 'open' && now - o.at >= o.maxTimeMs) closeOpportunity(o, 'timeout', o.currentPrice);
  }
}

// ── لقطات رأس المال (كل 5 دقائق) ─────────────────────────────────────────────
function snapshotEquity() {
  const now = Date.now();
  for (const b of BOTS) {
    const h = state.bots[b.id].balanceHistory;
    h.push({ time: now, balance: acc.round(equityOf(b.id)) });
    if (h.length > 20_000) h.shift();
  }
  dirty = true;
}

// ── حَكَم: اشترِ واحتفظ ──────────────────────────────────────────────────────
async function ensureHodl() {
  const bot = state.bots.hodl;
  if (bot.trades.length) return;
  const r = R();
  try {
    const price = await market.price('BTCUSDT');
    const amount = bot.balance;
    const { fill, qty, feeIn } = acc.openPosition(amount, price, r);
    bot.trades.push({
      id: `trade-${crypto.randomUUID()}`, bot: 'hodl', symbol: 'BTCUSDT', amount, qty,
      marketPriceAtEntry: price, entryPrice: fill, takeProfit: null, stopLoss: -Infinity,
      tpPercent: null, slPercent: null, maxTimeMs: null, status: 'active', startTime: Date.now(),
      currentPrice: price, pnlUSD: 0, pnlPercent: 0, feesUSD: feeIn, closePrice: null,
      closeTime: null, closeReason: null, confidence: null, signalReason: 'شراء واحد والاحتفاظ لنهاية المسابقة',
      priceHistory: [{ t: Date.now(), p: price }],
    });
    bot.balance = 0;
    market.subscribe('BTCUSDT');
    log.trade(`HODL  اشترى BTC بـ $${amount} @ ${fill.toFixed(2)}`);
    dirty = true;
    saveDb();
  } catch (e) {
    state.bots.hodl.system.lastError = e.message;
    log.err(`HODL: ${e.message}`);
  }
}

// ── جولة القرار (كل decisionIntervalMinutes) ────────────────────────────────
function recordDecision(id, d) {
  const bot = state.bots[id];
  bot.decisions.unshift({ at: Date.now(), ...d });
  if (bot.decisions.length > 300) bot.decisions.length = 300;
  bot.system.lastRun = Date.now();
}

async function refreshNews(force = false) {
  const r = R();
  const coins = universe.map(x => x.replace(/USDT$/, ''));
  const n = state.news;
  n.web ??= { text: null, at: null, costUSD: null, error: null };
  n.x ??= { text: null, at: null, costUSD: null, error: null };
  const due = (part, minutes) => force || !part.at || Date.now() - part.at >= minutes * 60_000;
  const jobs = [];

  if (due(n.web, r.newsIntervalMinutes) && (DEMO || KEYS.openrouter)) {
    jobs.push((async () => {
      try {
        const res = DEMO ? await ai.mockWeb(coins) : await ai.fetchWebNews({ apiKey: KEYS.openrouter, model: MODELS.webNews, coins });
        Object.assign(n.web, { text: res.text, at: Date.now(), costUSD: res.costUSD, error: null });
        n.totalCostUSD = (n.totalCostUSD || 0) + (res.costUSD || 0);
        log.ok(`أخبار المواقع: $${(res.costUSD || 0).toFixed(4)}`);
      } catch (e) { n.web.error = e.message; log.err(`أخبار المواقع: ${e.message}`); }
    })());
  }
  if (due(n.x, r.xIntervalMinutes) && (DEMO || KEYS.openrouter || KEYS.xai)) {
    jobs.push((async () => {
      try {
        const res = DEMO ? await ai.mockX()
          : KEYS.xai ? await ai.fetchNewsBrief({ apiKey: KEYS.xai, model: MODELS.news, coins })
          : await ai.fetchXBuzz({ apiKey: KEYS.openrouter, model: MODELS.news, coins, xHandles: NEWS_X_HANDLES });
        Object.assign(n.x, { text: res.text, at: Date.now(), costUSD: res.costUSD ?? null, error: null });
        n.totalCostUSD = (n.totalCostUSD || 0) + (res.costUSD || 0);
        log.ok(`نبض تويتر: $${(res.costUSD || 0).toFixed(4)}`);
      } catch (e) { n.x.error = e.message; log.err(`نبض تويتر: ${e.message}`); }
    })());
  }
  if (!jobs.length) return;
  await Promise.all(jobs);

  // النص اللي يقراه الوكلاء: المواقع + تويتر، مع عمر كل جزء
  const age = t => t ? `${Math.round((Date.now() - t) / 60_000)} min ago` : 'n/a';
  const parts = [];
  if (n.web.text) parts.push(`WEB NEWS (updated ${age(n.web.at)}):\n${n.web.text}`);
  if (n.x.text) parts.push(`X / TWITTER BUZZ (updated ${age(n.x.at)}):\n${n.x.text}`);
  n.text = parts.join('\n\n') || null;
  n.at = Math.max(n.web.at || 0, n.x.at || 0) || null;
  n.error = n.web.error && n.x.error ? `${n.web.error} | ${n.x.error}` : null;
  dirty = true;
}

// ── الكشّاف وفروعه: نفس الفرصة، ثلاث طرق قرار ──────────────────────────────
function familyOf(scoutId) {
  return [scoutId, ...BOTS.filter(b => b.source === scoutId).map(b => b.id)];
}

// قبل ما نسأل الكشّاف: إذا العائلة كلها موقوفة أو ما فيه مفتاح، نسجّل SKIP ونرجع null
function familyPrecheck(scoutId) {
  const ids = familyOf(scoutId);
  const blocked = Object.fromEntries(ids.map(id => [id, blockReason(id)]));
  // إذا كل أفراد العائلة مشغولين، ما نصرف على الكشّاف
  if (ids.every(id => blocked[id])) {
    ids.forEach(id => recordDecision(id, { action: 'SKIP', reason: blocked[id] }));
    return null;
  }
  if (!DEMO && !KEYS.openrouter) {
    ids.forEach(id => {
      state.bots[id].system.note = 'متوقف: ما فيه OPENROUTER_API_KEY';
      recordDecision(id, { action: 'SKIP', reason: state.bots[id].system.note });
    });
    return null;
  }
  return blocked;
}

// نفس الطلب للكل: الكشّافين على السيرفر وكشّاف Fable على جهاز المالك
function scoutInputs(scoutId, snapshot) {
  const held = activeTrades(scoutId).map(t => t.symbol);
  const allowed = snapshot.map(m => m.symbol).filter(s => !held.includes(s));
  const prompt = ai.decisionPrompt({ news: state.news.text, market: snapshot, held, rules: R() });
  return { held, allowed, prompt };
}

async function runFamily(scoutId, snapshot, round = null) {
  const def = BOT[scoutId];
  const ids = familyOf(scoutId);
  if (!familyPrecheck(scoutId)) return;

  const { allowed, prompt } = scoutInputs(scoutId, snapshot);
  let d;
  try {
    d = DEMO ? await ai.mockDecide({ allowed })
      : await ai.decide({ apiKey: KEYS.openrouter, model: def.model, prompt, allowed });
  } catch (e) {
    ids.forEach(id => { state.bots[id].system.lastError = e.message; recordDecision(id, { action: 'ERROR', reason: e.message.slice(0, 200) }); });
    log.err(`[${scoutId}] ${e.message}`);
    return;
  }
  d.round = round;
  await applyScoutDecision(scoutId, d, snapshot);
}

// بعد ما يقرر الكشّاف (أياً كان مكانه): الدخول، "يدخل دائماً"، والاجتماع
async function applyScoutDecision(scoutId, d, snapshot) {
  const ids = familyOf(scoutId);
  const variants = ids.filter(id => BOT[id].kind === 'meeting');
  const always = ids.filter(id => BOT[id].kind === 'always');
  const blocked = Object.fromEntries(ids.map(id => [id, blockReason(id)]));
  const round = d.round ?? null;
  // تكلفة كل طريقة لو اشتغلت لحالها: الكل يدفع تكلفة الكشّاف
  ids.forEach(id => { state.bots[id].aiCostUSD += d.costUSD; state.bots[id].system.lastError = null; });

  const isOpportunity = d.action === 'BUY' && d.confidence >= R().minConfidence;
  const scoutAction = d.action === 'BUY' && !isOpportunity ? 'WAIT (ثقة منخفضة)' : d.action;
  const plan = clampPlan(d.plan);
  if (d.symbol) state.system.lastPlan = { ...plan, from: scoutId, symbol: d.symbol, at: Date.now() };
  const scoutBlocked = blocked[scoutId] && isOpportunity;
  recordDecision(scoutId, { action: scoutBlocked ? 'SKIP' : scoutAction, symbol: d.symbol, plan: d.symbol ? plan : null, confidence: d.confidence, reason: d.reason, costUSD: d.costUSD, model: d.modelUsed, note: scoutBlocked ? blocked[scoutId] : null, round, ...(d.usage ? { usage: d.usage } : {}) });

  // "يدخل دائماً": يدخل أقوى فرصة سمّاها الكشّاف، أياً كان قراره
  for (const id of always) {
    if (!d.symbol) { recordDecision(id, { action: 'WAIT', reason: 'الكشّاف ما سمّى أي عملة' }); continue; }
    recordDecision(id, { action: blocked[id] ? 'SKIP' : 'BUY', symbol: d.symbol, plan, confidence: d.confidence,
      reason: `الكشّاف قال ${d.action === 'BUY' ? 'اشترِ' : 'انتظر'}: ${d.reason}`, note: blocked[id] || null, costUSD: d.costUSD });
    if (!blocked[id]) {
      const res = await enterTrade(id, { symbol: d.symbol, confidence: d.confidence, reason: d.reason, ...planOpts(plan), round });
      if (res.error) state.bots[id].decisions[0].note = res.error;
    }
  }

  if (!isOpportunity) {
    // الكشّاف ما دخل. إذا سمّى أقوى فرصة، نعقد عليها اجتماع افتراضي ونتابعها على الورق
    if (d.symbol && R().shadowMeetings && variants.length) {
      await holdMeeting(scoutId, d, snapshot, blocked, plan, { shadow: true });
    } else {
      variants.forEach(id => recordDecision(id, { action: 'WAIT', reason: 'الكشّاف ما لقى فرصة' }));
      if (d.symbol) await recordOpportunity(scoutId, d, plan, null, null, null, 0, { shadow: true });
    }
    return;
  }
  if (!blocked[scoutId]) {
    const res = await enterTrade(scoutId, { symbol: d.symbol, confidence: d.confidence, reason: d.reason, ...planOpts(plan), round });
    if (res.error) state.bots[scoutId].decisions[0].note = res.error;
  }
  if (variants.length) await holdMeeting(scoutId, d, snapshot, blocked, plan, { shadow: false });
}

async function holdMeeting(scoutId, d, snapshot, blocked, plan, { shadow = false } = {}) {
  const r = R();
  const symbol = d.symbol;
  const variants = familyOf(scoutId).filter(id => BOT[id].kind === 'meeting');
  try {
    const [k4, k1] = await Promise.all([market.klines(symbol, '4h'), market.klines(symbol, '1d')]);
    const h4 = ind.summarize(k4), d1 = ind.summarize(k1);
    const row = snapshot.find(m => m.symbol === symbol) || {};
    const btc = snapshot.find(m => m.symbol === 'BTCUSDT') || {};
    const risk = {
      chg1h: row.chg1h, chg4h: row.chg4h, chg24h: row.chg24h,
      atr4hPct: h4.atrPct, stopDistancePct: Math.abs(plan.stopLossPercent), targetPct: plan.takeProfitPercent, maxHoldHours: plan.maxHoldHours,
      rsi4h: h4.rsi14, btcChg24h: btc.chg24h,
      hourKuwait: Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuwait', hour: 'numeric', hour12: false })),
    };
    const prompts = ai.memberPrompts({ symbol, rules: r, plan, trend: { h4, d1 }, news: state.news.text, risk });

    const roles = ['trend', 'news', 'risk'];
    const results = await Promise.all(roles.map(async role => {
      try {
        if (DEMO) return await ai.mockVote();
        const c = await ai.chat({ apiKey: KEYS.openrouter, model: MODELS.member, prompt: prompts[role], maxTokens: 2000 });
        return { ...ai.parseVote(c.text), costUSD: c.costUSD };
      } catch (e) {
        return { error: e.message.slice(0, 120), costUSD: 0 };
      }
    }));
    const votes = {};
    let membersCost = 0;
    roles.forEach((role, i) => { membersCost += results[i].costUSD || 0; if (!results[i].error) votes[role] = results[i]; });
    if (Object.keys(votes).length < 2) throw new Error(`الاجتماع ما اكتمل: ${results.map(x => x.error).filter(Boolean).join(' | ')}`);

    // المدير بالكود: قاعدة ثابتة
    const enters = Object.values(votes).filter(v => v.vote === 'ENTER');
    const avgConf = enters.length ? enters.reduce((s, v) => s + v.confidence, 0) / enters.length : 0;
    const ruleEnter = enters.length >= r.ruleChairMinVotes && avgConf >= r.ruleChairMinConfidence;
    const ruleDecision = { decision: ruleEnter ? 'ENTER' : 'SKIP', confidence: Math.round(avgConf), reason: `${enters.length}/${Object.keys(votes).length} وافقوا، متوسط ثقتهم ${Math.round(avgConf)}` };

    // المدير بالموديل
    let modelDecision = null, chairCost = 0;
    try {
      if (DEMO) {
        const m = await ai.mockVote();
        modelDecision = { decision: m.vote, confidence: m.confidence, reason: m.reason };
      } else {
        const c = await ai.chat({ apiKey: KEYS.openrouter, model: MODELS.chair, prompt: ai.chairPrompt({ symbol, plan, scoutReason: d.reason, scoutConfidence: d.confidence, votes }), maxTokens: 2000 });
        const v = ai.parseVote(c.text, 'decision');
        modelDecision = { decision: v.vote, confidence: v.confidence, reason: v.reason };
        chairCost = c.costUSD;
      }
    } catch (e) {
      modelDecision = { decision: 'SKIP', confidence: 0, reason: `خطأ المدير: ${e.message.slice(0, 60)}`, error: true };
    }

    // نسجّل الفرصة ونتابع نتيجتها الافتراضية حتى لو انرفضت
    await recordOpportunity(scoutId, d, plan, votes, modelDecision, ruleDecision, membersCost + chairCost, { shadow });

    for (const id of variants) {
      const isModel = BOT[id].chair === 'model';
      state.bots[id].aiCostUSD += membersCost + (isModel ? chairCost : 0);
      const dec = isModel ? modelDecision : ruleDecision;
      const voteSummary = Object.fromEntries(Object.entries(votes).map(([k, v]) => [k, { vote: v.vote, confidence: v.confidence, reason: v.reason }]));
      const enter = dec.decision === 'ENTER';
      if (shadow) {
        // الكشّاف ما دخل، فالفرع ما يدخل. الاجتماع هنا للقياس بس
        recordDecision(id, {
          action: 'WAIT', symbol, confidence: dec.confidence, plan,
          reason: `الكشّاف انتظر · الاجتماع (افتراضي) ${enter ? 'كان بيوافق' : 'كان بيرفض'}: ${dec.reason}`,
          votes: voteSummary, shadow: true, costUSD: membersCost + (isModel ? chairCost : 0),
        });
        continue;
      }
      recordDecision(id, {
        action: enter ? (blocked[id] ? 'SKIP' : 'BUY') : 'SKIP (الاجتماع رفض)',
        symbol, confidence: dec.confidence, reason: dec.reason, votes: voteSummary, plan,
        note: enter && blocked[id] ? blocked[id] : null,
        costUSD: membersCost + (isModel ? chairCost : 0),
      });
      if (enter && !blocked[id]) {
        const res = await enterTrade(id, { symbol, confidence: dec.confidence, reason: `اجتماع: ${dec.reason}`, ...planOpts(plan), round: d.round ?? null });
        if (res.error) state.bots[id].decisions[0].note = res.error;
      }
    }
  } catch (e) {
    variants.forEach(id => { state.bots[id].system.lastError = e.message; recordDecision(id, { action: 'ERROR', symbol, reason: e.message.slice(0, 200) }); });
    log.err(`[meeting ${scoutId}] ${e.message}`);
  }
}

// ── الفرص: نتيجة افتراضية لكل فرصة، حتى نقيس الاجتماع وكل خبير ──────────────
async function recordOpportunity(scoutId, d, plan, votes, modelDecision, ruleDecision, costUSD, { shadow = false } = {}) {
  const r = R();
  const price = await market.price(d.symbol);
  const { fill, qty } = acc.openPosition(r.tradeAmount, price, r);
  state.opportunities.unshift({
    id: `opp-${crypto.randomUUID()}`,
    at: Date.now(), source: scoutId, symbol: d.symbol,
    scoutAction: d.action, scoutConfidence: d.confidence, scoutReason: d.reason, shadow, plan,
    amount: r.tradeAmount, qty, entryPrice: fill,
    takeProfit: fill * (1 + plan.takeProfitPercent / 100), stopLoss: fill * (1 + plan.stopLossPercent / 100),
    maxTimeMs: Math.round(plan.maxHoldHours * 3_600_000),
    votes, chairModel: modelDecision, chairRule: ruleDecision, costUSD, round: d.round ?? null,
    status: 'open', currentPrice: price, pnlUSD: null, pnlPercent: null, closeReason: null, closeTime: null,
  });
  if (state.opportunities.length > 3000) state.opportunities.length = 3000;
  market.subscribe(d.symbol);
}

function closeOpportunity(o, reason, observed) {
  const exit = acc.exitFill(reason, observed, o, R());
  const { pnl, pnlPercent } = acc.tradePnl(o, exit, R());
  o.status = pnl > 0 ? 'won' : 'lost';
  o.pnlUSD = acc.round(pnl); o.pnlPercent = acc.round(pnlPercent);
  o.closeReason = reason; o.closeTime = Date.now(); o.currentPrice = exit;
  releaseSymbol(o.symbol);
  dirty = true;
}

function meetingStats(scoutId, keep = () => true) {
  const all = state.opportunities.filter(o => o.source === scoutId && keep(o));
  const closed = all.filter(o => o.status !== 'open');
  const won = o => o.status === 'won';
  const avg = a => a.length ? acc.round(a.reduce((s, o) => s + o.pnlUSD, 0) / a.length, 3) : null;
  const members = {};
  for (const role of ['trend', 'news', 'risk']) {
    const rated = closed.filter(o => o.votes?.[role]);
    const correct = rated.filter(o => (o.votes[role].vote === 'ENTER') === won(o));
    members[role] = { rated: rated.length, accuracy: rated.length ? acc.round(correct.length / rated.length * 100, 1) : null, enterRate: rated.length ? acc.round(rated.filter(o => o.votes[role].vote === 'ENTER').length / rated.length * 100, 1) : null };
  }
  const chairs = {};
  for (const [key, field] of [['model', 'chairModel'], ['rule', 'chairRule']]) {
    const rated = closed.filter(o => o[field] && !o[field].error);
    const ok = rated.filter(o => o[field].decision === 'ENTER');
    const no = rated.filter(o => o[field].decision === 'SKIP');
    const correct = rated.filter(o => (o[field].decision === 'ENTER') === won(o));
    chairs[key] = {
      approved: ok.length, rejected: no.length,
      approvedAvgPnl: avg(ok), rejectedAvgPnl: avg(no),
      rejectedThatLost: no.filter(o => !won(o)).length,
      accuracy: rated.length ? acc.round(correct.length / rated.length * 100, 1) : null,
    };
  }
  const bought = closed.filter(o => !o.shadow), waited = closed.filter(o => o.shadow);
  return {
    opportunities: all.length, open: all.length - closed.length, closed: closed.length,
    shadowCount: all.filter(o => o.shadow).length,
    scoutWinRate: bought.length ? acc.round(bought.filter(won).length / bought.length * 100, 1) : null,
    scoutAvgPnl: avg(bought),
    // لما الكشّاف قال انتظر: كم مرة كان صادق (الفرصة كانت بتخسر)
    waited: waited.length,
    waitedRight: waited.filter(o => !won(o)).length,
    waitedAvgPnl: avg(waited),
    members, chairs,
    costUSD: acc.round(all.reduce((s, o) => s + (o.costUSD || 0), 0), 4),
  };
}

// ── كشّاف Fable: يقرر على جهاز المالك ويرسل القرار هنا ─────────────────────
// السيرفر يفتح الجولة بنفس لقطة السوق ونفس الأخبار ونفس الطلب، وينتظر 5 دقايق.
let fableRound = null;   // الجولة المفتوحة الحين (في الذاكرة بس)
let fableTimer = null;
const FABLE_ID = 'now-fable';

function openFableRound(roundId, snapshot) {
  if (fableRound?.status === 'waiting') missFableRound();
  const f = state.fable;
  f.rounds++;
  const blocked = familyPrecheck(FABLE_ID);
  if (!blocked) {
    f.skipped++;
    fableRound = { id: roundId, openedAt: Date.now(), deadline: Date.now(), status: 'skipped' };
  } else {
    const { held, allowed, prompt } = scoutInputs(FABLE_ID, snapshot);
    fableRound = {
      id: roundId, openedAt: Date.now(), deadline: Date.now() + FABLE_WINDOW_MS, status: 'waiting',
      snapshot, news: state.news.text, rules: { ...R() }, held, allowed, prompt,
    };
    clearTimeout(fableTimer);
    fableTimer = setTimeout(missFableRound, FABLE_WINDOW_MS);
    fableTimer.unref?.();
  }
  f.lastRound = { id: roundId, status: fableRound.status, at: fableRound.openedAt };
  dirty = true;
  return fableRound;
}

function missFableRound() {
  if (fableRound?.status !== 'waiting') return;
  fableRound.status = 'missed';
  state.fable.missed++;
  state.fable.lastRound = { id: fableRound.id, status: 'missed', at: fableRound.openedAt };
  // ما فيه صفقة ولا فرصة: الجولة تنحسب "فاتته" للعائلة كلها
  for (const id of familyOf(FABLE_ID))
    recordDecision(id, { action: 'MISSED', reason: 'قرار Fable ما وصل خلال 5 دقايق (الجهاز طافي أو Claude Code ما اشتغل)', round: fableRound.id });
  log.warn(`Fable فاتته جولة ${new Date(fableRound.id).toISOString()}`);
  dirty = true;
}

// يرجع { status, body }. القرار يتطبق بالخلفية (الاجتماع ياخذ وقت)
function submitFableDecision(body = {}) {
  const r = fableRound;
  if (!r) return { status: 409, body: { error: 'ما فيه جولة مفتوحة' } };
  if (body.roundId !== r.id) return { status: 409, body: { error: 'الجولة مو نفس الجولة المفتوحة', roundId: r.id } };
  if (r.status !== 'waiting') return { status: 409, body: { error: `الجولة حالتها ${r.status}`, roundId: r.id } };
  if (Date.now() > r.deadline) { missFableRound(); return { status: 409, body: { error: 'وصل بعد المهلة' } }; }
  let d;
  try { d = ai.parseDecision(String(body.text || ''), r.allowed); }
  catch (e) { return { status: 400, body: { error: `رد Fable مو صالح: ${e.message}` } }; }

  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const u = body.usage || {};
  d.usage = {
    inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens),
    cacheReadTokens: num(u.cacheReadTokens), cacheCreationTokens: num(u.cacheCreationTokens),
    notionalUSD: num(u.notionalUSD), durationMs: num(u.durationMs),
  };
  d.costUSD = 0;                                      // اشتراك المالك، مو فاتورة OpenRouter
  d.modelUsed = String(body.model || MODELS.fable).slice(0, 80);
  d.raw = String(body.text || '').slice(0, 500);
  d.round = r.id;

  r.status = 'decided';
  clearTimeout(fableTimer);
  const f = state.fable;
  f.present++;
  f.presentRounds.push(r.id);
  if (f.presentRounds.length > 6000) f.presentRounds.splice(0, f.presentRounds.length - 6000);
  f.lastRound = { id: r.id, status: 'decided', at: r.openedAt };
  r.applied = applyScoutDecision(FABLE_ID, d, r.snapshot)
    .catch(e => log.err(`[${FABLE_ID}] ${e.message}`))
    .finally(() => { dirty = true; saveDb(); });
  log.info(`Fable قرر: ${d.action} ${d.symbol || ''} (${d.confidence})`);
  return { status: 200, body: { accepted: true, roundId: r.id, action: d.action, symbol: d.symbol, confidence: d.confidence } };
}

function fableSummary() {
  const { presentRounds, ...f } = state.fable;
  return {
    ...f,
    presentRate: f.rounds - f.skipped ? acc.round(f.present / (f.rounds - f.skipped) * 100, 1) : null,
    current: fableRound ? { id: new Date(fableRound.id).toISOString(), status: fableRound.status, deadline: new Date(fableRound.deadline).toISOString() } : null,
  };
}

// مقارنة عادلة: كل العائلات، بس على الجولات اللي رد فيها Fable
function fairComparison() {
  const rounds = new Set(state.fable.presentRounds);
  const scouts = Object.fromEntries(BOTS.filter(b => b.kind === 'ai').map(b => [b.id, meetingStats(b.id, o => rounds.has(o.round))]));
  const bots = {};
  for (const b of BOTS) {
    if (b.kind === 'hodl' || b.kind === 'webhook' || b.kind === 'code') continue;
    const t = state.bots[b.id].trades.filter(x => rounds.has(x.round));
    const closed = t.filter(x => x.status !== 'active');
    const won = closed.filter(x => x.pnlUSD > 0);
    bots[b.id] = {
      trades: t.length, open: t.length - closed.length, closed: closed.length,
      winRate: closed.length ? acc.round(won.length / closed.length * 100, 1) : null,
      realizedPnlUSD: acc.round(closed.reduce((s, x) => s + (x.pnlUSD || 0), 0)),
      openPnlUSD: acc.round(t.filter(x => x.status === 'active').reduce((s, x) => s + (x.pnlUSD || 0), 0)),
    };
  }
  return { roundsCompared: rounds.size, note: 'الجولات اللي رد فيها Fable بس', scouts, bots };
}

// ── متسابقين الكود: استراتيجيات lib/strategies.js على الشموع المغلقة ────────
// نفس الكود اللي انختبر في research/backtest.js. كل شمعة تنعالج مرة وحدة بس.
const CODE_FRESH_MS = { '4h': 3_600_000, '1d': 4 * 3_600_000 };   // بعد إعادة التشغيل: ندخل بس إذا الشمعة سكّرت قريب
let codeRunning = false;

async function runCodeBots(now = Date.now()) {
  if (codeRunning) return;
  codeRunning = true;
  try {
    for (const def of BOTS.filter(b => b.kind === 'code')) {
      try { await runCodeBot(def, now); }
      catch (e) { state.bots[def.id].system.lastError = e.message; log.err(`[${def.id}] ${e.message}`); }
    }
  } finally { codeRunning = false; }
}

async function runCodeBot(def, now) {
  const strat = strategies.byId[def.strategy];
  const tfMs = strategies.TF_MS[strat.tf];
  const bot = state.bots[def.id];
  bot.codeState ??= { lastCandle: {} };
  const seen = bot.codeState.lastCandle;
  // نشتغل بس إذا فيه شمعة جديدة سكّرت
  const lastClosedStart = Math.floor(now / tfMs) * tfMs - tfMs;
  if (universe.every(sym => (seen[sym] ?? -1) >= lastClosedStart)) return;

  const btc1d = strat.uses?.includes('btc1d') ? await market.klines('BTCUSDT', '1d', 1000) : null;
  const exits = [], signals = [], notes = [];
  for (const sym of universe) {
    let candles;
    try { candles = (await market.klines(sym, strat.tf, 1000)).filter(c => c.t + tfMs <= now); }
    catch (e) { notes.push(`${sym}: ${e.message}`); continue; }
    if (candles.length < 250) continue;
    const i = candles.length - 1, c = candles[i];
    if ((seen[sym] ?? -1) >= c.t) continue;
    seen[sym] = c.t;
    const d1 = strat.uses?.includes('d1') ? await market.klines(sym, '1d', 1000) : null;
    const S = strat.prepare(candles, { btc1d, d1 });
    const trade = activeTrades(def.id).find(t => t.symbol === sym);

    if (trade) {
      const pos = { stop: trade.stopLoss, trail: trade.trail ?? undefined, highestHigh: Math.max(trade.highestHigh ?? 0, c.high) };
      trade.highestHigh = pos.highestHigh;
      const out = strat.exit(S, i, pos);
      if (pos.trail != null) trade.trail = pos.trail;
      if (out) { exits.push({ trade, sym }); continue; }
      const t = strat.trail(S, i, pos);
      if (t != null && Number.isFinite(t) && t > trade.stopLoss) trade.stopLoss = t;
      continue;
    }
    // إشارة دخول: بس إذا الشمعة سكّرت قريب (بعد إعادة تشغيل طويلة ما ندخل على إشارة قديمة)
    if (now - (c.t + tfMs) > CODE_FRESH_MS[strat.tf]) continue;
    if (!strat.entry(S, i)) continue;
    const vol = candles.slice(-Math.round(20 * strategies.DAY / tfMs)).reduce((s, x) => s + (x.quoteVolume || 0), 0);
    signals.push({ sym, stop: strat.initialStop(S, i), close: c.close, vol });
  }

  for (const { trade, sym } of exits) {
    const price = await market.price(sym).catch(() => trade.currentPrice);
    closeTrade(trade, 'signal-exit', price);
  }
  // لما الخانات ما تكفي: الأعلى تداولاً آخر 20 يوم أول
  const entered = [];
  for (const s of signals.sort((a, b) => b.vol - a.vol)) {
    let price;
    try { price = await market.price(s.sym); } catch (e) { notes.push(`${s.sym}: ${e.message}`); continue; }
    const slPercent = s.stop != null ? (s.stop / price - 1) * 100 : -99;
    if (slPercent >= 0) { notes.push(`${s.sym}: السعر نزل تحت الوقف قبل الدخول`); continue; }
    const res = await enterTrade(def.id, {
      symbol: s.sym, reason: `إشارة ${strat.nameAr}`, tpPercent: null, slPercent, maxMinutes: null,
      extra: { strategy: strat.id, trail: undefined, highestHigh: price },
    });
    if (res.error) notes.push(`${s.sym}: ${res.error}`); else entered.push(s.sym);
  }
  bot.system.lastRun = now;
  bot.system.lastError = null;
  const parts = [];
  if (entered.length) parts.push(`دخل: ${entered.join('، ')}`);
  if (exits.length) parts.push(`خرج: ${exits.map(x => x.sym).join('، ')}`);
  if (notes.length) parts.push(notes.join(' | '));
  recordDecision(def.id, {
    action: entered.length ? 'BUY' : exits.length ? 'SELL' : 'WAIT',
    symbol: entered[0] || exits[0]?.sym || null,
    reason: parts.join(' · ') || 'ما فيه إشارة على الشمعة المغلقة',
  });
  dirty = true;
  saveDb();
}

async function runRandomBot(round = null) {
  const id = 'random';
  const blocked = blockReason(id);
  if (blocked) { recordDecision(id, { action: 'SKIP', reason: blocked }); return; }
  if (Math.random() >= R().randomEntryProbability) {
    recordDecision(id, { action: 'WAIT', reason: 'القرعة قالت انتظر' });
    return;
  }
  const held = activeTrades(id).map(t => t.symbol);
  const pool = universe.filter(s => !held.includes(s));
  const symbol = pool[Math.floor(Math.random() * pool.length)];
  // نفس الهدف والوقف والمدة اللي حددها آخر كشّاف. القرعة تختار العملة والتوقيت بس
  const plan = state.system.lastPlan || clampPlan({});
  const p = { takeProfitPercent: plan.takeProfitPercent, stopLossPercent: plan.stopLossPercent, maxHoldHours: plan.maxHoldHours };
  recordDecision(id, { action: 'BUY', symbol, reason: 'قرعة', plan: p });
  const res = await enterTrade(id, { symbol, reason: 'قرعة', ...planOpts(p), round });
  if (res.error) state.bots[id].decisions[0].note = res.error;
}

let cycleRunning = false;
async function decisionCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    await ensureHodl();
    // رقم الجولة = بداية ربع الساعة. نفس الرقم لكل العائلات عشان المقارنة
    const round = Math.floor(Date.now() / (R().decisionIntervalMinutes * 60_000)) * R().decisionIntervalMinutes * 60_000;
    const needsAi = BOTS.some(b => (b.kind === 'ai' || b.kind === 'meeting' || b.kind === 'always') && !blockReason(b.id));
    if (needsAi && (DEMO || KEYS.xai || KEYS.openrouter)) await refreshNews();
    let snapshot = [];
    try { snapshot = await market.snapshot(universe); }
    catch (e) { log.err(`لقطة السوق: ${e.message}`); }
    // تذبذب كل عملة (ATR على شموع 4 ساعات) عشان الكشّاف يحط وقف منطقي
    await Promise.all(snapshot.map(async m => {
      try { m.atr4hPct = ind.atrPercent(await market.klines(m.symbol, '4h')); m.atr4hPct = m.atr4hPct != null ? Math.round(m.atr4hPct * 100) / 100 : null; }
      catch { m.atr4hPct = null; }
    }));
    // نفس اللقطة ونفس الأخبار للوكيلين، وبنفس اللحظة
    if (snapshot.length) {
      openFableRound(round, snapshot);   // Fable ياخذها من جهاز المالك، والباقي يشتغل هني
      await Promise.all(BOTS.filter(b => b.kind === 'ai' && !b.remote).map(b => runFamily(b.id, snapshot, round)));
    }
    await runRandomBot(round);
  } catch (e) {
    log.err(`جولة القرار: ${e.message}`);
  } finally {
    cycleRunning = false;
    dirty = true;
  }
}

let cycleTimer = null;
function scheduleCycle() {
  clearTimeout(cycleTimer);
  const ms = R().decisionIntervalMinutes * 60_000;
  const next = Math.ceil((Date.now() + 1000) / ms) * ms; // على رأس الربع ساعة
  state.system.nextDecisionAt = next;
  cycleTimer = setTimeout(async () => {
    await decisionCycle();
    scheduleCycle();
  }, next - Date.now()).unref();
}

// ── الويبهوك: إشارات استراتيجية "الماضي" من TradingView ──────────────────────
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

async function handleStrategySignal(body) {
  const id = 'past-strategy';
  const action = String(body.action || '').toLowerCase();
  let symbol = String(body.symbol || '').toUpperCase().replace(/^BINANCE:/, '').replace(/\.P$/, '');
  if (!symbol.endsWith('USDT')) symbol += 'USDT';
  if (!universe.includes(symbol)) return { status: 400, error: `${symbol} مو ضمن العملات المسموحة` };

  if (action === 'buy') {
    const sl = body.stopLossPercent != null ? -Math.abs(Number(body.stopLossPercent)) : R().strategyStopLossPercent;
    const tp = body.takeProfitPercent != null ? Math.abs(Number(body.takeProfitPercent)) : null;
    const res = await enterTrade(id, { symbol, reason: String(body.reason || 'إشارة شراء'), tpPercent: tp, slPercent: sl });
    recordDecision(id, { action: 'BUY', symbol, reason: body.reason || 'إشارة شراء', note: res.error || null });
    return res.error ? { status: 409, error: res.error } : { status: 200, trade: res.trade.id };
  }
  if (action === 'sell') {
    const open = activeTrades(id).filter(t => t.symbol === symbol);
    if (!open.length) {
      recordDecision(id, { action: 'SELL', symbol, reason: body.reason || 'إشارة بيع', note: 'ما فيه صفقة مفتوحة' });
      return { status: 200, note: 'ما فيه صفقة مفتوحة' };
    }
    const price = await market.price(symbol);
    open.forEach(t => closeTrade(t, 'signal-exit', price));
    recordDecision(id, { action: 'SELL', symbol, reason: body.reason || 'إشارة بيع' });
    return { status: 200, closed: open.length };
  }
  return { status: 400, error: 'action لازم يكون buy أو sell' };
}

// ── اللقطة للوحة ────────────────────────────────────────────────────────────
function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(arr[Math.floor(i * step)]);
  out.push(arr.at(-1));
  return out;
}

function botSnapshot(id) {
  const def = BOT[id];
  const bot = state.bots[id];
  const r = R();
  const equity = equityOf(id);
  const stats = acc.computeStats({ ...bot, equity }, r.startingBalance);
  const active = bot.trades.filter(t => t.status === 'active');
  const closed = bot.trades.filter(t => t.status !== 'active').slice(0, 200);
  return {
    def: { id, name: def.name, kind: def.kind, model: def.model || null, referee: !!def.referee, team: def.team || null, desc: def.desc, family: def.family || null, chair: def.chair || null, source: def.source || null },
    balance: acc.round(bot.balance),
    equity: acc.round(equity),
    stats,
    todayRealized: acc.round(todayRealized(id)),
    trades: [...active, ...closed],
    balanceHistory: downsample(bot.balanceHistory, 300),
    decisions: bot.decisions.slice(0, 40),
    cb: bot.cb,
    blocked: blockReason(id),
    system: bot.system,
  };
}

function clientSnapshot() {
  const bots = Object.fromEntries(BOTS.map(b => [b.id, botSnapshot(b.id)]));
  const ret = id => bots[id].stats.returnPct;
  const leaderboard = BOTS
    .map(b => ({
      id: b.id, name: b.name, referee: !!b.referee,
      returnPct: ret(b.id), maxDrawdown: bots[b.id].stats.maxDrawdown,
      returnToDrawdown: bots[b.id].stats.returnToDrawdown, trades: bots[b.id].stats.closedTrades,
      winRate: bots[b.id].stats.winRate, feesPaid: bots[b.id].stats.feesPaid,
      aiCostUSD: bots[b.id].stats.aiCostUSD, equity: bots[b.id].equity,
      beatsRandom: b.referee ? null : ret(b.id) > ret('random'),
      beatsHodl: b.referee ? null : ret(b.id) > ret('hodl'),
    }))
    .sort((a, b) => b.returnPct - a.returnPct);
  return {
    mode: DEMO ? 'demo' : 'live',
    rules: state.rules,
    competition: state.competition,
    universe,
    news: state.news,
    nextDecisionAt: state.system.nextDecisionAt,
    keys: { xai: !!KEYS.xai, openrouter: !!KEYS.openrouter, webhook: !!KEYS.webhook },
    models: MODELS,
    meetings: Object.fromEntries(BOTS.filter(b => b.kind === 'ai').map(b => [b.id, meetingStats(b.id)])),
    fable: fableSummary(),
    fairComparison: fairComparison(),
    opportunities: state.opportunities.slice(0, 20).map(o => ({
      id: o.id, at: o.at, source: o.source, symbol: o.symbol, scoutConfidence: o.scoutConfidence,
      scoutAction: o.scoutAction, shadow: !!o.shadow, plan: o.plan,
      votes: o.votes, chairModel: o.chairModel, chairRule: o.chairRule, status: o.status,
      pnlUSD: o.pnlUSD, pnlPercent: o.pnlPercent, closeReason: o.closeReason,
    })),
    bots,
    leaderboard,
    serverTime: Date.now(),
  };
}

// ── الخادم ───────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
app.use(express.json({ limit: '100kb' }));

// كلمة سر اللوحة (اختياري لكن مطلوب على أي سيرفر خارجي)
const AUTH_COOKIE = 'gt_auth';
const authToken = KEYS.dashboard
  ? crypto.createHmac('sha256', KEYS.dashboard).update('ghost-trader').digest('hex') : null;

function isAuthed(req) {
  if (!authToken) return true;
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(AUTH_COOKIE + '='));
  if (cookie && safeEqual(cookie.slice(AUTH_COOKIE.length + 1), authToken)) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
    if (safeEqual(pass, KEYS.dashboard)) return true;
  }
  return false;
}

// موصّل MCP لـClaude: محمي بالسر اللي في الرابط، فيمر قبل كلمة سر اللوحة
let mcpRoute = null;
app.all('/mcp/:secret', (req, res) => (mcpRoute ||= createMcpHandler({
  secret: KEYS.mcp, tools: mcpTools(), version: require('./package.json').version, log,
  instructions: 'المِحَك: مسابقة تداول ورقي (بدون فلوس حقيقية). اقرا براحتك. لا تغيّر شي إلا إذا المالك طلب، وأكّد معاه قبل بدء/تصفير المسابقة أو إغلاق صفقة.',
}))(req, res));
// كشّاف Fable على جهاز المالك: السر (MCP_SECRET) في هيدر x-mihak-secret
const fableAuthed = req => !!KEYS.mcp && safeEqual(req.get('x-mihak-secret') || '', KEYS.mcp);
app.get('/api/fable/round', (req, res) => {
  if (!fableAuthed(req)) return res.status(404).end();
  const r = fableRound;
  if (!r) return res.json({ status: 'none', now: Date.now() });
  const out = { status: r.status, roundId: r.id, openedAt: r.openedAt, deadline: r.deadline, now: Date.now() };
  if (r.status === 'waiting') Object.assign(out, { snapshot: r.snapshot, news: r.news, rules: r.rules, held: r.held, allowed: r.allowed, prompt: r.prompt });
  res.json(out);
});
app.post('/api/fable/decision', (req, res) => {
  if (!fableAuthed(req)) return res.status(404).end();
  const out = submitFableDecision(req.body);
  res.status(out.status).json(out.body);
});

// claude.ai يدوّر OAuth هني أول؛ نقول له ما فيه عشان يكمل بدونه
app.all('/.well-known/*', (_req, res) => res.status(404).end());

app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhook/') || req.path === '/api/health') return next();
  if (isAuthed(req)) {
    if (authToken) res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Mihak", charset="UTF-8"');
  res.status(401).send('مطلوب كلمة السر');
});

// الملفات المسموح عرضها فقط (التطبيق القديم كان يعرض كل المجلد، ومنه المفاتيح)
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/health', (_req, res) => res.json({ status: 'ok', mode: DEMO ? 'demo' : 'live', uptime: Math.round(process.uptime()) }));
app.get('/api/state', (_req, res) => res.json(clientSnapshot()));

function resetAllBots() {
  const symbols = new Set(BOTS.flatMap(b => activeTrades(b.id).map(t => t.symbol)));
  state.opportunities.filter(o => o.status === 'open').forEach(o => symbols.add(o.symbol));
  for (const b of BOTS) state.bots[b.id] = freshBot(state.rules);
  state.opportunities = [];
  state.fable = freshFable();
  symbols.forEach(releaseSymbol);
}

// ── الأفعال (تستخدمها اللوحة وموصّل MCP) — كلها ترجع { status, body } ──────
const actions = {
  async setRules(input) {
    if (state.competition.locked)
      return { status: 423, body: { errors: ['القوانين مقفولة لأن المسابقة بدأت. ما تتغير بالنص.'] } };
    const errs = [];
    for (const [k, v] of Object.entries(input || {})) {
      if (!(k in RULE_LIMITS)) continue;
      const [lo, hi] = RULE_LIMITS[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) { errs.push(`${k}: لازم بين ${lo} و ${hi}`); continue; }
      state.rules[k] = v;
    }
    if (state.rules.tradeAmount > state.rules.startingBalance) errs.push('مبلغ الصفقة أكبر من الرصيد');
    if (state.rules.minStopPercent > state.rules.maxStopPercent) errs.push('أقرب وقف لازم يكون أصغر من أبعد وقف');
    if (state.rules.minHoldHours > state.rules.maxHoldHours) errs.push('أقل مدة لازم تكون أصغر من أطول مدة');
    if (errs.length) return { status: 400, body: { errors: errs } };
    scheduleCycle();
    dirty = true;
    await saveDb();
    return { status: 200, body: { success: true, rules: state.rules } };
  },

  // بدء المسابقة الرسمية: يصفّر الكل بنفس اللحظة ويقفل القوانين
  async startCompetition(confirm) {
    if (confirm !== 'START') return { status: 400, body: { error: 'أرسل confirm: START' } };
    resetAllBots();
    state.competition = { startedAt: Date.now(), locked: true };
    state.news = { text: null, at: null, searches: 0, error: null };
    await ensureHodl();
    dirty = true;
    await saveDb();
    log.ok('🏁 بدأت المسابقة الرسمية — القوانين مقفولة');
    return { status: 200, body: { success: true, startedAt: state.competition.startedAt } };
  },

  // إنهاء/إلغاء المسابقة: يفتح القوانين ويصفّر الكل (وضع الإحماء)
  async resetCompetition(confirm) {
    if (confirm !== 'RESET') return { status: 400, body: { error: 'أرسل confirm: RESET' } };
    resetAllBots();
    state.competition = { startedAt: null, locked: false };
    await ensureHodl();
    dirty = true;
    await saveDb();
    return { status: 200, body: { success: true } };
  },

  async closeTrade(botId, tradeId) {
    const bot = state.bots[botId];
    if (!bot) return { status: 404, body: { error: 'المتسابق مو موجود' } };
    if (botId === 'hodl') return { status: 400, body: { error: 'اشترِ واحتفظ ما يبيع' } };
    const t = bot.trades.find(x => x.id === tradeId);
    if (!t) return { status: 404, body: { error: 'الصفقة مو موجودة' } };
    if (t.status !== 'active') return { status: 400, body: { error: 'الصفقة مسكرة' } };
    try {
      const price = await market.price(t.symbol);
      closeTrade(t, 'manual-close', price);
      return { status: 200, body: { success: true } };
    } catch (e) {
      return { status: 503, body: { error: e.message } };
    }
  },

  resumeBot(botId) {
    const bot = state.bots[botId];
    if (!bot) return { status: 404, body: { error: 'المتسابق مو موجود' } };
    bot.cb = { consecutiveLosses: 0, pausedUntil: null };
    dirty = true;
    return { status: 200, body: { success: true } };
  },

  async refreshNews() {
    if (!DEMO && !KEYS.xai && !KEYS.openrouter) return { status: 400, body: { error: 'ما فيه مفتاح للأخبار' } };
    await refreshNews(true);
    dirty = true;
    return { status: 200, body: { success: !state.news.error, error: state.news.error } };
  },
};
const send = (res, out) => res.status(out.status).json(out.body);

app.post('/api/rules', async (req, res) => send(res, await actions.setRules(req.body)));
app.post('/api/competition/start', async (req, res) => send(res, await actions.startCompetition(req.body?.confirm)));
app.post('/api/competition/reset', async (req, res) => send(res, await actions.resetCompetition(req.body?.confirm)));
app.post('/api/bots/:bot/trades/:id/close', async (req, res) => send(res, await actions.closeTrade(req.params.bot, req.params.id)));
app.post('/api/bots/:bot/resume', (req, res) => send(res, actions.resumeBot(req.params.bot)));

// وضع التجربة فقط: تشغيل جولة قرار فوراً
app.post('/api/demo/cycle', async (_req, res) => {
  if (!DEMO) return res.status(404).json({ error: 'متاح في وضع التجربة فقط' });
  await decisionCycle();
  res.json({ success: true });
});

app.post('/api/news/refresh', async (_req, res) => send(res, await actions.refreshNews()));

app.get('/api/export', (_req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="ghost-trader-${dayKey(Date.now())}.json"`);
  res.json({ exportedAt: new Date().toISOString(), ...state });
});

app.post('/api/webhook/strategy', async (req, res) => {
  if (!KEYS.webhook) return res.status(503).json({ error: 'WEBHOOK_SECRET مو مضبوط' });
  if (!safeEqual(req.body?.secret || '', KEYS.webhook)) return res.status(401).json({ error: 'secret غلط' });
  try {
    const out = await handleStrategySignal(req.body);
    dirty = true;
    res.status(out.status).json(out);
  } catch (e) {
    log.err(`webhook: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── أدوات MCP ────────────────────────────────────────────────────────────────
function mcpTools() {
  const botIds = BOTS.map(b => b.id);
  const botArg = { type: 'string', enum: botIds, description: 'رقم المتسابق' };
  const RO = { readOnlyHint: true, openWorldHint: false };
  const limitArg = { type: 'integer', minimum: 1, maximum: 500, description: 'كم واحد (افتراضي 50)' };
  const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const result = out => (out.status >= 400 ? { error: out.body.error || out.body.errors, status: out.status } : out.body);
  const lim = n => Math.min(Math.max(Number(n) || 50, 1), 500);
  const iso = t => (t ? new Date(t).toISOString() : null);

  return [
    { name: 'get_overview', annotations: { title: 'نظرة عامة', ...RO },
      description: "Competition status, leaderboard (return, drawdown, win rate, fees, AI cost, beats random/hodl), keys present, next decision time, news status, Fable rounds (present / missed), the fair comparison on Fable rounds, and each bot's blocked/paused state, last decision and last error.",
      inputSchema: obj(),
      run: () => {
        const snap = clientSnapshot();
        return {
          mode: snap.mode, competition: snap.competition, keys: snap.keys, models: snap.models,
          serverTime: iso(snap.serverTime), nextDecisionAt: iso(snap.nextDecisionAt),
          news: { at: iso(state.news.at), error: state.news.error, searches: state.news.searches },
          fable: snap.fable,
          fairComparison: snap.fairComparison,
          universe: snap.universe,
          leaderboard: snap.leaderboard,
          bots: Object.fromEntries(Object.entries(snap.bots).map(([id, b]) => [id, {
            name: b.def.name, balance: b.balance, equity: b.equity, openTrades: b.trades.filter(t => t.status === 'active').length,
            blocked: b.blocked, paused: b.cb, lastRun: b.system.lastRun, lastError: b.system.lastError, lastDecision: b.decisions[0] || null,
          }])),
        };
      } },

    { name: 'get_bot', annotations: { title: 'تفاصيل متسابق', ...RO },
      description: 'Full detail of one contestant: definition, stats, open and recent closed trades, last 40 decisions with reasons, balance history.',
      inputSchema: obj({ bot_id: botArg }, ['bot_id']),
      run: ({ bot_id }) => (BOT[bot_id] ? botSnapshot(bot_id) : { error: 'المتسابق مو موجود' }) },

    { name: 'get_trades', annotations: { title: 'الصفقات', ...RO },
      description: 'Paper trades, newest first. Filter by bot and status (active / closed / all).',
      inputSchema: obj({ bot_id: botArg, status: { type: 'string', enum: ['active', 'closed', 'all'] }, limit: limitArg }),
      run: ({ bot_id, status = 'all', limit }) => {
        if (bot_id && !BOT[bot_id]) return { error: 'المتسابق مو موجود' };
        let all = (bot_id ? [bot_id] : botIds).flatMap(id => state.bots[id].trades.map(t => ({ bot: id, ...t })));
        if (status === 'active') all = all.filter(t => t.status === 'active');
        if (status === 'closed') all = all.filter(t => t.status !== 'active');
        all.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        return { total: all.length, trades: all.slice(0, lim(limit)) };
      } },

    { name: 'get_opportunities', annotations: { title: 'الفرص', ...RO },
      description: "Every candidate a scout found (including WAIT ones, shadow=true) with its plan, expert votes, both chairs' decisions and hypothetical outcome. Newest first.",
      inputSchema: obj({
        source: { type: 'string', enum: BOTS.filter(b => b.kind === 'ai').map(b => b.id) },
        symbol: { type: 'string', description: 'مثل BTCUSDT' },
        status: { type: 'string', enum: ['open', 'won', 'lost'] },
        limit: limitArg,
      }),
      run: ({ source, symbol, status, limit }) => {
        let list = state.opportunities;
        if (source) list = list.filter(o => o.source === source);
        if (symbol) list = list.filter(o => o.symbol === String(symbol).toUpperCase());
        if (status) list = list.filter(o => o.status === status);
        return { total: list.length, opportunities: list.slice(0, lim(limit)) };
      } },

    { name: 'get_meetings', annotations: { title: 'الاجتماعات: هل تضيف قيمة؟', ...RO },
      description: "Per scout: how often each expert (trend/news/risk) and each chair (model/rule) was right, how the scout's WAITs turned out, and meeting cost. Plus fairComparison: every family scored only on rounds where the Fable scout answered.",
      inputSchema: obj(),
      run: () => ({
        ...Object.fromEntries(BOTS.filter(b => b.kind === 'ai').map(b => [b.id, meetingStats(b.id)])),
        fairComparison: fairComparison(),
      }) },

    { name: 'get_rules', annotations: { title: 'القوانين', ...RO },
      description: 'Current rules, the allowed range of each, and whether they are locked (locked once the official competition starts).',
      inputSchema: obj(),
      run: () => ({ locked: state.competition.locked, rules: state.rules, limits: RULE_LIMITS }) },

    { name: 'get_news', annotations: { title: 'الأخبار', ...RO },
      description: 'The latest news summary the scouts are reading, and when it was fetched.',
      inputSchema: obj(),
      run: () => ({ ...state.news, at: iso(state.news.at) }) },

    { name: 'set_rules', annotations: { title: 'تعديل القوانين', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: 'Change one or more rules (numbers only, each within its range from get_rules). Refused while the competition is locked. Only when the owner asks.',
      inputSchema: obj({ rules: { type: 'object', description: 'مثل {"minConfidence": 60}', additionalProperties: { type: 'number' } } }, ['rules']),
      run: async ({ rules }) => result(await actions.setRules(rules)) },

    { name: 'resume_bot', annotations: { title: 'تشغيل متسابق موقوف', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description: "Clear a contestant's loss-streak pause so it trades again next round.",
      inputSchema: obj({ bot_id: botArg }, ['bot_id']),
      run: ({ bot_id }) => result(actions.resumeBot(bot_id)) },

    { name: 'refresh_news', annotations: { title: 'تحديث الأخبار', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      description: 'Fetch fresh news now (costs a little AI money).',
      inputSchema: obj(),
      run: async () => result(await actions.refreshNews()) },

    { name: 'close_trade', annotations: { title: 'إغلاق صفقة', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description: 'Close one open paper trade at the current price. Confirm with the owner first.',
      inputSchema: obj({ bot_id: botArg, trade_id: { type: 'string' } }, ['bot_id', 'trade_id']),
      run: async ({ bot_id, trade_id }) => result(await actions.closeTrade(bot_id, trade_id)) },

    { name: 'start_competition', annotations: { title: 'بدء المسابقة الرسمية', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description: 'Start the official 8-week competition: wipes every contestant to a fresh balance and locks the rules. Ask the owner first; pass confirm="START".',
      inputSchema: obj({ confirm: { type: 'string', const: 'START' } }, ['confirm']),
      run: async ({ confirm }) => result(await actions.startCompetition(confirm)) },

    { name: 'reset_competition', annotations: { title: 'تصفير المسابقة', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description: 'End/cancel the competition: wipes every contestant and unlocks the rules (back to warm-up). Ask the owner first; pass confirm="RESET".',
      inputSchema: obj({ confirm: { type: 'string', const: 'RESET' } }, ['confirm']),
      run: async ({ confirm }) => result(await actions.resetCompetition(confirm)) },
  ];
}

// ── WebSocket للوحة ──────────────────────────────────────────────────────────
const wss = new WebSocket.Server({
  server,
  verifyClient: ({ req }) => isAuthed(req),
});
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify(clientSnapshot()));
});
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000).unref();

function broadcast() {
  if (!dirty || !wss.clients.size) return;
  const payload = JSON.stringify(clientSnapshot());
  wss.clients.forEach(c => c.readyState === WebSocket.OPEN && c.send(payload));
  dirty = false;
}

// ── التشغيل ──────────────────────────────────────────────────────────────────
async function loadUniverse() {
  const file = JSON.parse(fs.readFileSync(path.join(__dirname, 'halal-coins.json'), 'utf-8'));
  const wanted = file.coins.map(c => `${c.toUpperCase()}USDT`);
  try {
    const tradable = await market.tradableUsdtSymbols();
    universe = wanted.filter(s => tradable.has(s));
    const missing = wanted.filter(s => !tradable.has(s));
    if (missing.length) log.info(`غير متاحة على Binance (استُبعدت): ${missing.join(', ')}`);
  } catch (e) {
    log.err(`قائمة Binance: ${e.message} — نستخدم القائمة كما هي`);
    if (!universe.length) universe = wanted;
  }
  state.system.universe = universe;
  log.ok(`العملات المسموحة: ${universe.length}`);
}

async function main() {
  log.info(`المِحَك (Mihak) — ${DEMO ? 'وضع التجربة (أسعار وهمية)' : 'أسعار Binance الحية (تداول ورقي)'}`);
  loadDb();
  const coins = JSON.parse(fs.readFileSync(path.join(__dirname, 'halal-coins.json'), 'utf-8')).coins;
  market = DEMO ? new MockMarket(log, coins.map(c => `${c}USDT`)) : new LiveMarket(log);
  market.wanted = symbolNeeded;
  market.onPrice(onPrice);
  await loadUniverse();

  if (!DEMO) {
    if (!KEYS.xai && KEYS.openrouter) log.info('أخبار Grok عن طريق OpenRouter');
    if (!KEYS.openrouter) log.warn('OPENROUTER_API_KEY مو موجود — وكلاء "الحين" متوقفين');
    if (!KEYS.webhook) log.warn('WEBHOOK_SECRET مو موجود — "الماضي" ما يقدر يستقبل إشارات');
  }
  if (!KEYS.dashboard) log.warn('DASHBOARD_PASSWORD مو موجود — اللوحة مفتوحة لأي أحد يوصل للرابط');
  log.info(KEYS.mcp ? 'موصّل Claude (MCP) شغّال على /mcp/<MCP_SECRET>' : 'MCP_SECRET مو موجود — موصّل Claude طافي');

  // نرجع نتابع الصفقات المفتوحة
  for (const b of BOTS) activeTrades(b.id).forEach(t => market.subscribe(t.symbol));
  state.opportunities.filter(o => o.status === 'open').forEach(o => market.subscribe(o.symbol));
  market.subscribe('BTCUSDT');

  setInterval(broadcast, 1_000);
  setInterval(checkTimeouts, 3_000);
  setInterval(snapshotEquity, 5 * 60_000);
  setInterval(() => { if (dirty) saveDb(); }, 30_000);
  setInterval(loadUniverse, 6 * 3_600_000);
  setInterval(() => runCodeBots().catch(e => log.err(`الكود: ${e.message}`)), 60_000);  // متسابقين الكود: كل دقيقة نشوف إذا سكّرت شمعة جديدة
  setTimeout(() => runCodeBots().catch(e => log.err(`الكود: ${e.message}`)), 15_000);

  scheduleCycle();
  setTimeout(decisionCycle, 5_000); // أول جولة بعد 5 ثواني
  log.ok(`اللوحة: http://localhost:${PORT}`);
}

async function shutdown(sig) {
  log.info(`${sig} — نحفظ ونطفي`);
  await saveDb();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function start() { server.listen(PORT, main); }
if (require.main === module) start();

module.exports = { start, app, server, _internals: { runCodeBots, openFableRound, submitFableDecision, missFableRound, fairComparison, fableSummary, fableRound: () => fableRound, clampPlan, state: () => state, enterTrade, closeTrade, onPrice, handleStrategySignal, clientSnapshot, decisionCycle, meetingStats, closeOpportunity, setMarket: m => { market = m; }, setUniverse: u => { universe = u; } } };
