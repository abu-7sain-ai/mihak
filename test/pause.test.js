const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.MCP_SECRET = 'pause-secret';
process.env.DB_FILE = path.join(os.tmpdir(), `mihak-pause-test-${process.pid}.json`);
const { _internals: S } = require('../server');
const { computeRegime, regimeLine } = require('../lib/regime');
const { createTelegram } = require('../lib/telegram');

const DAY = 86_400_000;
const sent = [];
S.setTelegram({ enabled: true, sendMessage: async t => { sent.push(t); return { ok: true }; } });

test('aiPaused is on by default: AI bots are blocked with the Arabic note, code bots are not', () => {
  assert.strictEqual(S.state().rules.aiPaused, true);
  for (const id of ['now-qwen', 'now-deepseek-chair', 'now-fable-always'])
    assert.strictEqual(S.blockReason ? S.blockReason(id) : null, 'متوقف مؤقتاً لتوفير التكلفة', id);
  for (const id of ['code-breakout-btc', 'strat-gpt', 'fable-discovery', 'past-strategy', 'random'])
    assert.notStrictEqual(S.blockReason(id), 'متوقف مؤقتاً لتوفير التكلفة', id);
});

test('a paused round calls no news, no scouts and opens no Fable round; the random referee still runs', async () => {
  const calls = [];
  S.setMarket({ subscribe() {}, unsubscribe() {}, price: async () => 100,
    snapshot: async () => { calls.push('snapshot'); return []; }, klines: async () => { calls.push('klines'); return []; } });
  S.setUniverse(['ETHUSDT']);
  const before = S.state().bots.random.decisions.length;
  await S.decisionCycle();
  assert.deepStrictEqual(calls, [], 'no market snapshot for the AI families');
  assert.strictEqual(S.fableRound(), null, 'no Fable round opened');
  assert.strictEqual(S.state().bots.random.decisions.length, before + 1, 'random referee decided');
  assert.strictEqual(S.state().news.at, null, 'no news fetched');
  const n = await S.actions.refreshNews();
  assert.strictEqual(n.status, 409);
});

test('aiPaused can be flipped even when the rules are locked, and each flip sends one Telegram line', async () => {
  S.state().competition.locked = true;
  const blocked = await S.actions.setRules({ minConfidence: 60 });
  assert.strictEqual(blocked.status, 423);
  const off = await S.actions.setRules({ aiPaused: false });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(S.state().rules.aiPaused, false);
  assert.match(sent.at(-1), /رجعت الموديلات/);
  const bad = await S.actions.setRules({ aiPaused: 'yes' });
  assert.strictEqual(bad.status, 400);
  await S.actions.setRules({ aiPaused: true });
  assert.match(sent.at(-1), /موقوفة/);
  await S.actions.setRules({ aiPaused: true });          // نفس القيمة: ما فيه رسالة ثانية
  assert.strictEqual(sent.filter(t => /موقوفة/.test(t)).length, 1);
  S.state().competition.locked = false;
});

// شموع البتكوين اليومية: 300 يوم ثابت، ثم مسار نختاره لآخر الأيام
const btc = tail => {
  const t0 = Date.UTC(2025, 0, 1);
  const base = Array.from({ length: 300 }, () => 100);
  return [...base, ...tail].map((close, i) => ({ t: t0 + i * DAY, open: close, high: close, low: close, close }));
};

test('regime: bull needs 2 closes above the 200-day SMA, one close back below does not flip it', () => {
  assert.strictEqual(computeRegime(btc([90, 90])).state, 'bear');
  const one = computeRegime(btc([90, 90, 120]));
  assert.strictEqual(one.state, 'bear');
  assert.strictEqual(one.daysAbove, 1);
  const two = computeRegime(btc([90, 90, 120, 121]));
  assert.strictEqual(two.state, 'bull');
  assert.strictEqual(two.daysAbove, 2);
  assert.ok(two.distancePct > 0 && two.sma200 > 0);
  assert.strictEqual(two.since, two.asOf);
  assert.strictEqual(computeRegime(btc([90, 90, 120, 121, 80])).state, 'bull');
  assert.strictEqual(computeRegime(btc([90, 90, 120, 121, 80, 80])).state, 'bear');
  assert.match(regimeLine(two), /السوق صاعد/);
});

test('the regime watcher alerts once on a change to bull, and not again the same day', async () => {
  const now = Date.UTC(2026, 0, 10, 0, 10);
  const days = n => { const s = Array.from({ length: 300 }, () => 100); return s.concat(n); };
  const mk = closes => closes.map((c, i, a) => ({ t: Math.floor(now / DAY) * DAY - (a.length - i) * DAY, open: c, high: c, low: c, close: c }));
  S.state().regime = null;
  S.setMarket({ subscribe() {}, unsubscribe() {}, klines: async () => mk(days([90, 90])) });
  await S.updateRegime(now);
  assert.strictEqual(S.state().regime.state, 'bear');
  const before = sent.length;
  S.state().regime.asOfT -= DAY;                          // يوم جديد
  S.setMarket({ subscribe() {}, unsubscribe() {}, klines: async () => mk(days([90, 90, 120, 121])) });
  await S.updateRegime(now);
  assert.strictEqual(S.state().regime.state, 'bull');
  assert.strictEqual(sent.length, before + 1);
  assert.match(sent.at(-1), /📈 البتكوين قفل يومين فوق متوسط 200 يوم/);
  await S.updateRegime(now + 60_000);
  assert.strictEqual(sent.length, before + 1, 'no repeat');
});

test('weekly summary goes out once on Sunday evening (Kuwait) with top 5 and bottom 3', async () => {
  const sun = Date.UTC(2026, 9, 18, 17, 1);               // الأحد 20:01 بتوقيت الكويت
  assert.strictEqual(new Date(sun).getUTCDay(), 0);
  assert.strictEqual(await S.weeklySummary(sun - 2 * 3_600_000), null, 'not before 20:00 Kuwait');
  const text = await S.weeklySummary(sun);
  assert.match(text, /ملخص الأسبوع/);
  assert.match(text, /الأفضل:/);
  assert.match(text, /الصفقات المفتوحة: \d+/);
  assert.strictEqual(await S.weeklySummary(sun + 3_600_000), null, 'once per Sunday');
});

test('telegram only calls sendMessage, never throws, and hides the token', async () => {
  const urls = [];
  const t = createTelegram({ token: 'SECRET123', chatId: '-1', log: { err: m => urls.push('LOG:' + m) },
    fetchImpl: async url => { urls.push(url); throw new Error('boom SECRET123'); } });
  const r = await t.sendMessage('hi');
  assert.strictEqual(r.ok, false);
  assert.ok(urls[0].endsWith('/sendMessage'));
  assert.ok(!r.error.includes('SECRET123') && !urls[1].includes('SECRET123'));
  assert.deepStrictEqual(await createTelegram({ token: '', chatId: '' }).sendMessage('x'), { ok: false, skipped: true });
});
