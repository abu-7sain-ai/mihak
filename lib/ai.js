// ═══════════════════════════════════════════════════════════════════════════
//  الذكاء الاصطناعي — وكيل الأخبار (Grok) ووكلاء القرار (Qwen / DeepSeek)
// ═══════════════════════════════════════════════════════════════════════════

const XAI_URL = 'https://api.x.ai/v1/responses';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

async function postJson(url, key, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ── وكيل الأخبار ─────────────────────────────────────────────────────────────
// يبحث في X والويب عن آخر أخبار العملات المسموحة، ويرجع ملخص قصير.
// نفس الملخص يروح للوكيلين الاثنين، حتى تكون المنافسة بينهم عادلة.
async function fetchNewsBrief({ apiKey, model, coins }) {
  const input = `You are a crypto news desk. Using live X and web search, report what matters RIGHT NOW (last 6 hours) for these coins only: ${coins.join(', ')}.

Rules:
- Facts only, each with how many hours ago it happened. No price predictions.
- Include: major news, exchange listings/delistings, hacks, regulatory actions, macro events in the next 24h (rate decisions, CPI), unusual social buzz.
- Max 12 bullet points, most market-moving first. If nothing important happened for a coin, skip it.
- End with one line: "MACRO: <one sentence on overall crypto market mood>".`;

  const res = await postJson(XAI_URL, apiKey, {
    model: model.replace(/^x-ai\//, ''),
    input,
    tools: [{ type: 'web_search' }, { type: 'x_search' }],
  }, 180_000);

  const text = res.output_text
    ?? (res.output || [])
      .filter(o => o.type === 'message')
      .flatMap(o => o.content || [])
      .filter(c => c.type === 'output_text' || c.type === 'text')
      .map(c => c.text).join('\n');

  const searches = (res.output || []).filter(o => /search_call/.test(o.type || '')).length;
  return {
    text: (text || '').trim(),
    searches,
    tokens: res.usage?.total_tokens ?? null,
  };
}

// نفس وكيل الأخبار لكن عن طريق OpenRouter (حساب واحد بدل حسابين).
// البحث في X يتحاسب على عدد التغريدات، فنحصره بحسابات أخبار معروفة وبتاريخ اليوم.
async function fetchNewsBriefOpenRouter({ apiKey, model, coins, xHandles }) {
  const prompt = `You are a crypto news desk. Using live web and X search, report what matters RIGHT NOW (last 6 hours) for these coins only: ${coins.join(', ')}.
Rules:
- Facts only, each with how many hours ago it happened. No price predictions.
- Include: major news, exchange listings/delistings, hacks, regulatory actions, macro events in the next 24h (rate decisions, CPI), unusual social buzz.
- Max 12 bullet points, most market-moving first. Skip coins with nothing important.
- End with one line: "MACRO: <one sentence on overall crypto market mood>".
- Budget: at most 2 X searches and 2 web searches in total. Stop searching once you have enough.`;
  const plugin = { id: 'web', engine: 'native' };
  if (xHandles?.length) plugin.x_search = { allowed_x_handles: xHandles.slice(0, 20), from_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) };
  const res = await postJson(OPENROUTER_URL, apiKey, {
    model, temperature: 0, max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
    plugins: [plugin],
    usage: { include: true },
  }, 180_000);
  return {
    text: (res.choices?.[0]?.message?.content || '').trim(),
    searches: (res.choices?.[0]?.message?.annotations || []).length,
    tokens: res.usage?.total_tokens ?? null,
    costUSD: Number(res.usage?.cost) || 0,
    usage: res.usage?.server_tool_use || res.usage?.cost_details || null,
  };
}

// أخبار المواقع عن طريق Perplexity (رخيص، كل ساعة)
async function fetchWebNews({ apiKey, model, coins }) {
  const prompt = `You are a crypto news desk. Search news websites for what matters RIGHT NOW (last 3 hours) for these coins only: ${coins.join(', ')}.
Rules:
- Facts only, each with how many hours ago it happened and the outlet name. No price predictions.
- Include: major news, exchange listings/delistings, hacks, regulatory actions, ETF flows, macro events in the next 24h (rate decisions, CPI).
- Max 10 bullet points, most market-moving first. Skip coins with nothing important.
- End with one line: "MACRO: <one sentence on overall crypto market mood>".`;
  const res = await postJson(OPENROUTER_URL, apiKey, {
    model, temperature: 0, max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
    usage: { include: true },
  }, 120_000);
  return { text: (res.choices?.[0]?.message?.content || '').trim(), costUSD: Number(res.usage?.cost) || 0 };
}

// نبض تويتر عن طريق Grok (X بس، كل 4 ساعات)
async function fetchXBuzz({ apiKey, model, coins, xHandles }) {
  const prompt = `Search X (Twitter) ONLY — do not use web search. Report the crypto buzz of the last 4 hours relevant to: ${coins.join(', ')}.
Rules:
- Breaking headlines, whale moves, exchange announcements, unusual hype or panic. Each with how many hours ago.
- Max 8 bullet points, most market-moving first. Facts only, no predictions.
- Budget: at most 2 X searches.`;
  const plugin = { id: 'web', engine: 'native', x_search: {} };
  if (xHandles?.length) plugin.x_search = { allowed_x_handles: xHandles.slice(0, 20), from_date: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) };
  const res = await postJson(OPENROUTER_URL, apiKey, {
    model, temperature: 0, max_tokens: 700,
    messages: [{ role: 'user', content: prompt }],
    plugins: [plugin],
    usage: { include: true },
  }, 180_000);
  return { text: (res.choices?.[0]?.message?.content || '').trim(), costUSD: Number(res.usage?.cost) || 0 };
}

