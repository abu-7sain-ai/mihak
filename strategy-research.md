# Mihak — strategy research (code contestants)

_Run 2026-10-15. Data: Binance 4h/1d klines (data-api.binance.vision), 16 halal USDT pairs. Spot, long only, $100 per trade, 0.15% per side (0.1% fee + 0.05% slippage), same accounting code as the live server (`lib/accounting.js`)._

## Verdict

- **12 candidates** tested on 2022–2024. **7 passed** every rule there. On the single 2025-01-01 → 2026-10-14 check, **only 1 still passed: `breakout-btc-4h`** (breakout + BTC regime filter). It is added as the live contestant **`code-breakout-btc`**.
- The other 6 shortlisted strategies all **lost money from 2025 on**. Following the agreed rule (no tuning after the out-of-sample run), nothing else is added.
- **Be careful with the winner:** its 2025→now profit is thin (+$146 over 21 months, 16 coins), and under Mihak's live limits (3 open trades) it was −$57 in that period. It is essentially the existing “الماضي” Pine breakout plus a BTC filter.

## Rules

A strategy passes only if, **in each period**: total profit > 0, profitable on ≥ 10 of 16 coins, beats buy-and-hold on ≥ 9 of 16 coins. And no single coin > 30% of net profit, judged on the **full 2022 → now** run (also shown per period).

- Entry at the open of the candle after the signal. Stops fill at the stop price, or at the open if price gaps below it. Signal exits at the next open.
- Positions still open at a period end are closed at that day’s close, so the periods are independent. Indicators warm up on 2021 data.
- Buy & hold = $100 bought at the coin’s first open in the period, sold at the last close, same costs.
- **SUI** (from 2023-05) and **SEI** (from 2023-08) count as 2 of the 16 coins with whatever history they have.
- **Max DD** = largest peak-to-trough drop of the combined daily mark-to-market P&L of all 16 coins ($).
- **Live limits**: same strategy run as one Mihak bot — max 3 open trades, $1,000 balance, $50 daily loss stop, 6h pause after 4 losses in a row. When several coins signal together, the one with the most 20-day trading volume goes first. “Skipped” = signals that found no free slot.

## Engine check against your baseline (2022 → now, sum of 16 coins)

| Baseline | Your result | This engine | Coins profitable | Beats B&H |
|---|---|---|---|---|
| Breakout (“الماضي” اختراق) | +$1,400 | +$1,391 | 12/16 | 12/16 |
| EMA20/50 cross (“الماضي” تقاطع) | +$896 | +$893 | 11/16 | 10/16 |

