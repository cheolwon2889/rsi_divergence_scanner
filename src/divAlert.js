'use strict';

// ===========================================================================
//  RSI 다이버전스 "확정" 텔레그램 알림
//
//  확정(confirmed) 된 신호가 처음 나타나면 한 번 보낸다. 같은 신호는 다시 보내지 않는다.
//  프로그램을 껐다 켜면 메모리가 비어서 목록이 다시 쌓이는데, 첫 검사 때 이미 있던
//  신호는 알리지 않고 기록만 해서 재시작 때 한꺼번에 울리지 않게 했다.
//  형성 중(forming)은 뒤집힐 수 있어서 보내지 않는다.
// ===========================================================================

const KST_OFFSET_SEC = 9 * 3600;

function fmtPx(p) {
  if (!Number.isFinite(p)) return '-';
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toPrecision(4);
}

function fmtKst(sec) {
  return new Date((sec + KST_OFFSET_SEC) * 1000).toISOString().slice(5, 16).replace('T', ' ');
}

const TF_LABEL = { '5m': '5분봉', '15m': '15분봉', '30m': '30분봉', '1h': '1시간봉', '4h': '4시간봉', '1d': '일봉' };

// 종류·방향별 한 줄 해석
const MEANING = {
  'bull|regular': '가격 저점은 낮아졌는데 RSI 저점은 높아짐 → 하락 힘이 약해짐',
  'bull|hidden': '가격 저점은 높아졌는데 RSI 저점은 낮아짐 → 상승 추세가 이어질 수 있음',
  'bear|regular': '가격 고점은 높아졌는데 RSI 고점은 낮아짐 → 상승 힘이 약해짐',
  'bear|hidden': '가격 고점은 낮아졌는데 RSI 고점은 높아짐 → 하락 추세가 이어질 수 있음'
};

function message(it) {
  const up = it.side === 'bull';
  const head = `${up ? '📈 상승' : '📉 하락'} 다이버전스 확정 · ${TF_LABEL[it.tf] || it.tf}`;
  const kind = it.kind === 'regular' ? '일반' : '히든';
  const zone = it.inZone ? (up ? '과매도권(RSI 30 이하)에서 시작' : '과매수권(RSI 70 이상)에서 시작') : null;
  return [
    head,
    `${it.base}/USDT (Gate 선물)`,
    '',
    `${kind}: ${MEANING[`${it.side}|${it.kind}`]}`,
    '',
    `가격   ${fmtPx(it.p1.price)} → ${fmtPx(it.p2.price)}`,
    `RSI    ${it.p1.rsi.toFixed(1)} → ${it.p2.rsi.toFixed(1)}`,
    `첫 번째 ${up ? '저점' : '고점'}  ${fmtKst(it.p1.rt)} KST`,
    `두 번째 ${up ? '저점' : '고점'}  ${fmtKst(it.p2Time)} KST`,
    `지금 RSI  ${Number.isFinite(it.rsiNow) ? it.rsiNow.toFixed(1) : '-'} · 현재가  ${fmtPx(it.lastClose)}`,
    zone,
    '',
    it.url
  ].filter(l => l !== null).join('\n');
}

/**
 * @param {object} o
 * @param {(text:string)=>Promise<any>} o.notify
 * @param {'all'|'bull'|'bear'} [o.side='all']
 * @param {string[]|null} [o.timeframes=null]  null 이면 검사하는 모든 시간봉
 * @param {number} [o.maxAgeBars=6]  두 번째 피벗이 이보다 오래됐으면 새 확정으로 보지 않는다
 * @param {number} [o.minVolume=0]  24시간 거래대금(USDT)이 이보다 적은 종목은 보내지 않는다
 * @param {(symbol:string)=>number} [o.volumeOf]  종목의 24시간 거래대금을 돌려준다
 * @param {'all'|'regular'|'hidden'} [o.kind='all']
 * @param {boolean} [o.zoneOnly=false]  첫 피벗이 과매도·과매수권(30·70)인 것만 보낸다
 */
function createDivAlerter({ notify, side = 'all', timeframes = null, maxAgeBars = 6, minVolume = 0, volumeOf = () => 0, kind = 'all', zoneOnly = false }) {
  const sent = new Set();
  const seededTf = new Set();

  const keyOf = (it) => `${it.symbol}|${it.tf}|${it.side}|${it.kind}|${it.p2Time}`;

  /** 시간봉 검사가 끝날 때마다 호출된다. */
  function onScan(tf, items) {
    if (timeframes && !timeframes.includes(tf)) return [];
    const firstPass = !seededTf.has(tf);
    seededTf.add(tf);

    const out = [];
    for (const it of items) {
      if (it.status !== 'confirmed' || it.nonCrypto) continue;
      if (side !== 'all' && it.side !== side) continue;
      if (kind !== 'all' && it.kind !== kind) continue;
      if (zoneOnly && !it.inZone) continue;
      if (minVolume && volumeOf(it.symbol) < minVolume) continue;   // 거래량이 얇은 종목은 빠져나가기 어려워서 뺀다
      const k = keyOf(it);
      if (sent.has(k)) continue;
      sent.add(k);
      if (firstPass) continue;                       // 재시작 직후에 이미 있던 신호는 기록만 한다
      if (it.ageBars > maxAgeBars) continue;
      out.push(it);
      Promise.resolve(notify(message(it))).catch(() => {});
    }
    return out;
  }

  return { onScan, message, size: () => sent.size };
}

module.exports = { createDivAlerter, message };
