// يجيب شموع Binance (4h و 1d) للعملات الـ16 من 2021-01-01 لليوم، ويحفظها في research/data
// الشموع المغلقة بس. الاستخدام: node research/fetch.js
const fs = require('fs');
const path = require('path');

const BASE = process.env.BINANCE_REST || 'https://data-api.binance.vision';
const COINS = ['BTC', 'ETH', 'XRP', 'BNB', 'SOL', 'TRX', 'BCH', 'ADA', 'LINK', 'XLM', 'LTC', 'HBAR', 'AVAX', 'SUI', 'DOT', 'SEI'];
const START = Date.UTC(2021, 0, 1);
const DIR = path.join(__dirname, 'data');
const MS = { '4h': 4 * 3_600_000, '1d': 86_400_000 };

async function fetchAll(symbol, interval) {
  const out = [];
  let from = START;
  for (;;) {
    const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${from}&limit=1000`;
    let r;
    for (let i = 0; i < 4; i++) {
      r = await fetch(url).catch(() => null);
      if (r && r.ok) break;
      await new Promise(res => setTimeout(res, 2000 * (i + 1)));
    }
    if (!r || !r.ok) throw new Error(`${symbol} ${interval}: ${r ? r.status : 'network'}`);
    const rows = await r.json();
    if (!rows.length) break;
    for (const k of rows) out.push({ t: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], quoteVolume: +k[7] });
    from = rows.at(-1)[0] + MS[interval];
    if (rows.length < 1000) break;
  }
  const now = Date.now();
  return out.filter(c => c.t + MS[interval] <= now);   // المغلقة بس
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const c of COINS) {
    for (const iv of ['4h', '1d']) {
      const sym = `${c}USDT`;
      const candles = await fetchAll(sym, iv);
      fs.writeFileSync(path.join(DIR, `${sym}_${iv}.json`), JSON.stringify(candles));
      console.log(sym, iv, candles.length, new Date(candles[0].t).toISOString().slice(0, 10), '→', new Date(candles.at(-1).t).toISOString().slice(0, 10));
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
