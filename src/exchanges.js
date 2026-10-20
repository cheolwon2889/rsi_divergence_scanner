'use strict';

// ===========================================================================
//  거래소 공개 API (키 불필요, 조회 전용)
//
//  기본은 Gate.io 선물이다. Render 무료 서버가 미국(오레곤)이라 바이낸스는
//  지역 차단(HTTP 451)에 걸릴 수 있어서, 그쪽에서 이미 동작을 확인한 Gate 를
//  기본으로 했다. 로컬이나 차단 없는 지역에서는 EXCHANGE=binance 로 바꿀 수 있다.
//
//  공통 형태
//    listMarkets() -> [{ symbol, base, last, change24h(%), quoteVolume(USDT) }]
//    candles(symbol, tf, limit) -> [{ t(초), o, h, l, c, v }]  오름차순, 진행 중인 봉 포함
// ===========================================================================

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d'];
const TF_SECONDS = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 429/5xx 에서는 잠깐 쉬고 다시 시도한다. 그 밖의 오류는 바로 던진다. */
async function getJson(url, { retries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'rsi-divergence-scanner' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 800 * 2 ** attempt;
        lastErr = new Error(`HTTP ${res.status}`);
        lastErr.status = res.status;
        await sleep(Math.min(wait, 8000));
        continue;
      }
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
        e.status = res.status;
        throw e;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500 && e.status !== 429) throw e;   // 재시도해도 소용없는 오류
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// ------------------------------------------------------------------- Gate
const GATE = 'https://api.gateio.ws/api/v4/futures/usdt';

const gate = {
  name: 'gate',
  label: 'Gate.io 선물',
  requestGapMs: 110,          // 공개 선물 API 한도(10초당 200건)보다 넉넉히 느리게
  async listMarkets() {
    const rows = await getJson(`${GATE}/tickers`);
    return rows
      .filter(r => typeof r.contract === 'string' && r.contract.endsWith('_USDT'))
      .map(r => ({
        symbol: r.contract,
        base: r.contract.replace(/_USDT$/, ''),
        last: Number(r.last),
        change24h: Number(r.change_percentage),
        quoteVolume: Number(r.volume_24h_quote)
      }))
      .filter(m => Number.isFinite(m.last) && Number.isFinite(m.quoteVolume));
  },
  async candles(symbol, tf, limit = 500) {
    const q = new URLSearchParams({ contract: symbol, interval: tf, limit: String(limit) });
    const rows = await getJson(`${GATE}/candlesticks?${q}`);
    return rows.map(k => ({ t: Number(k.t), o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: Number(k.v) }))
      .sort((a, b) => a.t - b.t);
  },
  tradeUrl: (symbol) => `https://www.gate.io/futures/USDT/${encodeURIComponent(symbol)}`
};

// ---------------------------------------------------------------- Binance
const BINANCE = 'https://fapi.binance.com/fapi/v1';

const binance = {
  name: 'binance',
  label: 'Binance 선물',
  requestGapMs: 70,
  async listMarkets() {
    const [info, tick] = await Promise.all([getJson(`${BINANCE}/exchangeInfo`), getJson(`${BINANCE}/ticker/24hr`)]);
    const live = new Set(info.symbols
      .filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map(s => s.symbol));
    return tick
      .filter(t => live.has(t.symbol))
      .map(t => ({
        symbol: t.symbol,
        base: t.symbol.replace(/USDT$/, ''),
        last: Number(t.lastPrice),
        change24h: Number(t.priceChangePercent),
        quoteVolume: Number(t.quoteVolume)
      }));
  },
  async candles(symbol, tf, limit = 499) {   // 499 이하는 요청 가중치가 가장 낮다
    const q = new URLSearchParams({ symbol, interval: tf, limit: String(Math.min(limit, 499)) });
    const rows = await getJson(`${BINANCE}/klines?${q}`);
    return rows.map(k => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  },
  tradeUrl: (symbol) => `https://www.binance.com/en/futures/${encodeURIComponent(symbol)}`
};

const PROVIDERS = { gate, binance };

function getProvider(name) {
  const p = PROVIDERS[String(name || 'gate').toLowerCase()];
  if (!p) throw new Error(`지원하지 않는 거래소입니다: ${name} (gate, binance 중 하나)`);
  return p;
}

module.exports = { getProvider, TIMEFRAMES, TF_SECONDS, sleep };
