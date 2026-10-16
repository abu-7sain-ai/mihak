# Non-breakout code contestants — backtest

_Run once before adding them; nothing was changed after seeing the results. `research/backtest.js`, 16 coins, $100 per trade (DCA: its own amounts), 0.1% fee + 0.05% slippage per side, live server rules: 10 slots, $1000 balance, 5% daily loss stop, 6h pause after 4 losses._

Return and max drawdown are % of the $1,000 account. PF = gross wins / gross losses ("—" when nothing is sold).
DCA in the backtest spreads the $1,000 over every week of the period (same rule as live, where it lasts 8 weeks). hodl = all $1,000 into BTC on day one.

| Contestant | 2022→now return | trades | max DD | PF | 2025→now return | trades | max DD | PF |
|---|---|---|---|---|---|---|---|---|
| code-rotation · تدوير أقوى العملات | +27.0% | 215 | 29.6% | 1.20 | -31.5% | 78 | 34.3% | 0.41 |
| code-pullback · شراء النزلة | -38.5% | 2570 | 41.2% | 0.86 | -27.5% | 956 | 29.3% | 0.72 |
| code-bollinger · حدود البولنجر | -36.8% | 1540 | 50.4% | 0.89 | -27.7% | 510 | 31.1% | 0.77 |
| code-dca · شراء دوري ذكي | +45.9% | 500 | 48.8% | — | +0.5% | 186 | 34.0% | — |
| مرجع: code-breakout-btc | +98.9% | 748 | 30.6% | 1.39 | +9.5% | 240 | 32.2% | 1.12 |
| مرجع: hodl (BTC) | +79.4% | 1 | 66.9% | — | -11.4% | 1 | 53.0% | — |
