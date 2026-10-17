// ═══════════════════════════════════════════════════════════════════════════
//  يطلب من 4 نماذج كتابة استراتيجية (مرة وحدة بس) ويحفظها في strategies/<id>.json
//  الملفات مجمّدة: السكربت يرفض يشتغل إذا فيه أي ملف موجود، وما فيه خيار للكتابة فوقها.
//
//  node scripts/generate-strategies.js --rules <rules.json>
//  المفتاح: OPENROUTER_API_KEY من البيئة أو من keys.env (ما ينطبع أبداً)
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { validate } = require('../lib/strategy-spec');
const { buildPrompt, retryPrompt, parseAnswer } = require('./strategy-prompt');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'strategies');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const CONTESTANTS = [
  { id: 'strat-fable', name: 'استراتيجية Fable', via: 'claude', model: 'claude-fable-5-1' },
  { id: 'strat-gpt', name: 'استراتيجية GPT', via: 'openrouter', model: 'openai/gpt-6.1-sol-pro', fallback: 'openai/gpt-6.1-sol' },
  { id: 'strat-qwen', name: 'استراتيجية Qwen', via: 'openrouter', model: process.env.QWEN_MODEL || 'qwen/qwen3.8-max-prime' },
  { id: 'strat-deepseek', name: 'استراتيجية DeepSeek', via: 'openrouter', model: process.env.DEEPSEEK_MODEL || '~deepseek/deepseek-pro-latest' },
];

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  for (const f of [path.join(ROOT, '..', 'secrets', 'keys.env'), path.join(ROOT, 'keys.env')]) {   // Mihak/secrets أول
    if (!fs.existsSync(f)) continue;
    const line = fs.readFileSync(f, 'utf-8').split(/\r?\n/).find(l => l.startsWith('OPENROUTER_API_KEY='));
    if (line) return line.slice('OPENROUTER_API_KEY='.length).trim();
  }
  throw new Error('OPENROUTER_API_KEY not found');
}

async function openrouter(key, model, messages) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 16000, reasoning: { effort: 'high', exclude: true }, usage: { include: true } }),
    signal: AbortSignal.timeout(900_000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`${model}: HTTP ${res.status} ${String(j.error?.message || '').slice(0, 200)}`);
  return { text: j.choices?.[0]?.message?.content || '', modelUsed: j.model || model, costUSD: Number(j.usage?.cost) || 0, usage: j.usage || null };
}

// claude.exe اللي مع تطبيق Claude (نفس طريقة runner/fable-runner.js)
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code');
  const ver = v => v.split('.').map(Number);
  const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
  try {
    for (const v of fs.readdirSync(root).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort(newer))
      for (const h of fs.readdirSync(path.join(root, v))) { const exe = path.join(root, v, h, 'claude.exe'); if (fs.existsSync(exe)) return exe; }
  } catch { /* PATH */ }
  return 'claude';
}

function claude(model, prompt) {
  return new Promise((resolve, reject) => {
    const work = path.join(os.tmpdir(), 'mihak-strategy-gen');
    fs.mkdirSync(work, { recursive: true });
    const args = ['-p', '--model', model, '--effort', 'high', '--output-format', 'json', '--tools', '',
      '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', 'Follow the user\'s instructions exactly.'];
    const child = spawn(findClaude(), args, { cwd: work, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timeout')); }, 900_000);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', () => {
      clearTimeout(timer);
      let r; try { r = JSON.parse(out); } catch { return reject(new Error(`claude: ${(err || out).slice(0, 200)}`)); }
      if (r.is_error) return reject(new Error(`claude: ${String(r.result).slice(0, 200)}`));
      resolve({ text: r.result, modelUsed: Object.keys(r.modelUsage || {})[0] || model, costUSD: 0, notionalUSD: r.total_cost_usd ?? null, usage: r.usage || null });
    });
    child.stdin.end(prompt);
  });
}

async function generate(c, prompt, key) {
  const attempts = [];
  let model = c.model;
  const ask = async messages => {
    if (c.via === 'claude') {
      // claude -p ما يحفظ جلسة، فالمحاولة الثانية = الطلب + الرد الأول + الأخطاء في رسالة وحدة
      const flat = messages.map(m => (m.role === 'user' ? m.content : `--- your previous reply ---\n${m.content}\n--- end ---`)).join('\n\n');
      return claude(model, flat);
    }
    try { return await openrouter(key, model, messages); }
    catch (e) {
      if (!c.fallback || model === c.fallback) throw e;
      attempts.push({ model, error: e.message });
      model = c.fallback;
      return openrouter(key, model, messages);
    }
  };
  const messages = [{ role: 'user', content: prompt }];
  let parsed, check;
  for (let n = 1; n <= 2; n++) {
    const r = await ask(messages);
    parsed = parseAnswer(r.text);
    check = parsed.spec ? validate(parsed.spec) : { ok: false, errors: [parsed.parseError || 'no SPEC section'] };
    attempts.push({ model, modelUsed: r.modelUsed, costUSD: r.costUSD, notionalUSD: r.notionalUSD ?? null, usage: r.usage, raw: r.text, valid: check.ok, errors: check.errors });
    if (check.ok || n === 2) break;
    messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: retryPrompt(check.errors) });
  }
  const last = attempts.at(-1);
  return {
    id: c.id, name: c.name, frozen: true,
    generatedAt: new Date().toISOString(),
    modelRequested: c.model, modelUsed: last.modelUsed || last.model,
    valid: check.ok, errors: check.ok ? [] : check.errors,
    idea: parsed.idea, loses: parsed.loses, spec: check.ok ? parsed.spec : parsed.spec ?? null,
    costUSD: attempts.reduce((s, a) => s + (a.costUSD || 0), 0),
    notionalUSD: c.via === 'claude' ? attempts.reduce((s, a) => s + (a.notionalUSD || 0), 0) : null,
    promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
    attempts,
  };
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const existing = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  if (existing.length) throw new Error(`strategies/ already has ${existing.join(', ')} — they are frozen, refusing to regenerate`);
  const i = process.argv.indexOf('--rules');
  if (i < 0) throw new Error('--rules <file> required (the live rules)');
  const rules = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf-8'));
  const prompt = buildPrompt(rules);
  fs.writeFileSync(path.join(DIR, 'PROMPT.md'), prompt + '\n');
  const key = readKey();
  // كل نموذج لحاله وبنفس الوقت: ما يشوف رد غيره
  const results = await Promise.all(CONTESTANTS.map(c => generate(c, prompt, key).catch(e => ({
    id: c.id, name: c.name, frozen: true, generatedAt: new Date().toISOString(), modelRequested: c.model, modelUsed: null,
    valid: false, errors: [e.message], idea: '', loses: '', spec: null, costUSD: 0, attempts: [],
  }))));
  for (const r of results) {
    fs.writeFileSync(path.join(DIR, `${r.id}.json`), JSON.stringify(r, null, 2) + '\n', { flag: 'wx' });   // wx: ما يكتب فوق ملف موجود
    console.log(`${r.id.padEnd(15)} ${r.valid ? 'VALID  ' : 'INVALID'} ${String(r.modelUsed).padEnd(34)} attempts ${r.attempts.length}  $${r.costUSD.toFixed(4)}${r.notionalUSD != null ? ` (subscription, API-equivalent $${r.notionalUSD.toFixed(4)})` : ''}${r.valid ? '' : '  ' + r.errors.join(' | ').slice(0, 200)}`);
  }
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { CONTESTANTS };
