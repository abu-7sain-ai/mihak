const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.MCP_SECRET = 'auto-secret';
process.env.DB_FILE = path.join(os.tmpdir(), `mihak-autopause-test-${process.pid}.json`);
const { _internals: S } = require('../server');

const sent = [];
S.setTelegram({ enabled: true, sendMessage: async t => { sent.push(t); return { ok: true }; } });
const st = () => S.state();
const setRegime = bucket => {
  st().regime = { state: bucket === 'choppy' ? 'bull' : bucket, choppy: bucket === 'choppy', bucket, btcClose: 80000, sma50: 79000, sma200: 70000, distancePct: 14, distance50Pct: 1, asOf: '2026-10-25', asOfT: Date.UTC(2026, 9, 25) };
};

test('aiActive in each regime state, with aiOnlyInBull on and off', () => {
  st().rules.aiPaused = false;
  st().rules.aiOnlyInBull = true;
  const expect = { bull: true, correction: false, bear: false, choppy: false };
  for (const [b, on] of Object.entries(expect)) {
    setRegime(b);
    assert.strictEqual(S.aiActive(), on, b);
    if (!on) {
      assert.strictEqual(S.aiStatus().mode, 'auto');
      assert.match(S.aiStatus().reason, /موقوف تلقائياً بسبب حالة السوق/);
      assert.match(S.blockReason('now-qwen'), /تلقائياً/, 'AI bots blocked from new entries');
    }
  }
  st().regime = null;
  assert.strictEqual(S.aiActive(), false, 'no regime yet = paused (safe)');
  st().rules.aiOnlyInBull = false;
  for (const b of ['bull', 'correction', 'bear', 'choppy']) { setRegime(b); assert.strictEqual(S.aiActive(), true, `${b} with aiOnlyInBull=false`); }
  st().rules.aiOnlyInBull = true;
});

test('the manual switch wins over everything', () => {
  setRegime('bull');
  st().rules.aiPaused = true;
  assert.strictEqual(S.aiActive(), false);
  assert.strictEqual(S.aiStatus().mode, 'manual');
  st().rules.aiOnlyInBull = false;
  assert.strictEqual(S.aiActive(), false);
  st().rules.aiOnlyInBull = true;
  st().rules.aiPaused = false;
  assert.strictEqual(S.aiActive(), true);
});

test('code bots, maestro, past-strategy, random and hodl are never blocked by the AI pause', () => {
  setRegime('bear');
  for (const id of ['code-breakout-btc', 'strat-gpt', 'fable-discovery', 'maestro', 'past-strategy', 'random'])
    assert.doesNotMatch(String(S.blockReason(id)), /تلقائياً|لتوفير التكلفة/, id);
});

test('auto pause/resume: one Telegram message each, periods recorded, no repeats', () => {
  st().rules.aiPaused = false;
  st().aiStatusLast = 'on';
  st().aiPauses = [];
  setRegime('bull');
  S.syncAiStatus();
  const n0 = sent.length;
  setRegime('correction');
  S.syncAiStatus(1000);
  S.syncAiStatus(2000);                                     // نفس الحالة: ما فيه رسالة ثانية
  assert.strictEqual(sent.length, n0 + 1);
  assert.match(sent.at(-1), /^⏸️ المحك: الموديلات توقفت تلقائياً/);
  assert.match(sent.at(-1), /متوسط 200/, 'carries the regime line');
  assert.deepStrictEqual(st().aiPauses.map(p => [p.start, p.end, p.mode]), [[1000, null, 'auto']]);
  setRegime('bear');                                        // لسه موقوف، ما فيه رسالة
  S.syncAiStatus(3000);
  assert.strictEqual(sent.length, n0 + 1);
  setRegime('bull');
  S.syncAiStatus(4000);
  assert.strictEqual(sent.length, n0 + 2);
  assert.match(sent.at(-1), /^▶️ المحك: الموديلات رجعت تلقائياً/);
  assert.deepStrictEqual(st().aiPauses.map(p => [p.start, p.end, p.mode]), [[1000, 4000, 'auto']]);
  assert.strictEqual(st().aiStatusLast, 'on');
});

test('open AI trades keep their take-profit, stop-loss and max-hold exits while AI is paused', async () => {
  S.setMarket({ subscribe() {}, unsubscribe() {}, price: async () => 100 });
  st().rules.aiPaused = false;
  setRegime('bull');
  const id = 'now-qwen';
  st().bots[id].trades = [];
  st().bots[id].balance = 1000;
  const a = await S.enterTrade(id, { symbol: 'ETHUSDT', tpPercent: 5, slPercent: -3, maxMinutes: 60 });
  const b = await S.enterTrade(id, { symbol: 'SOLUSDT', tpPercent: 5, slPercent: -3, maxMinutes: 60 });
  const c = await S.enterTrade(id, { symbol: 'XRPUSDT', tpPercent: 5, slPercent: -3, maxMinutes: 1 });
  assert.ok(a.trade && b.trade && c.trade);
  setRegime('choppy');                                      // الموديلات توقف
  assert.strictEqual(S.aiActive(), false);
  const blocked = await S.enterTrade(id, { symbol: 'ADAUSDT', tpPercent: 5, slPercent: -3 });
  assert.match(blocked.error, /تلقائياً/, 'no NEW AI trades while paused');
  S.onPrice('ETHUSDT', 106);                                // فوق الهدف
  S.onPrice('SOLUSDT', 96);                                 // تحت الوقف
  assert.strictEqual(a.trade.closeReason, 'take-profit');
  assert.strictEqual(b.trade.closeReason, 'stop-loss');
  c.trade.startTime -= 2 * 60_000;                          // عدّت المدة
  S.checkTimeouts();
  assert.strictEqual(c.trade.closeReason, 'timeout');
});

test('a paused round makes no AI work and opens no Fable round', async () => {
  st().rules.aiPaused = false;
  setRegime('bear');
  const calls = [];
  S.setMarket({ subscribe() {}, unsubscribe() {}, price: async () => 100, snapshot: async () => { calls.push('snapshot'); return []; }, klines: async () => { calls.push('klines'); return []; } });
  S.setUniverse(['ETHUSDT']);
  const before = st().fable.rounds;
  const qwenDecisions = st().bots['now-qwen'].decisions.length;
  await S.decisionCycle();
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(st().fable.rounds, before, 'paused rounds are not counted');
  assert.strictEqual(st().bots['now-qwen'].decisions.length, qwenDecisions, 'no new AI decisions');
  assert.strictEqual((await S.actions.refreshNews()).status, 409);
});

test('aiOnlyInBull is settable even when the rules are locked', async () => {
  st().competition.locked = true;
  assert.strictEqual((await S.actions.setRules({ aiOnlyInBull: false })).status, 200);
  assert.strictEqual(st().rules.aiOnlyInBull, false);
  assert.strictEqual((await S.actions.setRules({ aiOnlyInBull: 'no' })).status, 400);
  assert.strictEqual((await S.actions.setRules({ aiOnlyInBull: true })).status, 200);
  assert.strictEqual((await S.actions.setRules({ minConfidence: 60 })).status, 423);
  st().competition.locked = false;
});
