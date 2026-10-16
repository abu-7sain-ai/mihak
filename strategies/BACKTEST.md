# Backtest of the AI-written strategies

_Run once after generation; the specs were NOT changed. Same harness as `strategy-research.md` (`research/backtest.js`): 16 coins, 4h closed candles, $100 per trade, 0.1% fee + 0.05% slippage per side, and the live server rules: 10 slots, $1000 balance, 5% daily loss stop, 6h pause after 4 losses in a row._

Return and max drawdown are % of the $1,000 account. PF = profit factor (gross wins / gross losses).

| Contestant | Model | 2022→now return | trades | max DD | PF | 2025→now return | trades | max DD | PF |
|---|---|---|---|---|---|---|---|---|---|
| استراتيجية Fable | claude-fable-5-1 | +62.8% | 1249 | 25.4% | 1.23 | +17.5% | 424 | 23.4% | 1.21 |
| استراتيجية GPT | openai/gpt-6.1-sol-pro | -10.7% | 2137 | 41.5% | 0.98 | -32.9% | 782 | 43.0% | 0.80 |
| استراتيجية Qwen | qwen/qwen3.8-max-prime | +13.4% | 1213 | 30.0% | 1.04 | -19.9% | 372 | 29.7% | 0.79 |
| استراتيجية DeepSeek | deepseek/deepseek-v4-pro-0813 | +5.4% | 875 | 26.9% | 1.02 | -13.4% | 286 | 21.5% | 0.80 |
| مرجع: code-breakout-btc | — | +98.9% | 748 | 30.6% | 1.39 | +9.5% | 240 | 32.2% | 1.12 |
| مرجع: code-breakout-nobtc | — | +71.1% | 1026 | 43.2% | 1.21 | -16.0% | 371 | 38.0% | 0.86 |

The models may remember 2022–2025 prices from their training, so this is not a fully blind test.

Each coin on its own (no slot limit), as in the earlier report:

| Contestant | 2022→now $ | coins + | 2025→now $ | coins + |
|---|---|---|---|---|
| استراتيجية Fable | +702 | 12/16 | +214 | 11/16 |
| استراتيجية GPT | -33 | 8/16 | -595 | 3/16 |
| استراتيجية Qwen | +230 | 10/16 | -186 | 5/16 |
| استراتيجية DeepSeek | +175 | 9/16 | -91 | 7/16 |
| مرجع: code-breakout-btc | +1628 | 14/16 | +146 | 11/16 |
| مرجع: code-breakout-nobtc | +1391 | 12/16 | -119 | 6/16 |
