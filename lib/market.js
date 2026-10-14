// ═══════════════════════════════════════════════════════════════════════════
//  السوق — أسعار Binance الحية، أو أسعار وهمية في وضع التجربة (MOCK_MARKET=1)
// ═══════════════════════════════════════════════════════════════════════════
const WebSocket = require('ws');

// روابط بيانات السوق العامة فقط: api.binance.com يرد 451 على سيرفرات أمريكا (Railway US West)
const BINANCE = process.env.BINANCE_REST || 'https://data-api.binance.vision';
const BINANCE_WS = process.env.BINANCE_WS || 'wss://data-stream.binance.vision';

class LiveMarket {
  constructor(log) {
    this.log = log;
    this.streams = new Map();   // symbol -> ws
    this.listeners = new Set(); // (symbol, price) => void
    this.last = new Map();      // symbol -> last price
  }

  onPrice(fn) { this.listeners.add(fn); }
  emit(symbol, price) {
    this.last.set(symbol, price);
    for (const fn of this.listeners) fn(symbol, price);
  }

  async tradableUsdtSymbols() {
    const r = await fetch(`${BINANCE}/api/v3/exchangeInfo?permissions=SPOT`);
    if (!r.ok) throw new Error(`exchangeInfo ${r.status}`);
    const { symbols } = await r.json();
    return new Set(symbols
      .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING')
      .map(s => s.symbol));
  }

  async price(symbol) {
    const r = await fetch(`${BINANCE}/api/v3/ticker/price?symbol=${symbol}`);
    if (!r.ok) throw new Error(`price ${symbol} ${r.status}`);
    const p = parseFloat((await r.json()).price);
    if (!Number.isFinite(p)) throw new Error(`price ${symbol} NaN`);
    this.last.set(symbol, p);
    return p;
  }

  /** لقطة السوق للمتسابقين: تغيّر ساعة، 4 ساعات، 24 ساعة، والحجم */
  async snapshot(symbols) {
    const list = encodeURIComponent(JSON.stringify(symbols));
    const get = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`ticker ${r.status}`);
      return r.json();
    };
    const [h1, h4, d1] = await Promise.all([
      get(`${BINANCE}/api/v3/ticker?symbols=${list}&windowSize=1h&type=MINI`),
      get(`${BINANCE}/api/v3/ticker?symbols=${list}&windowSize=4h&type=MINI`),
      get(`${BINANCE}/api/v3/ticker/24hr?symbols=${list}`),
    ]);
    const pct = (o) => (parseFloat(o.lastPrice) / parseFloat(o.openPrice) - 1) * 100;
    const by = (arr) => Object.fromEntries(arr.map(o => [o.symbol, o]));
    const H1 = by(h1), H4 = by(h4);
    return d1.map(o => ({
      symbol: o.symbol,
      price: parseFloat(o.lastPrice),
      chg1h: +pct(H1[o.symbol]).toFixed(2),
      chg4h: +pct(H4[o.symbol]).toFixed(2),
      chg24h: +parseFloat(o.priceChangePercent).toFixed(2),
      volume24hUSD: Math.round(parseFloat(o.quoteVolume)),
    }));
  }

  /** شموع حقيقية (4h أو 1d) للمؤشرات الفنية، مع تخزين مؤقت 10 دقائق */
  async klines(symbol, interval, limit = 250) {
    this.kcache ??= new Map();
    const key = `${symbol}:${interval}`;
    const hit = this.kcache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
    const r = await fetch(`${BINANCE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!r.ok) throw new Error(`klines ${symbol} ${r.status}`);
    const rows = await r.json();
    // الشمعة الأخيرة ما سكّرت بعد، نستبعدها حتى ما نستخدم معلومة ناقصة
    const data = rows.slice(0, -1).map(k => ({ open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
    this.kcache.set(key, { at: Date.now(), data });
    return data;
  }

  subscribe(symbol) {
    if (this.streams.has(symbol)) return;
    const ws = new WebSocket(`${BINANCE_WS}/ws/${symbol.toLowerCase()}@miniTicker`);
    this.streams.set(symbol, ws);
    ws.on('message', raw => {
      try {
        const { c, s } = JSON.parse(raw);
        const p = parseFloat(c);
        if (Number.isFinite(p)) this.emit(s, p);
      } catch { /* ignore */ }
    });
    ws.on('close', () => {
      if (this.streams.get(symbol) !== ws) return;
      this.streams.delete(symbol);
      if (this.wanted?.(symbol)) setTimeout(() => this.subscribe(symbol), 5_000);
    });
    ws.on('error', e => this.log.err(`WS ${symbol}: ${e.message}`));
  }

  unsubscribe(symbol) {
    const ws = this.streams.get(symbol);
    if (!ws) return;
    this.streams.delete(symbol);
    ws.close();
  }
}

// ── وضع التجربة: أسعار وهمية تتحرك عشوائياً، بدون إنترنت وبدون مفاتيح ─────────
class MockMarket extends LiveMarket {
  constructor(log, universe) {
    super(log);
    this.prices = new Map();
    const seeds = { BTCUSDT: 65000, ETHUSDT: 3200, SOLUSDT: 150, BNBUSDT: 580, XRPUSDT: 0.55 };
    for (const s of universe) this.prices.set(s, seeds[s] ?? 1 + Math.random() * 50);
    this.history = new Map([...this.prices].map(([s, p]) => [s, [p]]));
    this.timer = setInterval(() => this.tick(), 1_000);
  }
  tick() {
    for (const [s, p] of this.prices) {
      const vol = s === 'BTCUSDT' ? 0.0008 : 0.0015;
      const np = p * (1 + (Math.random() - 0.5) * 2 * vol);
      this.prices.set(s, np);
      const h = this.history.get(s); h.push(np); if (h.length > 86_400) h.shift();
      if (this.streams.has(s)) this.emit(s, np);
    }
  }
  async tradableUsdtSymbols() { return new Set(this.prices.keys()); }
  async price(symbol) {
    const p = this.prices.get(symbol);
    if (p == null) throw new Error(`unknown ${symbol}`);
    return p;
  }
  async snapshot(symbols) {
    const chg = (h, n) => +((h.at(-1) / h[Math.max(0, h.length - 1 - n)] - 1) * 100).toFixed(2);
    return symbols.filter(s => this.prices.has(s)).map(s => {
      const h = this.history.get(s);
      return { symbol: s, price: h.at(-1), chg1h: chg(h, 3600), chg4h: chg(h, 14400), chg24h: chg(h, 86400), volume24hUSD: 0 };
    });
  }
  async klines(symbol, interval, limit = 250) {
    const p0 = this.prices.get(symbol);
    if (p0 == null) throw new Error(`unknown ${symbol}`);
    const vol = interval === '1d' ? 0.03 : 0.012;
    const out = [];
    let p = p0 / (1 + (Math.random() - 0.45) * vol * Math.sqrt(limit));
    for (let i = 0; i < limit; i++) {
      const o = p, c = o * (1 + (Math.random() - 0.5) * 2 * vol);
      out.push({ open: o, high: Math.max(o, c) * (1 + Math.random() * vol / 2), low: Math.min(o, c) * (1 - Math.random() * vol / 2), close: c, volume: 1000 + Math.random() * 500 });
      p = c;
    }
    out.at(-1).close = p0;
    return out;
  }
  subscribe(symbol) { this.streams.set(symbol, true); }
  unsubscribe(symbol) { this.streams.delete(symbol); }
}

module.exports = { LiveMarket, MockMarket };
