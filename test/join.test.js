const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// قاعدة بيانات فيها مسابقة شغالة، بدون المايسترو (مثل اللي على Railway وقت النشر)
const DB = path.join(os.tmpdir(), `mihak-join-test-${process.pid}.json`);
process.env.DB_FILE = DB;
const { _internals: S } = require('../server');

const STARTED = Date.UTC(2026, 9, 22, 12, 0);
test('a contestant added mid-competition starts with the current starting balance and its own join time; nothing else changes', async () => {
  const ids = Object.keys(S.BOT).filter(id => id !== 'maestro');
  const saved = {
    version: 3,
    rules: { ...S.state().rules, startingBalance: 2000, aiPaused: false },
    competition: { startedAt: STARTED, locked: true },
    bots: Object.fromEntries(ids.map(id => [id, { balance: 1234, trades: [{ id: `t-${id}`, status: 'active', symbol: 'BTCUSDT' }], balanceHistory: [{ time: STARTED, balance: 2000 }], decisions: [], aiCostUSD: 0, cb: { consecutiveLosses: 0, pausedUntil: null }, system: {} }])),
    opportunities: [], fable: { rounds: 7 }, system: {},
  };
  fs.writeFileSync(DB, JSON.stringify(saved));
  const before = Date.now();
  S.loadDb();
  const st = S.state();
  const m = st.bots.maestro;
  assert.strictEqual(m.balance, 2000, 'current starting balance, not the default 1000');
  assert.strictEqual(m.balanceHistory[0].balance, 2000);
  assert.ok(m.joinedAt >= before && m.joinedAt <= Date.now(), 'own join time');
  assert.strictEqual(m.trades.length, 0);
  for (const id of ids) {
    assert.strictEqual(st.bots[id].balance, 1234, `${id} untouched`);
    assert.strictEqual(st.bots[id].trades[0].id, `t-${id}`);
    assert.strictEqual(st.bots[id].joinedAt, undefined);
  }
  assert.deepStrictEqual(st.competition, { startedAt: STARTED, locked: true }, 'competition and its start date unchanged');
  assert.strictEqual(st.rules.aiPaused, false, 'aiPaused=false survives the restart');
  assert.strictEqual(st.fable.rounds, 7);

  // إعادة تشغيل ثانية: وقت الانضمام ما يتغير
  const joinedAt = m.joinedAt;
  await S.saveDb();
  S.loadDb();
  assert.strictEqual(S.state().bots.maestro.joinedAt, joinedAt);
  assert.strictEqual(S.state().bots.maestro.balance, 2000);
  fs.rmSync(DB, { force: true });
});