Same direction and size, within 1%. You entered at the signal candle's close and I enter at the next candle's open; with 4h candles the gap is tiny. My first try (without the script's “EMA200 rising” filter and its 1–15% stop clamp) gave +$1,010 and +$1,891, so I matched both exactly to `tradingview/al-madi.pine`.
Under live limits the Breakout baseline makes only +$43: it signals on many coins at once and 2,984 signals found no free slot.

## 1 · Development period 2022-01-01 → 2024-12-31 (all candidates)

| Strategy | Profit | Coins + | Beats B&H | Top coin share | Max DD | Trades | Win % | Live limits: profit / DD | Result |
|---|---|---|---|---|---|---|---|---|---|
| Above SMA100 + BTC above SMA200, 1d | +$2,700 | 15/16 | 12/16 | 14% | $1,346 | 287 | 21% | +$736 / $441 | ✅ pass |
| Supertrend (10, 3), 4h | +$2,359 | 16/16 | 13/16 | 18% | $903 | 1084 | 36% | +$505 / $298 | ✅ pass |
| Donchian 55/20 (Turtle), 1d | +$2,039 | 14/16 | 10/16 | 21% | $789 | 127 | 28% | +$509 / $195 | ✅ pass |
| Breakout + BTC above daily SMA200, 4h | +$1,479 | 14/16 | 9/16 | 30% | $581 | 571 | 29% | +$209 / $132 | ✅ pass |
| EMA20 pullback, ADX>25, 4h | +$1,440 | 11/16 | 7/16 | 26% | $414 | 872 | 27% | +$401 / $228 | ❌ beats B&H on only 7/16 |
| MACD crosses zero + EMA200, 4h | +$1,373 | 13/16 | 9/16 | 17% | $455 | 774 | 28% | +$224 / $246 | ✅ pass |
| Ichimoku above cloud + TK cross, 1d | +$1,327 | 12/16 | 8/16 | 22% | $487 | 111 | 32% | +$348 / $179 | ❌ beats B&H on only 8/16 |
| 4h breakout + daily EMA50 trend | +$1,248 | 12/16 | 8/16 | 30% | $514 | 719 | 29% | +$118 / $280 | ❌ beats B&H on only 8/16; HBAR = 30% of profit |
| Golden cross SMA50/200, 1d | +$1,219 | 13/16 | 12/16 | 23% | $1,114 | 54 | 57% | +$843 / $483 | ✅ pass |
| Weekly top-3 momentum (90d), 1d | +$764 | 10/16 | 7/16 | 43% | $297 | 90 | 38% | +$764 / $297 | ❌ beats B&H on only 7/16; SUI = 43% of profit |
| Keltner breakout + 3 ATR chandelier, 4h | +$702 | 14/16 | 10/16 | 25% | $290 | 1056 | 37% | +$546 / $160 | ✅ pass |
| Bollinger squeeze breakout, 4h | +$92 | 7/16 | 6/16 | 165% | $188 | 367 | 28% | +$26 / $160 | ❌ only 7/16 coins profitable; beats B&H on only 6/16; BCH = 165% of profit |

## 2 · Out-of-sample 2025-01-01 → 2026-10-14 (shortlist only, run once)

| Strategy | Profit | Coins + | Beats B&H | Top coin share | Max DD | Trades | Win % | Live limits: profit / DD | Result |
|---|---|---|---|---|---|---|---|---|---|
| Breakout + BTC above daily SMA200, 4h | +$146 | 11/16 | 14/16 | 34% | $363 | 339 | 33% | −$57 / $241 | ✅ pass (top coin ETH 34% here; the 30% rule is judged on the full run) |
| Above SMA100 + BTC above SMA200, 1d | −$23 | 10/16 | 14/16 | — | $579 | 167 | 21% | −$14 / $177 | ❌ loses money |
| Keltner breakout + 3 ATR chandelier, 4h | −$87 | 6/16 | 12/16 | — | $567 | 714 | 33% | −$77 / $200 | ❌ loses money; only 6/16 coins profitable |
| MACD crosses zero + EMA200, 4h | −$105 | 9/16 | 15/16 | — | $571 | 478 | 26% | −$143 / $295 | ❌ loses money; only 9/16 coins profitable |
| Donchian 55/20 (Turtle), 1d | −$183 | 4/16 | 15/16 | — | $288 | 74 | 26% | −$84 / $136 | ❌ loses money; only 4/16 coins profitable |
| Golden cross SMA50/200, 1d | −$375 | 4/16 | 13/16 | — | $642 | 33 | 27% | −$6 / $153 | ❌ loses money; only 4/16 coins profitable |
| Supertrend (10, 3), 4h | −$626 | 3/16 | 9/16 | — | $1,257 | 761 | 32% | −$132 / $283 | ❌ loses money; only 3/16 coins profitable |

## 3 · Full run 2022-01-01 → 2026-10-14 (for the 30% rule)

| Strategy | Profit | Coins + | Beats B&H | Top coin share | Max DD | Trades | Live limits: profit |
|---|---|---|---|---|---|---|---|
| Above SMA100 + BTC above SMA200, 1d | +$2,702 | 15/16 | 14/16 | 14% (SOL) | $1,398 | 440 | +$718 |
| Supertrend (10, 3), 4h | +$1,735 | 13/16 | 13/16 | 21% (XLM) | $1,607 | 1845 | +$373 |
| Donchian 55/20 (Turtle), 1d | +$1,718 | 13/16 | 12/16 | 23% (SUI) | $1,138 | 199 | +$438 |
| Breakout + BTC above daily SMA200, 4h | +$1,628 | 14/16 | 12/16 | 29% (HBAR) | $596 | 909 | +$153 |
| MACD crosses zero + EMA200, 4h | +$1,267 | 13/16 | 12/16 | 22% (SOL) | $792 | 1252 | +$74 |
| Keltner breakout + 3 ATR chandelier, 4h | +$615 | 11/16 | 9/16 | 39% (XLM) | $567 | 1770 | +$469 |
| Golden cross SMA50/200, 1d | +$391 | 8/16 | 11/16 | 59% (SOL) | $1,485 | 87 | +$793 |

## The winner, coin by coin — `breakout-btc-4h`

| Coin | 2022–24 profit | 2022–24 B&H | 2025→ profit | 2025→ B&H |
|---|---|---|---|---|
| BTC | +$81 | +$102 | +$6 | −$13 |
| ETH | +$37 | −$9 | +$50 | −$27 |
| XRP | +$121 | +$150 | −$3 | −$37 |
| BNB | −$25 | +$37 | +$15 | +$4 |
| SOL | +$122 | +$11 | +$46 | −$45 |
| TRX | +$72 | +$237 | −$19 | +$31 |
| BCH | +$133 | +$1 | −$38 | −$38 |
| ADA | +$38 | −$36 | +$23 | −$73 |
| LINK | +$40 | +$2 | −$28 | −$38 |
| XLM | +$295 | +$24 | +$18 | −$45 |
| LTC | −$54 | −$30 | −$29 | −$42 |
| HBAR | +$441 | −$8 | +$23 | −$69 |
| AVAX | +$69 | −$67 | +$19 | −$72 |
| SUI | +$27 | +$4,010 | +$23 | −$75 |
| DOT | +$27 | −$75 | +$2 | −$83 |
| SEI | +$55 | +$518 | +$39 | −$84 |

**Rules:** entry when a 4h candle closes above the highest high of the previous 20 candles, price is above EMA200, EMA200 is higher than 5 candles ago, and BTC’s last daily close is above its 200-day SMA. Initial stop: 2.5 × ATR(14) below the close (clamped to 1–15%), active inside the candle. Exit on a candle close below the trailing stop (highest of close − 3 × ATR) or below EMA200. No take-profit, no time limit.

## Notes and caveats

- **Every candidate lost or stalled in 2025→now.** That period is mostly a falling or sideways market for altcoins, and buy-and-hold lost on most coins too, which is why “beats B&H” was easy and “profitable” was hard.
- **Live slots matter.** All breakout-style strategies signal on many coins in the same week. With 3 slots, most signals are skipped, so the live contestant will make much less than the 16-coin sum suggests.
- **Overlap with “الماضي”.** The winner is the Pine breakout plus a BTC filter. If “الماضي” is connected later with the breakout mode, the two contestants will often trade the same coins. That is a decision for you.
- **Q10 note.** Your earlier Breakout test had already covered 2025, so the base idea was not fully blind to that period. The BTC-filter variant itself was only run on 2025 once.
- **Golden cross** passed 2022–24 on 54 trades only, a very thin sample, and then lost in 2025→.

## Reproduce

```
node research/fetch.js                      # download klines to research/data (not in git)
node research/backtest.js --period dev       # all candidates, 2022-2024
node research/backtest.js --period oos --only <ids>
node research/backtest.js --period full --only <ids>
```

Strategy code: `lib/strategies.js` (shared by the backtest and the live server). Raw results: `research/out/*.json` (local).
