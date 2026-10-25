const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.DEMO = '1';                 // الاجتماع بأصوات وهمية، بدون مفاتيح
process.env.MCP_SECRET = 'test-fable-secret';
process.env.DB_FILE = path.join(os.tmpdir(), `mihak-fable-test-${process.pid}.json`);
const { app, _internals: S } = require('../server');
const ai = require('../lib/ai');

const candles = Array.from({ length: 260 }, (_, i) => {
  const c = 100 * 1.001 ** i;
  return { open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 };
});
const snapshot = [
  { symbol: 'BTCUSDT', price: 100, chg1h: 0.1, chg4h: 0.5, chg24h: 1, volume24hUSD: 1e9, atr4hPct: 1.2 },
  { symbol: 'ETHUSDT', price: 100, chg1h: 0.2, chg4h: 0.8, chg24h: 2, volume24hUSD: 5e8, atr4hPct: 1.8 },
];
const decision = action => JSON.stringify({ action, symbol: 'ETHUSDT', takeProfitPercent: 4, stopLossPercent: 2, maxHoldHours: 12, confidence: 80, reason: 'اختبار' });
const fam = ['now-fable', 'now-fable-chair', 'now-fable-rule', 'now-fable-always'];

let srv, base;
test.before(async () => {
  S.state().rules.aiPaused = false;   // هالاختبارات عن شغل Fable نفسه
  S.state().rules.aiOnlyInBull = false;
  S.setMarket({ unsubscribe() {}, subscribe() {}, price: async () => 100, klines: async () => candles });
  srv = http.createServer(app);
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv.closeAllConnections(); srv.close(); });

const get = (secret = 'test-fable-secret') => fetch(`${base}/api/fable/round`, { headers: { 'x-mihak-secret': secret } });
const post = (body, secret = 'test-fable-secret') => fetch(`${base}/api/fable/decision`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-mihak-secret': secret }, body: JSON.stringify(body),
});

test('round endpoint needs the secret and hands out the same prompt the server scouts get', async () => {
  assert.strictEqual((await get('wrong')).status, 404);
  S.openFableRound(1_000_000, snapshot);
  const r = await (await get()).json();
  assert.strictEqual(r.status, 'waiting');
  assert.strictEqual(r.roundId, 1_000_000);
  assert.deepStrictEqual(r.allowed, ['BTCUSDT', 'ETHUSDT']);
  // الجهاز يقدر يبني نفس الطلب من اللقطة
  assert.strictEqual(ai.decisionPrompt({ news: r.news, market: r.snapshot, held: r.held, rules: r.rules }), r.prompt);
});

test('a Fable BUY runs the whole family like the other scouts, and only once', async () => {
  assert.strictEqual((await post({ roundId: 999, text: decision('BUY') })).status, 409);
  assert.strictEqual((await post({ roundId: 1_000_000, text: 'not json' })).status, 400);
  const ok = await post({ roundId: 1_000_000, text: decision('BUY'), model: 'claude-fable-5-1', usage: { inputTokens: 1200, outputTokens: 80, notionalUSD: 0.01 } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await post({ roundId: 1_000_000, text: decision('BUY') })).status, 409);   // مرة وحدة بس
  await S.fableRound().applied;

  const st = S.state();
  const scout = st.bots['now-fable'];
  assert.strictEqual(scout.decisions[0].action, 'BUY');
  assert.strictEqual(scout.decisions[0].round, 1_000_000);
  assert.strictEqual(scout.decisions[0].usage.inputTokens, 1200);
  assert.strictEqual(scout.trades[0].round, 1_000_000);
  assert.strictEqual(st.bots['now-fable-always'].trades.length, 1);
  for (const id of ['now-fable-chair', 'now-fable-rule']) assert.ok(st.bots[id].decisions.length >= 1, id);
  const opp = st.opportunities.find(o => o.source === 'now-fable');
  assert.ok(opp && opp.round === 1_000_000);
  assert.strictEqual(st.fable.present, 1);
});

test('no reply in time means MISSED for the whole family, with no trade or opportunity', async () => {
  const st = S.state();
  const trades = fam.map(id => st.bots[id].trades.length);
  const opps = st.opportunities.length;
  S.openFableRound(2_000_000, snapshot);
  S.missFableRound();
  for (const id of fam) assert.strictEqual(st.bots[id].decisions[0].action, 'MISSED', id);
  assert.deepStrictEqual(fam.map(id => st.bots[id].trades.length), trades);
  assert.strictEqual(st.opportunities.length, opps);
  assert.strictEqual(S.fableSummary().missed, 1);
  assert.strictEqual(S.fableSummary().present, 1);
  assert.strictEqual((await post({ roundId: 2_000_000, text: decision('BUY') })).status, 409);
});

test('a restart in the same quarter does not reopen the round; a lost waiting round counts as missed', () => {
  const st = S.state();
  const rounds = st.fable.rounds, missed = st.fable.missed;
  S.openFableRound(2_000_000, snapshot);                 // نفس الجولة اللي فاتته فوق
  assert.strictEqual(st.fable.rounds, rounds);
  assert.strictEqual(st.fable.missed, missed);
  st.fable.lastRound = { id: 3_000_000, status: 'waiting', at: 3_000_000 };   // انفتحت قبل إعادة التشغيل
  S.openFableRound(3_000_000, snapshot);
  assert.strictEqual(st.fable.rounds, rounds);
  assert.strictEqual(st.fable.missed, missed + 1);
  assert.strictEqual(st.bots['now-fable'].decisions[0].action, 'MISSED');
});

test('fair comparison only counts rounds where Fable answered', () => {
  const st = S.state();
  st.opportunities.unshift(
    { source: 'now-qwen', symbol: 'BTCUSDT', status: 'won', pnlUSD: 1, round: 1_000_000, shadow: false },
    { source: 'now-qwen', symbol: 'BTCUSDT', status: 'lost', pnlUSD: -1, round: 2_000_000, shadow: false },
  );
  const fair = S.fairComparison();
  assert.strictEqual(fair.roundsCompared, 1);
  assert.strictEqual(fair.scouts['now-qwen'].opportunities, 1);
  assert.strictEqual(fair.scouts['now-qwen'].scoutWinRate, 100);
  assert.strictEqual(fair.bots['now-fable'].trades, 1);
  assert.ok(!('hodl' in fair.bots));
});