// ── وكيل القرار ──────────────────────────────────────────────────────────────
// يسمّي أقوى فرصة كل مرة (حتى لو قراره انتظر)، ويحدد خطتها: الهدف والوقف والمدة.
function decisionPrompt({ news, market, held, rules }) {
  const cost = (2 * rules.feePercent + 2 * rules.slippagePercent).toFixed(2);
  return `You are an autonomous spot crypto trader in a fair competition. Spot only, long only (buy then sell). No leverage, no shorting.

Rules:
- You set your own trade plan: take profit %, stop loss %, max hold hours.
  Limits: stop between ${rules.minStopPercent}% and ${rules.maxStopPercent}% below entry; target at least ${rules.minRewardRisk}x the stop and at most ${rules.maxTakeProfitPercent}%; hold ${rules.minHoldHours}-${rules.maxHoldHours} hours.
  Put the stop where the idea is proven wrong, beyond normal noise (see ATR). A stop tighter than the coin's normal swing gets hit by noise.
- Fees: ${rules.feePercent}% per side + ~${rules.slippagePercent}% slippage = ~${cost}% round trip.
- Allowed coins ONLY (USDT pairs): ${market.map(m => m.symbol).join(', ')}
- Already holding (do not pick): ${held.length ? held.join(', ') : 'none'}

Live market (price | % change 1h / 4h / 24h | 24h volume USD | ATR 4h % = typical 4-hour swing):
${market.map(m => `${m.symbol}: ${m.price} | ${m.chg1h}% / ${m.chg4h}% / ${m.chg24h}% | $${m.volume24hUSD} | ATR ${m.atr4hPct ?? 'n/a'}%`).join('\n')}

Latest news brief:
${news || '(no news available this round)'}

Task:
1. Name the single strongest long candidate right now, ALWAYS, even if you would not buy it.
2. Give its plan.
3. Decide: BUY it now, or WAIT. Waiting is a valid and often correct choice.
Reply with ONLY this JSON, nothing else:
{"action":"BUY" or "WAIT","symbol":"XXXUSDT","takeProfitPercent":number,"stopLossPercent":number,"maxHoldHours":number,"confidence":0-100,"reason":"max 15 words, written in Arabic"}
confidence = how confident you are that BUYING this candidate now would hit the target before the stop.`;
}

