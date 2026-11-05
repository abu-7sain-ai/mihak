// ═══════════════════════════════════════════════════════════════════════════
//  «وضع المشاهدة» — صفحة عامة للقراءة بس (/view) وبياناتها (/api/public/overview)
//  كل حقل يطلع لازم يكون مذكور هني بالاسم (قائمة مسموحة، مو قائمة ممنوعة):
//  ما يطلع أبداً: حالة المفاتيح، إعدادات الموديلات، MCP / الويبهوك / Fable،
//  أخطاء النظام، تكلفة واستهلاك الموديلات بالقرار، أو أي شي من البيئة.
// ═══════════════════════════════════════════════════════════════════════════
const pickKeys = (o, keys) => {
  if (!o || typeof o !== 'object') return o ?? null;
  const out = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};

const DEF_KEYS = ['id', 'name', 'kind', 'referee', 'team', 'desc', 'family', 'chair'];
const TRADE_KEYS = ['id', 'bot', 'symbol', 'amount', 'qty', 'marketPriceAtEntry', 'entryPrice', 'takeProfit', 'stopLoss', 'tpPercent',
  'slPercent', 'maxTimeMs', 'status', 'startTime', 'currentPrice', 'pnlUSD', 'pnlPercent', 'feesUSD', 'closePrice', 'closeTime',
  'closeReason', 'confidence', 'signalReason', 'round', 'strategy', 'sub', 'trail', 'highestHigh', 'priceHistory'];
const DECISION_KEYS = ['at', 'action', 'symbol', 'confidence', 'round', 'shadow'];
const PLAN_KEYS = ['takeProfitPercent', 'stopLossPercent', 'maxHoldHours', 'adjusted'];
const STAT_KEYS = ['equity', 'netPnl', 'returnPct', 'netAfterAiCost', 'maxDrawdown', 'returnToDrawdown', 'closedTrades', 'activeTrades',
  'wins', 'losses', 'winRate', 'winRatePct', 'totalProfit', 'totalLoss', 'profitFactor', 'avgTrade', 'feesPaid', 'aiCostUSD'];
const FUNDING_SKIP_KEYS = ['at', 'coin', 'rate8h', 'source', 'readFrom', 'reason'];
const LEADERBOARD_KEYS = ['id', 'name', 'referee', 'returnPct', 'maxDrawdown', 'returnToDrawdown', 'trades', 'winRate', 'feesPaid',
  'wins', 'losses', 'winRatePct', 'aiCostUSD', 'equity', 'beatsRandom', 'beatsHodl'];
