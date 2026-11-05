const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SECRETS = {
  DASHBOARD_PASSWORD: 'dash-pass-9f3k2',
  MCP_SECRET: 'mcp-secret-7x8q1z',
  WEBHOOK_SECRET: 'hook-secret-4n6m2',
  OPENROUTER_API_KEY: 'sk-or-v1-0123456789abcdef0123456789abcdef',
  XAI_API_KEY: 'xai-0123456789abcdefghij',
};
Object.assign(process.env, SECRETS);
process.env.DB_FILE = path.join(os.tmpdir(), `mihak-public-test-${process.pid}.json`);
const { app, _internals: S } = require('../server');
const { rateLimiter, redact } = require('../lib/public-view');

let srv, base;
const owner = { authorization: 'Basic ' + Buffer.from('x:' + SECRETS.DASHBOARD_PASSWORD).toString('base64') };
test.before(async () => {
  S.setMarket({ unsubscribe() {}, subscribe() {}, price: async () => 100 });
  // بيانات فيها أشياء حساسة لازم ما تطلع: خطأ نظام، تكلفة واستهلاك الموديل، مفتاح داخل نص
  const b = S.state().bots['now-qwen'];
  b.system.lastError = `OpenRouter 401 key ${SECRETS.OPENROUTER_API_KEY}`;
  b.decisions.unshift({ at: Date.now(), action: 'WAIT', reason: `شفت ${SECRETS.OPENROUTER_API_KEY} و https://x.up.railway.app/mcp/${SECRETS.MCP_SECRET}`, model: 'qwen/secret-model', costUSD: 0.01, usage: { prompt_tokens: 9 } });
  srv = http.createServer(app);
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv.closeAllConnections(); srv.close(); });

const FORBIDDEN_KEYS = ['models', 'fable', 'fairComparison', 'lastError', 'costUSD', 'usage', 'model', 'webhook', 'openrouter', 'xai', 'mcp', 'secret', 'password', 'export'];
// meetings.*.chairs.{model,rule} = إحصائيات «المدير الموديل» مقابل «المدير القاعدة»، مو إعدادات موديل
function walkKeys(o, out = new Set(), parent = '') {
  if (Array.isArray(o)) o.forEach(x => walkKeys(x, out, parent));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (parent !== 'chairs') out.add(k); walkKeys(v, out, k); }
  return out;
}

test('/view and /api/public/overview open without a password and leak no secret', async () => {
  const page = await fetch(`${base}/view`);
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.match(html, /وضع المشاهدة/);
  assert.strictEqual(html, fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), 'same page, read-only mode is chosen by the path');

  const r = await fetch(`${base}/api/public/overview`);
  assert.strictEqual(r.status, 200);
  const raw = await r.text();
  for (const [name, v] of Object.entries(SECRETS)) assert.ok(!raw.includes(v), `${name} leaked`);
  assert.ok(!raw.includes('qwen/secret-model'), 'model config leaked');
  const body = JSON.parse(raw);
  const keys = walkKeys(body);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `field "${k}" must not be public`);
  assert.deepStrictEqual(body.keys, {});
  for (const b of Object.values(body.bots)) {
    assert.ok(!('model' in b.def) && !('source' in b.def), 'bot def without model/source');
    assert.deepStrictEqual(Object.keys(b.system), ['lastRun']);
  }
  assert.strictEqual(body.view, true);
  // اللي يحتاجه المشاهد موجود
  assert.ok(body.leaderboard.length > 20 && 'winRatePct' in body.leaderboard[0]);
  assert.ok(body.bots['now-qwen'].decisions.length > 0 && body.bots['code-bollinger'].trades);
  assert.ok('ai' in body && 'regime' in body && 'competition' in body);
  assert.deepStrictEqual(Object.keys(body.competition).sort(), ['locked', 'startedAt']);
});

test('every write route and the owner data still need the owner password', async () => {
  const routes = [
    ['POST', '/api/rules'], ['POST', '/api/competition/start'], ['POST', '/api/competition/reset'],
    ['POST', '/api/bots/now-qwen/trades/x/close'], ['POST', '/api/bots/now-qwen/resume'], ['POST', '/api/news/refresh'],
    ['POST', '/api/demo/cycle'], ['GET', '/api/state'], ['GET', '/api/export'], ['GET', '/'],
    ['POST', '/api/public/overview'], ['POST', '/view'],
  ];
  for (const [method, url] of routes) {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ confirm: 'RESET' }) : undefined });
    assert.strictEqual(r.status, 401, `${method} ${url}`);
  }
  assert.strictEqual(S.state().competition.locked !== undefined, true);
});

test('owner dashboard unchanged: / and /api/state work with the password and still carry the owner fields', async () => {
  const page = await fetch(`${base}/`, { headers: owner });
  assert.strictEqual(page.status, 200);
  assert.strictEqual(await page.text(), fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'));
  const st = await (await fetch(`${base}/api/state`, { headers: owner })).json();
  assert.ok(st.keys && 'openrouter' in st.keys && st.models && st.fable, 'owner view keeps its full data');
});

test('free text is cleaned of anything that looks like a key or private link', () => {
  const s = redact(`a ${SECRETS.OPENROUTER_API_KEY} b 123456789:AAFabcdefghijklmnopqrstuvwxyz123 c https://m.up.railway.app/mcp/abcdef12 d ghp_abcdefghijklmnop`);
  assert.doesNotMatch(s, /sk-or|AAFabc|railway|mcp\/abc|ghp_/);
  assert.strictEqual(redact('البتكوين فوق متوسط 200 (73,030)'), 'البتكوين فوق متوسط 200 (73,030)');
});

test('rate limit: 60 requests a minute per IP, then 429 until the window ends', () => {
  let t = 0;
  const lim = rateLimiter({ limit: 60, windowMs: 60_000, now: () => t });
  const run = ip => { let code = 200; lim({ headers: { 'x-forwarded-for': ip }, socket: {} }, { setHeader() {}, status(c) { code = c; return { json() {} }; } }, () => {}); return code; };
  for (let i = 0; i < 60; i++) assert.strictEqual(run('1.1.1.1'), 200);
  assert.strictEqual(run('1.1.1.1'), 429);
  assert.strictEqual(run('2.2.2.2'), 200, 'other visitors are not blocked');
  t = 60_000;
  assert.strictEqual(run('1.1.1.1'), 200, 'new window');
});
