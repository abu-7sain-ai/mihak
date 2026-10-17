// ═══════════════════════════════════════════════════════════════════════════
//  تنبيهات تيليجرام — sendMessage بس.
//  البوت مشترك مع نظام ثاني: ما نغيّر إعداداته وما نقرا رسائله أبداً.
//  أي خطأ ينمسك هني، فالتنبيه ما يوقف السيرفر. التوكن ما ينطبع.
// ═══════════════════════════════════════════════════════════════════════════
function createTelegram({ token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID, log = console, fetchImpl = globalThis.fetch } = {}) {
  const enabled = !!(token && chatId);
  const hide = s => (token ? String(s).split(token).join('***') : String(s));

  async function sendMessage(text) {
    if (!enabled) return { ok: false, skipped: true };
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        log.err?.(`تيليجرام: ${hide(j.description || res.status)}`);
        return { ok: false, error: hide(j.description || res.status) };
      }
      return { ok: true };
    } catch (e) {
      log.err?.(`تيليجرام: ${hide(e.message)}`);
      return { ok: false, error: hide(e.message) };
    }
  }
  return { enabled, sendMessage };
}

module.exports = { createTelegram };
