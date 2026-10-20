'use strict';

// ===========================================================================
//  RSI 다이버전스 스캐너 — 서버
//
//  거래소 공개 시세만 읽는다. API 키가 없고 계정 정보도 다루지 않는다.
//  그래서 로그인은 두지 않았다. 대신 거래소를 직접 호출하게 만드는 /api/chart 에는
//  IP 별 호출 제한을 걸었다. 나머지 API 는 서버 메모리의 결과를 돌려줄 뿐이다.
// ===========================================================================

// .env 로더 (의존성 없이). 이미 들어있는 환경변수(Render 가 넣어준 값)는 덮어쓰지 않는다.
(function loadEnv() {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq < 1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const path = require('node:path');
const express = require('express');
const { getProvider, TIMEFRAMES, TF_SECONDS } = require('./src/exchanges');
const { Scanner } = require('./src/scanner');

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';
const PUBLIC = path.join(__dirname, 'public');

// ------------------------------------------------------------------ 설정
const provider = getProvider(process.env.EXCHANGE || 'gate');

const wantedTfs = String(process.env.TIMEFRAMES || '15m,1h,4h,1d')
  .split(',').map(s => s.trim()).filter(Boolean);
const bad = wantedTfs.filter(t => !TIMEFRAMES.includes(t));
if (bad.length) {
  console.error(`지원하지 않는 시간봉: ${bad.join(', ')} (가능: ${TIMEFRAMES.join(', ')})`);
  process.exit(1);
}
const timeframes = [...new Set(wantedTfs)];

const topN = Math.min(500, Math.max(10, Number(process.env.TOP_N) || 150));
const minVolume = Math.max(0, Number(process.env.MIN_VOLUME) || 1_000_000);

const scanner = new Scanner({ provider, timeframes, topN, minVolume });

// ------------------------------------------------------------------- 앱
const app = express();
app.set('trust proxy', 1);          // Render 프록시 뒤에서 진짜 IP 를 읽기 위해
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // 글꼴만 jsDelivr 에서 받는다. 나머지는 전부 같은 출처.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "font-src 'self' https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'"
  ].join('; '));
  if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// 같은 배포에서 HTML·JS·CSS 가 따로 캐시돼 서로 어긋나지 않게 항상 재검증한다.
const noCache = (res) => res.setHeader('Cache-Control', 'no-cache, must-revalidate');

// -------------------------------------------------------------- 파라미터
const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const flag = (v) => v === '1' || v === 'true';

// ------------------------------------------------------------------- API
app.get('/api/health', (req, res) => res.json({ ok: true, exchange: provider.name, time: Date.now() }));

app.get('/api/status', (req, res) => {
  noCache(res);
  res.json({ ...scanner.status(), now: Date.now() });
});

app.get('/api/divergences', (req, res) => {
  noCache(res);
  const q = req.query;
  const tfs = String(q.tf || timeframes.join(','))
    .split(',').map(s => s.trim()).filter(t => timeframes.includes(t));

  const result = scanner.query({
    tfs: tfs.length ? tfs : timeframes,
    side: oneOf(q.side, ['all', 'bull', 'bear'], 'all'),
    kind: oneOf(q.kind, ['all', 'regular', 'hidden'], 'all'),
    status: oneOf(q.status, ['all', 'confirmed', 'forming'], 'all'),
    maxAge: clampInt(q.maxAge, 1, 120, 40),
    zoneOnly: flag(q.zone),
    includeNonCrypto: flag(q.nonCrypto),
    q: String(q.q || '').slice(0, 20),
    sort: oneOf(q.sort, ['recent', 'rsi', 'volume'], 'recent'),
    limit: clampInt(q.limit, 1, 1000, 500)
  });
  res.json({ ...result, now: Date.now() });
});

// 차트는 거래소를 직접 호출하므로 IP 별로 호출 수를 제한한다.
const hits = new Map();
function chartLimited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || h.reset < now) { h = { n: 0, reset: now + 60_000 }; hits.set(ip, h); }
  h.n++;
  return h.n > 30;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 120_000).unref();

app.get('/api/chart', async (req, res) => {
  noCache(res);
  const symbol = String(req.query.symbol || '');
  const tf = String(req.query.tf || '');
  if (!timeframes.includes(tf)) return res.status(400).json({ error: 'BAD_TF', message: '지원하지 않는 시간봉입니다.' });
  // 목록에 있는 종목만 허용한다. 임의 문자열이 그대로 거래소로 넘어가지 않게.
  if (!scanner.hasSymbol(symbol)) return res.status(404).json({ error: 'NO_SYMBOL', message: '알 수 없는 종목입니다.' });
  if (chartLimited(req.ip)) return res.status(429).json({ error: 'RATE', message: '잠시 후 다시 시도하세요. (분당 30회 제한)' });

  try {
    res.json(await scanner.chart(symbol, tf));
  } catch (e) {
    console.warn('[chart] 실패:', symbol, tf, e.message);
    res.status(502).json({ error: 'UPSTREAM', message: '거래소에서 차트 데이터를 받지 못했습니다.' });
  }
});

// ------------------------------------------------------------------ 정적
const LWC_FILE = path.join(__dirname, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js');
app.get('/vendor/lightweight-charts.js', (req, res) => {
  res.type('application/javascript').sendFile(LWC_FILE, (err) => {
    if (err && !res.headersSent) res.status(500).type('text/plain').send('// lightweight-charts 를 찾지 못했습니다. npm install 을 실행하세요.');
  });
});

app.use(express.static(PUBLIC, { etag: true, maxAge: 0, setHeaders: (res) => noCache(res) }));

app.use('/api', (req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
app.use((err, req, res, next) => {          // eslint-disable-line no-unused-vars
  console.error('[ERROR]', err && err.message);
  res.status(500).json({ error: 'INTERNAL', message: '서버 오류가 발생했습니다.' });
});

// ------------------------------------------------------------------ 기동
app.listen(PORT, () => {
  console.log('='.repeat(62));
  console.log('  RSI 다이버전스 스캐너');
  console.log(`  주소     : http://localhost:${PORT}`);
  console.log(`  거래소   : ${provider.label}`);
  console.log(`  시간봉   : ${timeframes.join(', ')}`);
  console.log(`  검사대상 : 거래대금 상위 ${topN}개 (24h ${minVolume.toLocaleString('en-US')} USDT 이상)`);
  console.log('='.repeat(62));
  scanner.start();
});

module.exports = { app, scanner, TF_SECONDS };
