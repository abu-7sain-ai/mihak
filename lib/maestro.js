// ═══════════════════════════════════════════════════════════════════════════
//  المايسترو: يشغّل في كل حالة سوق الاستراتيجيات اللي نجحت فيها (2021–2024 بس)
//  حسب خريطة مجمّدة (research/maestro-mapping-vN.json). نفس الكائن للاختبار وللسيرفر.
//  - الحالة لكل شمعة = اللي كانت معروفة وقت إغلاقها (lib/regime.js: bucketsFor)
//  - الدخول: أول استراتيجية "شغّالة" بهالحالة تعطي إشارة (بترتيب الخريطة)
//  - كل صفقة تتذكر الاستراتيجية اللي فتحتها وتطلع بقوانينها هي (وقفها وخروجها ومدتها)،
//    حتى لو الحالة تغيّرت (بس ما يدخل صفقات جديدة بالاستراتيجيات المطفية)
//  - إذا ولا استراتيجية مؤهلة بالحالة: كاش
// ═══════════════════════════════════════════════════════════════════════════
const { bucketsFor } = require('./regime');

const H4 = 4 * 3_600_000;
// الخريطة اللي يستخدمها السيرفر والاختبار (نسخة مجمّدة؛ نسخة جديدة = ملف جديد واسم جديد هني)
const MAESTRO_MAPPING = 'research/maestro-mapping-v1.json';

function buildMaestro(mapping, byId) {
  const buckets = Object.keys(mapping.on);
  const ids = [...new Set(buckets.flatMap(b => mapping.on[b]))];
  for (const id of ids) {
    if (!byId[id]) throw new Error(`maestro: unknown strategy ${id}`);
    if (byId[id].tf !== '4h' || byId[id].rank) throw new Error(`maestro: ${id} must be a per-coin 4h strategy`);
  }
  const subs = ids.map(id => byId[id]);
  const idx = Object.fromEntries(ids.map((id, k) => [id, k]));
  const uses = [...new Set(['btc1d', ...subs.flatMap(s => s.uses || [])])];
  const subOf = (S, pos) => (pos.sub != null ? idx[pos.sub] : S.pickAt[pos.idx - 1]);

  return {
    id: 'maestro', tf: '4h', name: `Maestro (${mapping.version})`, nameAr: 'المايسترو', uses, mapping,
    prepare(c, ctx) {
      return { c, subsS: subs.map(s => s.prepare(c, ctx)), bucket: bucketsFor(c, H4, ctx.btc1d), pickAt: [] };
    },
    activeAt: (S, i) => mapping.on[S.bucket[i]] || [],
    entry(S, i) {
      for (const id of mapping.on[S.bucket[i]] || []) {
        const k = idx[id];
        if (subs[k].entry(S.subsS[k], i)) { S.pickAt[i] = k; return true; }
      }
      return false;
    },
    initialStop: (S, i) => subs[S.pickAt[i]].initialStop(S.subsS[S.pickAt[i]], i),
    subIdAt: (S, i) => ids[S.pickAt[i]],
    holdBarsAt: (S, i) => subs[S.pickAt[i]].maxHoldBars ?? null,
    exit(S, i, pos) {
      const k = subOf(S, pos);
      const s = subs[k];
      // في الاختبار: المدة القصوى للاستراتيجية نفسها بعدد الشموع (في الحي: حد الوقت على الصفقة)
      if (s.maxHoldBars && pos.idx != null && i - pos.idx + 1 >= s.maxHoldBars) return true;
      return s.exit(S.subsS[k], i, pos);
    },
    trail(S, i, pos) {
      const k = subOf(S, pos);
      return subs[k].trail(S.subsS[k], i, pos);
    },
  };
}

module.exports = { buildMaestro, MAESTRO_MAPPING };
