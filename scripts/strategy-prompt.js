// الطلب الموحّد للنماذج الأربعة (نفس النص بالحرف للكل). ما فيه بيانات ولا نتائج اختبار.
const { LIMITS } = require('../lib/strategy-spec');

const COINS = ['BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'TRX', 'BCH', 'ADA', 'LINK', 'XLM', 'LTC', 'HBAR', 'AVAX', 'SUI', 'DOT', 'SEI'];
const r = a => `${a[0]}–${a[1]}`;

function buildPrompt(rules) {
  const dayLoss = Math.round(rules.startingBalance * rules.dailyLossLimitPercent / 100);
  return `You are designing ONE original, rule-based crypto trading strategy for a paper-trading competition called Mihak.
It will be frozen exactly as you write it and traded automatically by a server for weeks. Nobody will tune it afterwards.

MARKET AND RULES (fixed)
- Spot only, long only (buy, then sell). No leverage, no shorting.
- Universe: only these 16 Binance USDT pairs: ${COINS.map(c => c + 'USDT').join(', ')}.
- Timeframe: 4-hour candles. Everything is evaluated on CLOSED candles only; a signal on a candle close is filled at the next price. No repainting, no future data.
- Every trade is a fixed $${rules.tradeAmount}. Costs: ${rules.feePercent}% fee + ${rules.slippagePercent}% slippage per side (about ${(2 * (rules.feePercent + rules.slippagePercent)).toFixed(1)}% per round trip).
- Account: $${rules.startingBalance}, at most ${rules.maxConcurrentTrades} open trades at once (one per coin). Trading stops for the day after a $${dayLoss} realized loss, and pauses ${rules.cooldownHours} hours after ${rules.consecutiveLossLimit} losses in a row.
- You get NO backtest and NO data. Do not curve-fit: use simple, robust logic and sensible round-number parameters that should work across these coins and in bull, bear and sideways markets.
- Aim for at least 60 trades per year in total across the 16 coins.

WHAT THE ENGINE CAN RUN (stay strictly inside this; anything else is rejected)
The strategy is a JSON object, not code:
{
  "name": "short English name (max 60 chars)",
  "timeframe": "4h",
  "entry": [ condition, ... ],          // ${r(LIMITS.entry)} conditions; ALL must be true on a closed 4h candle
  "exit": {
    "stopAtr": number,                  // required. Initial stop = entry close − stopAtr × ATR(14), allowed ${r(LIMITS.stopAtr)}; the stop is then kept within ${LIMITS.stopPct[0]}%–${LIMITS.stopPct[1]}% below the price. Active inside the candle.
    "trailAtr": number | null,          // optional trailing stop = highest high since entry − trailAtr × ATR(14), allowed ${r(LIMITS.trailAtr)}. Only moves up. Active inside the candle.
    "conditions": [ condition, ... ],   // optional, ${r(LIMITS.exitConditions)} conditions; ANY true on a closed candle = sell at the next price
    "maxHoldBars": integer | null       // optional time exit, in 4h candles, allowed ${r(LIMITS.maxHoldBars)}
  }
}
condition = { "left": operand, "op": ">" | "<" | "crossAbove" | "crossBelow", "right": operand, "mult": number (optional) }
          or { "filter": "btcUp" }     // true when BTC's last daily close is above its 200-day SMA (fixed)
operand   = a number, or { "ind": name, "len": int, "k": number, "ago": int }
  "ago" (optional, ${r(LIMITS.ago)}) = the value that many candles before the current one.
  "mult" (optional, ${r(LIMITS.mult)}) multiplies the RIGHT side, e.g. volume > volSma × 1.5. Only when the right side is an indicator.
  crossAbove = left was <= right on the previous candle and is > right now (crossBelow is the opposite).

Indicators ("ind"):
- close, open, high, low                  : this candle's prices
- ema, sma            (len ${r(LIMITS.len)})       : moving averages of close
- donchianHigh, donchianLow (len)         : highest high / lowest low of the previous len candles (current candle excluded)
- bbUpper, bbLower (len, k ${r(LIMITS.k)}), bbMid (len) : Bollinger bands of close (bbMid = sma)
- rsi                 (len)               : Wilder RSI, 0–100
- atrPct                                  : ATR(14) as a % of close
- macdLine, macdSignal, macdHist          : MACD 12/26/9 (fixed)
- volume, volSma (len)                    : traded volume in USD, and its simple average

What can be compared:
- price-like (close, open, high, low, ema, sma, donchian*, bb*) only with other price-like indicators, never with a fixed number (prices differ per coin);
- rsi with a number 0–100 or another rsi; atrPct with a number 0–50 or another atrPct;
- macdLine / macdSignal / macdHist with 0 or with each other; volume / volSma with each other.

PARAMETER LIMIT: at most ${LIMITS.params} numeric parameters. Every number you write counts (len, k, ago, mult, thresholds, stopAtr, trailAtr, maxHoldBars); the same value used in the same role counts once (an EMA of len 200 used twice = 1). Fixed things do not count: ATR length 14, MACD 12/26/9, the btcUp filter, and comparing MACD with 0.

REPLY IN EXACTLY THIS FORMAT, NOTHING ELSE:
### IDEA
(exactly 5 short lines, in Arabic: what edge it exploits and why it should keep working)
### SPEC
\`\`\`json
(the JSON object)
\`\`\`
### LOSES
(1–3 short lines, in Arabic: which market conditions make it lose money)`;
}

function retryPrompt(errors) {
  return `Your JSON failed validation with these errors:
${errors.map(e => '- ' + e).join('\n')}

Fix only what is needed to make it valid, and reply again in exactly the same format (### IDEA, ### SPEC, ### LOSES).`;
}

// يقرأ الرد: الفكرة، المواصفات (JSON)، ومتى يخسر
function parseAnswer(text) {
  const t = String(text || '');
  const section = name => {
    const m = t.match(new RegExp(`###\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n###\\s*(IDEA|SPEC|LOSES)\\b|$)`, 'i'));
    return m ? m[1].trim() : '';
  };
  const specText = section('SPEC');
  const fenced = specText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : (specText.match(/\{[\s\S]*\}/) || [''])[0];
  let spec = null, parseError = null;
  try { spec = JSON.parse(raw); } catch (e) { parseError = `SPEC is not valid JSON: ${e.message}`; }
  return { idea: section('IDEA'), loses: section('LOSES'), spec, parseError };
}

module.exports = { buildPrompt, retryPrompt, parseAnswer, COINS };