const OPPORTUNITY_KEYS = ['id', 'at', 'source', 'symbol', 'scoutConfidence', 'scoutAction', 'shadow', 'status', 'pnlUSD', 'pnlPercent', 'closeReason'];
// نصوص حرة (أسباب القرارات والأخبار): نشيل أي شي يشبه مفتاح أو توكن أو رابط خاص، احتياط
const SECRETISH = [
  /sk-[A-Za-z0-9_-]{10,}/g,                       // مفاتيح OpenRouter / OpenAI
  /xai-[A-Za-z0-9_-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{10,}/g,                  // توكنات GitHub
  /\b\d{6,12}:[A-Za-z0-9_-]{25,}\b/g,             // توكنات بوتات تيليجرام
  /https?:\/\/\S*(?:\/mcp\/|api[_-]?key=|token=|secret=|railway\.(?:app|com))\S*/gi,
  /\/mcp\/[A-Za-z0-9_-]{6,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{10,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,                      // أي سلسلة طويلة عشوائية
];
const redact = s => (typeof s === 'string' ? SECRETISH.reduce((x, re) => x.replace(re, '[…]'), s) : s ?? null);

const voteOf = x => (x ? { vote: x.vote ?? x.decision ?? null, decision: x.decision ?? null, confidence: x.confidence ?? null, reason: redact(x.reason) } : null);
const votesOf = v => (v && typeof v === 'object')
  ? Object.fromEntries(Object.entries(v).map(([role, x]) => [role, voteOf(x)])) : null;
const tradeOf = t => ({ ...pickKeys(t, TRADE_KEYS), signalReason: redact(t.signalReason) });
const decisionOf = d => ({
  ...pickKeys(d, DECISION_KEYS),
  reason: redact(d.reason), note: redact(d.note),
  ...(d.plan ? { plan: pickKeys(d.plan, PLAN_KEYS) } : {}),
  ...(d.votes ? { votes: votesOf(d.votes) } : {}),
});
const statsOf = s => ({
  ...pickKeys(s, STAT_KEYS),
  bestTrade: s?.bestTrade ? pickKeys(s.bestTrade, ['id', 'symbol', 'pnlUSD']) : null,
  worstTrade: s?.worstTrade ? pickKeys(s.worstTrade, ['id', 'symbol', 'pnlUSD']) : null,
});

function botOf(b) {
  return {
    def: pickKeys(b.def, DEF_KEYS),
    balance: b.balance, equity: b.equity, stats: statsOf(b.stats),
    wins: b.wins, losses: b.losses, winRatePct: b.winRatePct, todayRealized: b.todayRealized,
    trades: (b.trades || []).map(tradeOf),
    balanceHistory: b.balanceHistory,
    decisions: (b.decisions || []).map(decisionOf),
    cb: pickKeys(b.cb, ['consecutiveLosses', 'pausedUntil']),
    joinedAt: b.joinedAt ?? null, hodlSinceJoinPct: b.hodlSinceJoinPct ?? null,
    ...(b.fundingSkips ? { fundingSkips: b.fundingSkips.map(x => ({ ...pickKeys(x, FUNDING_SKIP_KEYS), reason: redact(x.reason) })), fundingSource: b.fundingSource ?? null } : {}),
    blocked: redact(b.blocked ?? null),
    system: { lastRun: b.system?.lastRun ?? null },   // بدون lastError ولا الملاحظات الداخلية
  };
}

function meetingsOf(m) {
  if (!m || typeof m !== 'object') return {};
  // نسخة كاملة بدون التكلفة (حقل costUSD ما يطلع للعامة)
  return Object.fromEntries(Object.entries(m).map(([id, s]) => {
    const c = JSON.parse(JSON.stringify(s ?? null));
    if (c && typeof c === 'object') delete c.costUSD;
    return [id, c];
  }));
}

// snap = clientSnapshot() — نطلع منه بس المسموح. ruleKeys = أسماء قوانين التداول (أرقام) من السيرفر
function publicSnapshot(snap, ruleKeys = []) {
  const part = p => (p ? { text: redact(p.text), at: p.at ?? null } : null);
  return {
    view: true,
    mode: snap.mode,
    competition: pickKeys(snap.competition, ['startedAt', 'locked']),
    rules: pickKeys(snap.rules, [...ruleKeys, 'aiPaused', 'aiOnlyInBull']),
    universe: snap.universe,
    nextDecisionAt: snap.nextDecisionAt,
    aiPaused: snap.aiPaused,
    ai: pickKeys(snap.ai, ['active', 'mode', 'reason']),
    aiPauses: (snap.aiPauses || []).map(p => pickKeys(p, ['start', 'end', 'mode', 'reason'])),
    regime: snap.regime,
    maestro: snap.maestro,
    marketPeriods: snap.marketPeriods,
    news: { web: part(snap.news?.web), x: part(snap.news?.x) },
    meetings: meetingsOf(snap.meetings),
    opportunities: (snap.opportunities || []).map(o => ({
      ...pickKeys(o, OPPORTUNITY_KEYS),
      ...(o.plan ? { plan: pickKeys(o.plan, PLAN_KEYS) } : {}),
      ...(o.votes ? { votes: votesOf(o.votes) } : {}),
      chairModel: o.chairModel ? pickKeys(o.chairModel, ['decision', 'confidence']) : null,
      chairRule: o.chairRule ? pickKeys(o.chairRule, ['decision', 'confidence']) : null,
    })),
    bots: Object.fromEntries(Object.entries(snap.bots).map(([id, b]) => [id, botOf(b)])),
    leaderboard: snap.leaderboard.map(r => pickKeys(r, LEADERBOARD_KEYS)),
    keys: {},          // اللوحة تتوقعها؛ فاضية دايماً هني
    serverTime: snap.serverTime,
  };
}

// حد بسيط للطلبات لكل IP (نافذة ثابتة)
function rateLimiter({ limit = 60, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
    const t = now();
    let h = hits.get(ip);
    if (!h || t - h.start >= windowMs) { h = { start: t, n: 0 }; hits.set(ip, h); }
    h.n++;
    if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    if (h.n > limit) {
      res.setHeader('Retry-After', String(Math.ceil((h.start + windowMs - t) / 1000)));
      return res.status(429).json({ error: 'طلبات كثيرة، جرّب بعد شوي' });
    }
    next();
  };
}

module.exports = { publicSnapshot, rateLimiter, pickKeys, redact };
