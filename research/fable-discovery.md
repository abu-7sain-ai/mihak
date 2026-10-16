# Fable discovery — research log

Workspace: this folder only. Data: 16 coins, 4h + 1d, 2021-01-01 → 2024-12-31. Backtest: `engine/backtest.js` (Mihak live rules: $100/trade, 0.15%/side, 10 slots, $1,000, $50 daily loss stop, 6 h pause after 4 losses). Entry at the next open after the signal.

LIVE = one Mihak account under the live rules (the real test). PER-COIN = each coin alone, summed (breadth).
Columns: return % | trades | max DD % | profit factor. "coins+" = coins profitable on their own out of 16.

Ideas used: 10 of 10. No breakout / Donchian / new-high entries anywhere.

---

## Idea 01 — RSI dip inside a daily uptrend (`ideas/01-rsi-dip-daily-trend.js`)
- Hypothesis: in a daily uptrend (daily close > daily SMA50) short 4h oversold dips (RSI14 < 30) recover.
- Rules: tf 4h, ctx d1. Entry: RSI14 < 30 and last closed daily close > daily SMA50. Exit: RSI14 > 55 or 30 bars. Stop 6%.
- Params (6): 50, 14, 30, 55, 30, 6.
- LIVE: research −38.6% | 323 | 43.3% | 0.67 — 2021 −3.0% | 2022 −17.3% | 2023 +0.4% | 2024 −25.9%. coins+ 6/16.
- Verdict: FAIL. Oversold on 4h keeps getting more oversold; the 6% stop is hit far too often (win rate 36%).

## Idea 02 — Bollinger lower-band dip above the 4h EMA200 (`ideas/02-bollinger-dip-ema200.js`)
- Hypothesis: a close below SMA20 − 2σ while above the EMA200 is a washout that reverts to the middle band.
- Rules: tf 4h. Entry: close > EMA200 and close < SMA20 − 2·stdev20. Exit: close > SMA20 or 24 bars. Stop 7%.
- Params (5): 20, 2, 200, 7, 24.
- LIVE: research +9.6% | 795 | 25.5% | 1.05 — 2021 +5.2% | 2022 −20.1% | 2023 +23.2% | 2024 +2.9%. coins+ 8/16.
- Verdict: FAIL. Roughly break-even after costs; only 2023 works. Too many small trades eaten by fees.

## Idea 03 — Weekly cross-coin momentum ranking, BTC filter (`ideas/03-weekly-momentum-rank.js`)
- Hypothesis: the strongest 30-day performers keep leading the next week while BTC is above its daily SMA50.
- Rules: tf 1d, rank, hold 4, rebalance Sunday. Score = 30-day return (must be > 0, BTC close > SMA50 else ineligible). Stop 10% from entry.
- Params (4): 30, 50, 4, 10.
- LIVE: research +95.7% | 202 | 19.1% | 1.79 — 2021 +41.4% | 2022 −10.1% | 2023 +54.2% | 2024 +11.3%. coins+ 11/16.
- Verdict: good but concentrated — SOL is 57% of the per-coin profit; 2024 drawdown 28%. Kept as runner-up.

## Idea 04 — EMA20 reclaim inside an aligned 4h trend (`ideas/04-ema20-reclaim-trend.js`)
- Hypothesis: a pullback below the 20 EMA that closes back above it, while coin EMA50 > EMA200 and BTC is above its 4h EMA200, resumes the trend. (Cross of an average, not a breakout of a prior high.)
- Rules: tf 4h, ctx btc4h. Entry: BTC close > BTC EMA200(4h); coin EMA50 > EMA200; prev close < EMA20 and close > EMA20. Exit: close < EMA50. Stop 8%.
- Params (4): 20, 50, 200, 8.
- LIVE: research +144.4% | 1489 | 23.8% | 1.53 — 2021 +97.6% | 2022 −15.8% | 2023 +28.9% | 2024 +17.0%. coins+ 15/16, top coin SOL 22%.
- Verdict: strong and broad (15/16 coins, top coin only 22%). Weak spot: 2022 bear-market rallies.

