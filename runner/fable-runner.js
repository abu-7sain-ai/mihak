// ═══════════════════════════════════════════════════════════════════════════
//  كشّاف Fable على جهاز المالك
//  كل ربع ساعة (بعد بداية الجولة بدقيقة): ياخذ لقطة الجولة من السيرفر، يبني نفس
//  طلب الكشّافين، يسأل Fable عن طريق Claude Code (اشتراك المالك)، ويرسل القرار.
//  السجل: runner/fable-runner.log (سطر JSON لكل تشغيل، بدون أسرار)
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ai = require('../lib/ai');

const HERE = __dirname;
const LOG = path.join(HERE, 'fable-runner.log');
const LOCK = path.join(HERE, '.fable-runner.lock');
const WORK = path.join(HERE, 'work');              // مجلد فاضي: Claude Code ما يقرا أي ملفات مشروع
const BASE = (process.env.MIHAK_URL || 'https://mihak-production.up.railway.app').replace(/\/$/, '');
const MODEL = process.env.FABLE_MODEL || 'fable';
const EFFORT = process.env.FABLE_EFFORT || 'low';  // نفس "تفكير قليل" اللي ياخذه الكشّافين على السيرفر
const SYSTEM = 'Follow the user\'s instructions exactly.';

const run = { at: new Date().toISOString(), steps: [] };
const step = s => run.steps.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function writeLog() {
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, LOG + '.old');
    fs.appendFileSync(LOG, JSON.stringify(run) + '\n');
  } catch { /* السجل ما يوقف التشغيل */ }
}

// السر من متغير البيئة، أو MCP_SECRET من keys.env: أول شي Mihak/secrets (جنب app)، وبعدين جنب المشروع
function readSecret() {
  if (process.env.MIHAK_SECRET) return process.env.MIHAK_SECRET;
  const file = [path.join(HERE, '..', '..', 'secrets', 'keys.env'), path.join(HERE, '..', 'keys.env')].find(f => fs.existsSync(f));
  if (!file) throw new Error('keys.env مو موجود (Mihak/secrets أو جنب المشروع)');
  const line = fs.readFileSync(file, 'utf-8').split(/\r?\n/).find(l => l.startsWith('MCP_SECRET='));
  if (!line) throw new Error('MCP_SECRET مو موجود في keys.env');
  return line.slice('MCP_SECRET='.length).trim();
}

// claude.exe اللي مع تطبيق Claude (أحدث نسخة)، أو CLAUDE_BIN، أو claude من PATH
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const root = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code');
  const ver = v => v.split('.').map(Number);
  const newer = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
  try {
    for (const v of fs.readdirSync(root).filter(d => /^\d+\.\d+\.\d+$/.test(d)).sort(newer)) {
      for (const h of fs.readdirSync(path.join(root, v))) {
        const exe = path.join(root, v, h, 'claude.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* نجرب PATH */ }
  return 'claude';
}

async function api(method, route, secret, body) {
  const r = await fetch(BASE + route, {
    method,
    headers: { 'x-mihak-secret': secret, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json };
}

function askClaude(bin, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(WORK, { recursive: true });
    const args = ['-p', '--model', MODEL, '--effort', EFFORT, '--output-format', 'json', '--tools', '',
      '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--system-prompt', SYSTEM];
    const child = spawn(bin, args, { cwd: WORK, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude ما رد خلال ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let res;
      try { res = JSON.parse(out); } catch { return reject(new Error(`claude خرج ${code}: ${(err || out).slice(0, 200)}`)); }
      if (res.is_error) return reject(new Error(`claude: ${String(res.result || res.terminal_reason).slice(0, 200)}`));
      resolve(res);
    });
    child.stdin.end(prompt);
  });
}

async function main() {
  // تشغيل وحد بس بنفس الوقت
  try {
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age < 10 * 60_000) { run.result = 'skipped: another run is active'; return; }
  } catch { /* ما فيه قفل */ }
  fs.writeFileSync(LOCK, String(process.pid));

  try {
    const secret = readSecret();
    // ننتظر الجولة تنفتح (السيرفر يجيب الأخبار واللقطة أول)
    let round, giveUp = Date.now() + 4 * 60_000;
    for (;;) {
      const r = await api('GET', '/api/fable/round', secret).catch(e => ({ status: 0, error: e.message }));
      if (r.status === 404) throw new Error('السيرفر رفض السر (404)');
      const j = r.json;
      if (j && j.status === 'paused') { run.result = 'paused (aiPaused) — claude not called'; return; }
      const fresh = j && j.openedAt && Date.now() - j.openedAt < 10 * 60_000;
      if (j && fresh && j.status === 'waiting') { round = j; break; }
      if (j && fresh && j.status !== 'waiting') { run.result = `round already ${j.status}`; run.roundId = j.roundId; return; }
      step(`no open round yet (http ${r.status}${r.error ? ' ' + r.error : ''}, status ${j?.status ?? '-'})`);
      if (Date.now() > giveUp) { run.result = 'no round opened'; return; }
      await sleep(15_000);
    }
    run.roundId = round.roundId;
    run.round = new Date(round.roundId).toISOString();
    step(`round open, ${Math.round((round.deadline - round.now) / 1000)}s left`);

    // نفس الطلب اللي يبنيه السيرفر. لو اختلف (نسخة قديمة على الجهاز)، نستخدم نسخة السيرفر
    const local = ai.decisionPrompt({ news: round.news, market: round.snapshot, held: round.held, rules: round.rules });
    run.promptMatchesServer = local === round.prompt;
    const prompt = run.promptMatchesServer ? local : round.prompt;

    const bin = findClaude();
    run.claude = path.basename(path.dirname(path.dirname(bin))) || bin;
    let res, lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const left = round.deadline - Date.now() - 20_000;   // نخلي وقت للإرسال
      if (left < 30_000) break;
      try {
        res = await askClaude(bin, prompt, Math.min(left, 200_000));
        ai.parseDecision(res.result, round.allowed);        // نتأكد قبل ما نرسل
        break;
      } catch (e) {
        lastErr = e; res = null;
        step(`attempt ${attempt} failed: ${e.message.slice(0, 160)}`);
        await sleep(10_000);
      }
    }
    if (!res) throw lastErr || new Error('ما بقى وقت قبل المهلة');

    const u = res.usage || {};
    const usage = {
      inputTokens: u.input_tokens ?? null, outputTokens: u.output_tokens ?? null,
      cacheReadTokens: u.cache_read_input_tokens ?? null, cacheCreationTokens: u.cache_creation_input_tokens ?? null,
      notionalUSD: res.total_cost_usd ?? null, durationMs: res.duration_ms ?? null,
    };
    const model = Object.keys(res.modelUsage || {})[0] || MODEL;
    Object.assign(run, { model, usage, reply: String(res.result).slice(0, 300) });

    const sent = await api('POST', '/api/fable/decision', secret, { roundId: round.roundId, text: res.result, model, usage });
    run.post = { status: sent.status, ...(sent.json || {}) };
    run.result = sent.status === 200 ? 'decision accepted' : 'decision rejected';
  } finally {
    try { fs.unlinkSync(LOCK); } catch { /* ignore */ }
  }
}

main()
  .catch(e => { run.result = 'error'; run.error = String(e.message || e).slice(0, 300); process.exitCode = 1; })
  .finally(writeLog);
