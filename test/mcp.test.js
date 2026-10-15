const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.MCP_SECRET = 'test-mcp-secret';
process.env.DASHBOARD_PASSWORD = 'test-dash';
process.env.DB_FILE = path.join(os.tmpdir(), `mihak-mcp-test-${process.pid}.json`);
const { app, _internals: S } = require('../server');

let srv, base;
test.before(async () => {
  S.setMarket({ unsubscribe() {}, subscribe() {}, price: async () => 100 });
  srv = http.createServer(app);
  await new Promise(r => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(() => { srv.closeAllConnections(); srv.close(); });

let nextId = 1;
const rpc = (method, params, secret = 'test-mcp-secret') =>
  fetch(`${base}/mcp/${secret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
const call = async (name, args = {}) => {
  const r = await (await rpc('tools/call', { name, arguments: args })).json();
  return { isError: r.result.isError, data: JSON.parse(r.result.content[0].text) };
};

test('wrong secret is 404, and the dashboard password still guards the rest', async () => {
  assert.strictEqual((await rpc('ping', {}, 'nope')).status, 404);
  assert.strictEqual((await fetch(`${base}/api/state`)).status, 401);
  assert.strictEqual((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
});

test('initialize, notifications and tools/list follow MCP', async () => {
  const init = await (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).json();
  assert.strictEqual(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const note = await fetch(`${base}/mcp/test-mcp-secret`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.strictEqual(note.status, 202);
  const list = await (await rpc('tools/list', {})).json();
  const names = list.result.tools.map(t => t.name);
  for (const n of ['get_overview', 'get_trades', 'get_opportunities', 'get_meetings', 'set_rules', 'resume_bot', 'refresh_news', 'start_competition', 'reset_competition'])
    assert.ok(names.includes(n), n);
});

test('read tools return data', async () => {
  const o = await call('get_overview');
  assert.strictEqual(o.isError, false);
  assert.strictEqual(o.data.leaderboard.length, 17);
  assert.strictEqual(o.data.fable.rounds, 0);
  const r = await call('get_rules');
  assert.strictEqual(r.data.locked, false);
});

test('write tools validate, and start/reset need their confirm word', async () => {
  const bad = await call('set_rules', { rules: { minConfidence: 500 } });
  assert.strictEqual(bad.isError, true);
  const good = await call('set_rules', { rules: { minConfidence: 55 } });
  assert.strictEqual(good.data.rules.minConfidence, 55);
  assert.strictEqual((await call('start_competition', { confirm: 'yes' })).isError, true);
  assert.strictEqual(S.state().competition.locked, false);
  assert.strictEqual((await call('resume_bot', { bot_id: 'now-qwen' })).data.success, true);
});
