// ═══════════════════════════════════════════════════════════════════════════
//  المحاسبة — كل حسابات الربح والرسوم والانزلاق في مكان واحد
//  نفس القوانين تنطبق على كل المتسابقين.
// ═══════════════════════════════════════════════════════════════════════════

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * سعر الدخول الفعلي (شراء بأمر سوق): أعلى من السعر المعروض بمقدار الانزلاق.
 */
function entryFill(price, rules) {
  return price * (1 + rules.slippagePercent / 100);
}

/**
 * سعر الخروج الفعلي.
 *  - take-profit: أمر محدد (limit) يتنفذ على سعر الهدف نفسه، بدون انزلاق.
 *  - أي خروج ثاني (وقف خسارة، انتهاء وقت، إشارة بيع، إغلاق يدوي): أمر سوق،
 *    يتنفذ على السعر الملاحظ ناقص الانزلاق. الوقف ما يتنفذ على سعر الوقف بالضبط
 *    إذا السعر قفز تحته.
 */
function exitFill(reason, observedPrice, trade, rules) {
  if (reason === 'take-profit') return trade.takeProfit;
  return observedPrice * (1 - rules.slippagePercent / 100);
}

/**
 * يفتح مركز شراء (سبوت فقط): المبلغ كامل يدفع رسوم الدخول، والكمية تُحسب بعدها.
 */
function openPosition(amount, price, rules) {
  const fill = entryFill(price, rules);
  const feeIn = amount * rules.feePercent / 100;
  const qty = (amount - feeIn) / fill;
  return { fill, qty, feeIn };
}

/**
 * القيمة الصافية لو بعنا الكمية الحين (بعد رسوم الخروج).
 */
function liquidationValue(qty, exitPrice, rules) {
  const gross = qty * exitPrice;
  const feeOut = gross * rules.feePercent / 100;
  return { net: gross - feeOut, feeOut };
}

/**
 * الربح/الخسارة الصافي لصفقة مغلقة أو مفتوحة (بعد الرسوم من الجهتين).
 */
function tradePnl(trade, exitPrice, rules) {
  const { net, feeOut } = liquidationValue(trade.qty, exitPrice, rules);
  const pnl = net - trade.amount;
  return { pnl, pnlPercent: pnl / trade.amount * 100, feeOut };
}

/**
 * إحصائيات متسابق واحد. نسبة الفوز = عدد الصفقات الرابحة ÷ عدد الصفقات المغلقة
 * (التطبيق القديم كان يحسبها من المبالغ، وهذا غلط).
 */
function computeStats(bot, startingBalance) {
  const closed = bot.trades.filter(t => t.status !== 'active');
  const wins = closed.filter(t => t.pnlUSD > 0);
  const losses = closed.filter(t => t.pnlUSD <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlUSD, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
  const fees = bot.trades.reduce((s, t) => s + (t.feesUSD || 0), 0);

  const equity = bot.equity ?? bot.balance;
  const netPnl = equity - startingBalance;
  const returnPct = netPnl / startingBalance * 100;

  // أكبر تراجع من لقطات رأس المال
  let peak = startingBalance, maxDD = 0;
  for (const { balance } of bot.balanceHistory) {
    if (balance > peak) peak = balance;
    const dd = (peak - balance) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  if (equity > peak) peak = equity;
  const curDD = (peak - equity) / peak * 100;
  if (curDD > maxDD) maxDD = curDD;

  const aiCost = bot.aiCostUSD || 0;

  return {
    equity: round(equity),
    netPnl: round(netPnl),
    returnPct: round(returnPct),
    netAfterAiCost: round(netPnl - aiCost),
    maxDrawdown: round(maxDD),
    returnToDrawdown: maxDD > 0 ? round(returnPct / maxDD) : null,
    closedTrades: closed.length,
    activeTrades: bot.trades.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? round(wins.length / closed.length * 100, 1) : 0,
    totalProfit: round(grossProfit),
    totalLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    avgTrade: closed.length ? round((grossProfit - grossLoss) / closed.length) : 0,
    feesPaid: round(fees),
    aiCostUSD: round(aiCost, 4),
    bestTrade: closed.length ? pick(closed, (a, b) => b.pnlUSD - a.pnlUSD) : null,
    worstTrade: closed.length ? pick(closed, (a, b) => a.pnlUSD - b.pnlUSD) : null,
  };
}

function pick(trades, cmp) {
  const t = [...trades].sort(cmp)[0];
  return { id: t.id, symbol: t.symbol, pnlUSD: t.pnlUSD };
}

module.exports = { round, entryFill, exitFill, openPosition, liquidationValue, tradePnl, computeStats };
