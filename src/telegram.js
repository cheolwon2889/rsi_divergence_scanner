'use strict';

// ===========================================================================
//  텔레그램 발송
//
//  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID 가 없으면 보내지 않고 로그에만 남긴다.
//  토큰은 주소에 들어가므로 오류를 찍을 때도 주소는 남기지 않는다.
//  같은 채팅방에는 초당 1건 정도가 한도라서 한 줄로 세워서 보낸다.
// ===========================================================================

const GAP_MS = 1100;

function createTelegram({ token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID } = {}) {
  const enabled = Boolean(token && chatId);
  let chain = Promise.resolve();
  let sent = 0;
  let failed = 0;

  async function post(text) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15000)
      });
      if (res.ok) { sent++; return true; }
      failed++;
      const body = await res.json().catch(() => ({}));
      console.warn(`[telegram] 발송 실패 HTTP ${res.status} ${body.description || ''}`);
    } catch (e) {
      failed++;
      console.warn('[telegram] 발송 실패:', e.name === 'TimeoutError' ? '시간 초과' : e.message.replace(token, '***'));
    }
    return false;
  }

  function send(text) {
    if (!enabled) {
      console.log('[telegram 미설정 — 보내지 않음]\n' + text);
      return Promise.resolve(false);
    }
    const p = chain.then(() => post(text)).then(async (ok) => { await new Promise(r => setTimeout(r, GAP_MS)); return ok; });
    chain = p.catch(() => {});
    return p;
  }

  return { send, enabled, stats: () => ({ enabled, sent, failed }) };
}

module.exports = { createTelegram };
