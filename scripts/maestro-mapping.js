// ═══════════════════════════════════════════════════════════════════════════
//  يبني خريطة المايسترو من research/regime-matrix.json (2021–2024 بس) بقاعدة
//  ثابتة مكتوبة قبل، ويجمّدها في ملف نسخة جديد research/maestro-mapping-vN.json.
//  ما يكتب فوق نسخة موجودة. استراتيجية جديدة لاحقاً: ضيفها لـ research/regimes.js،
//  شغّله من جديد، وبعدين هالسكربت يطلع النسخة اللي بعدها (والسيرفر ما يتغير إلا
//  إذا تغيّر اسم الملف في lib/maestro.js).
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const RULE = { minPF: 1.2, minTrades: 30, minPnlUSD: 0, period: '2021-01-01 → 2024-12-31' };
const BUCKETS = ['bull', 'correction', 'bear', 'choppy'];
// المرشحين: استراتيجيات كل عملة لحالها على 4 ساعات (بدون التدوير الأسبوعي والشراء الدوري)
const CANDIDATES = ['code-breakout-btc', 'code-breakout-nobtc', 'code-pullback', 'code-bollinger',
  'strat-fable', 'strat-gpt', 'strat-qwen', 'strat-deepseek', 'fable-discovery'];

const RESEARCH = path.join(__dirname, '..', 'research');
const matrix = JSON.parse(fs.readFileSync(path.join(RESEARCH, 'regime-matrix.json'), 'utf-8'));

const qualifies = x => x && x.trades >= RULE.minTrades && x.pf != null && x.pf >= RULE.minPF && x.pnlUSD > RULE.minPnlUSD;
const on = {}, detail = {};
for (const b of BUCKETS) {
  const rows = CANDIDATES.filter(c => matrix.contestants[c]).map(c => ({ contestant: c, strategy: matrix.contestants[c].strategy, ...matrix.contestants[c].byRegime[b] }));
  const ok = rows.filter(qualifies).sort((a, z) => z.pf - a.pf);   // الأعلى معامل ربح أول (لو اثنين بنفس العملة)
  on[b] = ok.map(r => r.strategy);
  detail[b] = ok.map(r => ({ contestant: r.contestant, strategy: r.strategy, pf: r.pf, trades: r.trades, returnPct: r.returnPct }));
}

let n = 1;
while (fs.existsSync(path.join(RESEARCH, `maestro-mapping-v${n}.json`))) n++;
const out = {
  version: `v${n}`, frozen: true, createdAt: new Date().toISOString(),
  rule: RULE, candidates: CANDIDATES, sourceMatrixGeneratedAt: matrix.generatedAt,
  on, detail,
};
fs.writeFileSync(path.join(RESEARCH, `maestro-mapping-v${n}.json`), JSON.stringify(out, null, 2) + '\n', { flag: 'wx' });
console.log(`wrote research/maestro-mapping-v${n}.json`);
for (const b of BUCKETS) console.log(b.padEnd(11), detail[b].map(d => `${d.contestant} (PF ${d.pf}, ${d.trades})`).join(', ') || 'كاش');