## Idea 05 — Daily EMA20 cross in an EMA20 > EMA50 trend (`ideas/05-daily-ema-trend.js`)
- Hypothesis: slow daily trend-following with few trades keeps fee drag low and catches the big legs.
- Rules: tf 1d. Entry: EMA20 > EMA50, RSI14 > 50, close crosses above EMA20. Exit: close < EMA50. Stop 10%.
- Params (5): 20, 50, 14, 50, 10.
- LIVE: research +112.5% | 240 | 53.9% | 1.87 — 2021 +18.5% | 2022 −13.1% | 2023 +52.4% | 2024 +26.9%. coins+ 9/16, SOL 40%.
- Verdict: FAIL on risk — 54% max drawdown (42% in 2021 alone); only 8% win rate in 2022. Too slow to exit on the daily chart.

## Idea 06 — Weekly ranking by risk-adjusted momentum (`ideas/06-weekly-riskadj-momentum.js`)
- Hypothesis: 30-day return ÷ 30-day daily stdev spreads the picks beyond the single hottest coin (variant of 03).
- Rules: as 03 but score = return / stdev of daily returns (30). Hold 4, stop 10%.
- Params (4): 30, 50, 4, 10.
- LIVE: research +77.9% | 206 | 16.1% | 1.66 — 2021 +22.5% | 2022 −5.8% | 2023 +52.0% | 2024 +9.6%. coins+ 10/16, SOL 42%.
- Verdict: lower drawdown than 03 but lower return and still concentrated (SOL 42%, XRP = 104% of 2024). Not better than 03/04.

## Idea 07 — EMA20 reclaim with a stricter BTC regime (`ideas/07-ema20-reclaim-strict-btc.js`)  ← FINAL PICK
- Hypothesis: idea 04's 2022 losses came from bear rallies where BTC briefly popped above its 4h EMA200; also requiring BTC EMA50 > EMA200 (4h golden cross) filters them.
- Rules: tf 4h, ctx btc4h. Entry: BTC close > BTC EMA200 and BTC EMA50 > BTC EMA200 (4h); coin EMA50 > EMA200; prev close < EMA20 and close > EMA20. Exit: close < EMA50. Stop 8% below the signal close. No trail, no max hold.
- Params (4): 20, 50, 200, 8.
- LIVE: research +155.8% | 1437 | 20.5% | 1.60 — 2021 +101.0% | 2022 −9.9% | 2023 +30.5% | 2024 +25.6%. coins+ 16/16, top coin SOL 22%.
- Per-coin P&L (research): BTC +10, ETH +16, XRP +129, BNB +128, SOL +479, TRX +154, BCH +14, ADA +158, LINK +36, XLM +19, LTC +10, HBAR +374, AVAX +327, SUI +37, DOT +134, SEI +147 — every coin positive.
- Verdict: best. Positive in 3 of 4 years, the losing year is the smallest loss of the trend ideas, every coin profitable on its own, no single coin above 22% of the profit, lowest research drawdown of the trend family.

## Idea 08 — BTC-led catch-up (`ideas/08-btc-led-catchup.js`)
- Hypothesis: alts lag BTC; after a BTC 4h candle up > 2% buy the alts that rose less than BTC and hold 6 candles.
- Rules: tf 4h, ctx btc4h. Entry: BTC close > EMA200(4h), BTC candle return > 2%, coin candle return < BTC's. Exit: 6 bars. Stop 5%.
- Params (4): 2, 200, 6, 5.
- LIVE: research +68.6% | 1404 | 12.8% | 1.33 — 2021 +64.3% | 2022 +3.6% | 2023 −0.2% | 2024 −0.9%. coins+ 14/16.
- Verdict: FAIL on consistency — almost all the profit is 2021; flat in 2023 and 2024 (the edge faded).

## Idea 09 — Idea 07 + 8% trailing stop below the highest close (`ideas/09-ema20-reclaim-trail.js`)
- Hypothesis: trailing the stop hands back less open profit in chop.
- Rules: as 07 plus trail = highest close since entry × 0.92.
- Params (4): 20, 50, 200, 8.
- LIVE: research +88.5% | 1675 | 25.4% | 1.27 — 2021 +61.2% | 2022 −11.2% | 2023 +22.3% | 2024 −13.2%. coins+ 12/16.
- Verdict: FAIL — the trail cuts the winners that make the strategy work; 2024 turns negative.

