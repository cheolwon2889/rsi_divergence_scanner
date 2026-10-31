'use strict';

// 텔레그램 연결 도우미.
//   1) 채팅방 ID 찾기:   TELEGRAM_BOT_TOKEN=... node tools/telegram-setup.js
//      (먼저 텔레그램에서 내 봇에게 아무 메시지나 한 번 보내 둘 것)
//   2) 시험 메시지:      TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node tools/telegram-setup.js test
// .env 파일에 적어 두었다면 환경변수 없이 실행해도 된다.

const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*(TELEGRAM_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error('TELEGRAM_BOT_TOKEN 이 없습니다.'); process.exit(1); }

(async () => {
  if (process.argv[2] === 'test') {
    const { createTelegram } = require('../src/telegram');
    const tg = createTelegram();
    if (!tg.enabled) { console.error('TELEGRAM_CHAT_ID 가 없습니다.'); process.exit(1); }
    const ok = await tg.send('✅ 하모닉 PRZ 알림 연결 시험입니다. 이 메시지가 보이면 설정이 끝난 겁니다.');
    console.log(ok ? '보냈습니다. 텔레그램을 확인하세요.' : '보내지 못했습니다. 위 오류를 확인하세요.');
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const d = await res.json().catch(() => ({}));
  if (!d.ok) { console.error('토큰이 맞지 않거나 요청이 실패했습니다:', d.description || res.status); process.exit(1); }
  const chats = new Map();
  for (const u of d.result) {
    const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (c) chats.set(c.id, c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '');
  }
  if (!chats.size) { console.log('받은 메시지가 없습니다. 텔레그램에서 봇에게 아무 메시지나 보낸 뒤 다시 실행하세요.'); return; }
  console.log('채팅방 ID (TELEGRAM_CHAT_ID 에 넣을 값):');
  for (const [id, name] of chats) console.log(`  ${id}   ${name}`);
})().catch(e => { console.error('실패:', e.message.replace(token, '***')); process.exit(1); });