function parseDecision(text, allowed) {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in reply: ${(text || '').slice(0, 120)}`);
  const d = JSON.parse(m[0]);
  const action = String(d.action || '').toUpperCase();
  if (action !== 'BUY' && action !== 'WAIT') throw new Error(`bad action ${d.action}`);
  let symbol = d.symbol ? String(d.symbol).toUpperCase() : null;
  if (symbol && !symbol.endsWith('USDT')) symbol += 'USDT';
  if (action === 'BUY' && !allowed.includes(symbol)) throw new Error(`symbol not allowed: ${symbol}`);
  if (symbol && !allowed.includes(symbol)) symbol = null; // مرشح انتظار برا القائمة: نتجاهله
  return {
    action,
    symbol,
    plan: { takeProfitPercent: d.takeProfitPercent, stopLossPercent: d.stopLossPercent, maxHoldHours: d.maxHoldHours },
    confidence: Math.max(0, Math.min(100, Number(d.confidence) || 0)),
    reason: String(d.reason || '').slice(0, 200),
  };
}

// بعض الموديلات (مثل Qwen Max) "تفكر" قبل ما ترد، والتفكير ياكل من حد الكلمات.
// لو الحد صغير، يخلص بالتفكير ويرجع الرد فاضي. فنعطيها مجال، ونطلب تفكير قليل.
async function chat({ apiKey, model, prompt, maxTokens = 4000 }) {
  const res = await postJson(OPENROUTER_URL, apiKey, {
    model,
    temperature: 0,
    max_tokens: maxTokens,
    reasoning: { effort: 'low', exclude: true },
    messages: [{ role: 'user', content: prompt }],
    usage: { include: true },
  }, 180_000);
  const msg = res.choices?.[0]?.message || {};
  if (!msg.content && res.choices?.[0]?.finish_reason === 'length') throw new Error('الموديل خلّص حد الكلمات قبل ما يرد');
  return {
    text: msg.content || '',
    costUSD: Number(res.usage?.cost) || 0,
    modelUsed: res.model || model,
  };
}

async function decide({ apiKey, model, prompt, allowed }) {
  const r = await chat({ apiKey, model, prompt });
  return { ...parseDecision(r.text, allowed), raw: r.text.slice(0, 500), costUSD: r.costUSD, modelUsed: r.modelUsed };
}

// ── الاجتماع ─────────────────────────────────────────────────────────────────
// كل خبير ياخذ بس المعلومة اللي تخصه، ويرد بسطر JSON واحد قصير.
const VOTE_FORMAT = `Reply with ONLY this JSON, nothing else:
{"vote":"ENTER" or "SKIP","confidence":0-100,"reason":"max 8 words, written in Arabic"}`;

const planText = p => `target +${p.takeProfitPercent}%, stop ${p.stopLossPercent}%, max hold ${p.maxHoldHours}h`;

function memberPrompts({ symbol, rules, plan, trend, news, risk }) {
  const header = `Trade under review: BUY ${symbol} (spot, long only) right now. Plan: ${planText(plan)}. Round-trip costs ~${(2 * rules.feePercent + 2 * rules.slippagePercent).toFixed(2)}%.`;
  return {
    trend: `${header}
You are the TREND expert. Judge ONLY the technical picture below (computed from closed candles). vsEmaX = % price is above(+)/below(-) that EMA. bollingerPos 0=lower band, 1=upper band.
4h: ${JSON.stringify(trend.h4)}
1d: ${JSON.stringify(trend.d1)}
${VOTE_FORMAT}`,
    news: `${header}
You are the NEWS expert. Judge ONLY whether recent news makes this trade dangerous or supported. No news about the coin is a neutral factor.
News brief:
${news || '(no news available)'}
${VOTE_FORMAT}`,
    risk: `${header}
You are the RISK & TIMING expert. Judge ONLY whether conditions are too risky for this trade right now: volatility vs the stop distance (is the stop beyond normal noise?), whether the target is realistic within the hold time, overextension, overall market mood, time of day.
${JSON.stringify(risk)}
${VOTE_FORMAT}`,
  };
}

function chairPrompt({ symbol, plan, scoutReason, scoutConfidence, votes }) {
  const lines = Object.entries(votes)
    .map(([role, v]) => `${role}: ${v.vote} (confidence ${v.confidence}) — ${v.reason}`).join('\n');
  return `You chair a trading meeting about buying ${symbol} now. Plan: ${planText(plan)}. Scout's view (confidence ${scoutConfidence}): "${scoutReason}".
Your experts voted:
${lines}
Decide whether to ENTER. Weigh how strong each reason is, not just the count.
Reply with ONLY this JSON, nothing else:
{"decision":"ENTER" or "SKIP","confidence":0-100,"reason":"max 8 words, written in Arabic"}`;
}

function parseVote(text, key = 'vote') {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON: ${(text || '').slice(0, 80)}`);
  const d = JSON.parse(m[0]);
  const v = String(d[key] || '').toUpperCase();
  if (v !== 'ENTER' && v !== 'SKIP') throw new Error(`bad ${key}: ${d[key]}`);
  return {
    vote: v,
    confidence: Math.max(0, Math.min(100, Number(d.confidence) || 0)),
    reason: String(d.reason || '').split(/\s+/).slice(0, 12).join(' '),
  };
}

async function mockVote() {
  const enter = Math.random() < 0.55;
  return { vote: enter ? 'ENTER' : 'SKIP', confidence: Math.round(40 + Math.random() * 55), reason: enter ? 'وهمي: يدعم الدخول' : 'وهمي: سبب للرفض', costUSD: 0 };
}

// ── وضع التجربة: قرارات وهمية بدون مفاتيح ─────────────────────────────────────
async function mockWeb(coins) {
  return { text: `- (وضع التجربة) أخبار مواقع وهمية لـ ${coins.length} عملة.\nMACRO: mock.`, costUSD: 0 };
}
async function mockX() {
  return { text: '- (وضع التجربة) نبض تويتر وهمي.', costUSD: 0 };
}
async function mockNews(coins) {
  return { text: `- (وضع التجربة) لا أخبار حقيقية.\nMACRO: mock mode for ${coins.length} coins.`, searches: 0, tokens: 0 };
}
async function mockDecide({ allowed }) {
  const buy = Math.random() < Number(process.env.MOCK_BUY_PROB ?? 0.5);
  const symbol = allowed[Math.floor(Math.random() * allowed.length)];
  return {
    action: buy ? 'BUY' : 'WAIT', symbol,
    plan: { takeProfitPercent: +(1 + Math.random() * 6).toFixed(1), stopLossPercent: -(0.5 + Math.random() * 4).toFixed(1), maxHoldHours: Math.round(1 + Math.random() * 30) },
    confidence: Math.round(40 + Math.random() * 50),
    reason: buy ? 'قرار وهمي للتجربة' : 'انتظار وهمي للتجربة',
    raw: '', costUSD: 0, modelUsed: 'mock',
  };
}

module.exports = {
  fetchNewsBrief, fetchNewsBriefOpenRouter, fetchWebNews, fetchXBuzz, decisionPrompt, parseDecision, decide, chat,
  memberPrompts, chairPrompt, parseVote,
  mockNews, mockWeb, mockX, mockDecide, mockVote,
};