## Idea 10 — Idea 07 + the coin's own daily SMA50 filter (`ideas/10-ema20-reclaim-daily-filter.js`)
- Hypothesis: skipping coins in a daily downtrend removes more 2022 losers.
- Rules: as 07 plus last closed daily close > daily SMA50.
- Params (5): 20, 50, 200, 50, 8.
- LIVE: research +90.5% | 1352 | 30.7% | 1.34 — 2021 +42.0% | 2022 −11.2% | 2023 +38.7% | 2024 +6.4%. coins+ 11/16.
- Verdict: FAIL — the extra filter removes good early-trend entries, 2022 is not improved, drawdown is higher.

---

## Choice (research-period results only)

Idea 07. Reasons, in order of weight:
1. Breadth: 16/16 coins profitable on their own; the top coin (SOL) is only 22% of the profit — idea 03/05/06 depend on SOL for 40–57%.
2. Consistency: positive in 2021, 2023 and 2024; the only losing year (2022, the bear market) is −9.9%, the smallest loss among the trend ideas, with the fewest trades (the BTC filter kept it mostly out).
3. Risk: research max drawdown 20.5% with PF 1.60 — the lowest drawdown among the ideas that made > 100%.
4. Simplicity: 4 round parameters (20 / 50 / 200 EMA, 8% stop), one timeframe plus BTC on the same timeframe, no trail, no time exit, nothing fitted.
Known weaknesses: low win rate (26%) — many small stop-outs paid for by a minority of long trend rides; 2024 drawdown 32%; ~40% of signals are skipped live because the 10 slots are full (the harness takes the highest-volume coins first).

Copied unchanged to `final/strategy.js` with `id: 'fable-discovery'`, `nameAr: 'اكتشاف Fable'`. Verified: identical results.

---

## Final pick

**الفكرة (5 أسطر):**
1. نشتغل على شموع 4 ساعات، شراء فقط (سبوت).
2. السوق لازم يكون صاعد: بيتكوين فوق متوسطه المتحرك 200 ومتوسطه 50 فوق 200 على فريم 4 ساعات.
3. العملة نفسها في اتجاه صاعد: متوسطها المتحرك 50 فوق 200.
4. ندخل لما السعر يرجع فوق متوسط 20 بعد ما كان تحته في الشمعة اللي قبلها (ارتداد بعد تصحيح بسيط).
5. وقف خسارة 8% تحت سعر الإشارة، ونخرج لما الشمعة تقفل تحت متوسط 50.

**متى تخسر:**
- في السوق الهابط أو العرضي: الارتدادات فوق متوسط 20 تفشل بسرعة وتضرب الوقف (نسبة الفوز 26% بس).
- لما تتذبذب بيتكوين حول متوسطها 200 تطلع إشارات كثيرة متتالية خاسرة، والربح يعتمد على قلة من الصفقات الطويلة.

**نتائج LIVE (حساب المِحَك):**

| الفترة | العائد % | الصفقات | أقصى تراجع % | معامل الربح |
|---|---|---|---|---|
| 2021 | +101.0 | 364 | 20.5 | 2.31 |
| 2022 | −9.9 | 109 | 16.6 | 0.59 |
| 2023 | +30.5 | 465 | 23.2 | 1.44 |
| 2024 | +25.6 | 472 | 31.9 | 1.31 |
| فترة البحث 2021–2024 | +155.8 | 1437 | 20.5 | 1.60 |

Not tested on anything after 2024-12-31.


## Out-of-sample check (run once, after freezing; not by Fable)

_Run once on 2026-10-16 with `research/backtest.js` on the full Binance data, same live rules (10 slots, $1,000, $50 daily loss stop, 6h pause after 4 losses). `final/strategy.js` is unchanged (`lib/fable-discovery.js`, only the require path differs)._

| Period | Return % | Trades | Max DD % | PF | Coins profitable (alone) |
|---|---|---|---|---|---|
| 2025-01-01 → 2026-10-14 | −30.0 | 533 | 33.6 | 0.66 | 2/16 |
| 2022-01-01 → 2026-10-14 | +23.4 | 1660 | 34.1 | 1.08 | 8/16 |
| Reference: code-breakout-btc, 2025→ | +9.5 | 240 | 32.2 | 1.12 | 11/16 |
| Reference: BTC buy-and-hold, 2025→ | −11.4 | 1 | 53.0 | — | — |

The edge found in 2021–2024 did not hold from 2025 on. Added as a contestant anyway, unchanged, as agreed.
