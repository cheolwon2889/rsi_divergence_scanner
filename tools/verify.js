'use strict';

// 구현 코드(src/rsi.js)를 가져다 쓰지 않고 정의만으로 다시 확인하는 독립 검증기.
// 단위 테스트와 실제 거래소 데이터 점검(tools/live-check.js)이 같이 쓴다.
const { DEFAULTS } = require('../src/rsi');

/** 구현과 다른 방식으로 짠 RSI. 이득/손실 배열을 먼저 만들고 재귀로 이어간다. */
function naiveRsi(closes, period) {
  const g = [0], l = [0];
  for (let i = 1; i < closes.length; i++) {
    g.push(Math.max(closes[i] - closes[i - 1], 0));
    l.push(Math.max(closes[i - 1] - closes[i], 0));
  }
  const out = closes.map(() => NaN);
  let ag = g.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  let al = l.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  const fin = () => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
  out[period] = fin();
  for (let i = period + 1; i < closes.length; i++) {
    ag = (ag * (period - 1) + g[i]) / period;
    al = (al * (period - 1) + l[i]) / period;
    out[i] = fin();
  }
  return out;
}

/** 일부러 구현 코드를 가져다 쓰지 않고 정의만으로 다시 확인하는 검증기. */
function verify(d, candles, o = DEFAULTS) {
  const n = candles.length;
  const r = naiveRsi(candles.map(c => c.c), o.period);
  const { p1, p2 } = d;
  const errs = [];
  const bull = d.side === 'bull';

  if (!(p1.ri < p2.ri)) errs.push('p1 이 p2 보다 앞이어야 함');
  const gap = p2.ri - p1.ri;
  if (gap < o.minGap || gap > o.maxGap) errs.push(`gap ${gap} 범위 밖`);
  if (d.ageBars !== n - 1 - p2.ri) errs.push('ageBars 불일치');
  if (d.ageBars > o.maxAge) errs.push('너무 오래된 신호');

  // 가격/RSI 값이 실제 배열과 같은지
  if (Math.abs(p1.rsi - r[p1.ri]) > 1e-9 || Math.abs(p2.rsi - r[p2.ri]) > 1e-9) errs.push('RSI 값 불일치');
  const px = (p, i) => (bull ? candles[i].l : candles[i].h);
  if (px(p1, p1.pi) !== p1.price || px(p2, p2.pi) !== p2.price) errs.push('가격 값 불일치');

  // 피벗 가격이 정말 근처에서 가장 낮은/높은 값인지
  for (const p of [p1, p2]) {
    for (let k = Math.max(0, p.ri - o.priceWin); k <= Math.min(n - 1, p.ri + o.priceWin); k++) {
      if (bull ? candles[k].l < p.price : candles[k].h > p.price) errs.push('피벗 가격이 극값이 아님');
    }
  }

  // 방향 정의
  const priceUp = p2.price > p1.price, rsiUp = p2.rsi > p1.rsi;
  if (priceUp === rsiUp) errs.push('가격과 RSI 방향이 같음');
  const expectKind = bull ? (priceUp ? 'hidden' : 'regular') : (priceUp ? 'regular' : 'hidden');
  if (d.kind !== expectKind) errs.push(`종류 불일치 ${d.kind} != ${expectKind}`);

  // 임계값
  if (Math.abs(p2.rsi - p1.rsi) < o.minRsiDiff) errs.push('RSI 차이가 임계값 미만');
  if (Math.abs(p2.price - p1.price) / p1.price * 100 < o.minPricePct) errs.push('가격 차이가 임계값 미만');

  // RSI 피벗 조건: 좌 lbL 봉보다 낮고(높고) 우 right 봉 이상
  for (const p of [p1, p2]) {
    for (let k = p.ri - o.lbL; k < p.ri; k++) if (bull ? !(r[k] > r[p.ri]) : !(r[k] < r[p.ri])) errs.push('왼쪽 피벗 조건 위반');
    const right = Math.min(n - 1 - p.ri, o.lbR);
    for (let k = p.ri + 1; k <= p.ri + right; k++) if (bull ? !(r[k] >= r[p.ri]) : !(r[k] <= r[p.ri])) errs.push('오른쪽 피벗 조건 위반');
  }
  const confirmed = n - 1 - p2.ri >= o.lbR;
  if ((d.status === 'confirmed') !== confirmed) errs.push('상태(확정/형성중) 불일치');

  // 연결선을 사이 봉이 뚫지 않는지
  for (let k = p1.ri + 1; k < p2.ri; k++) {
    const line = p1.rsi + (p2.rsi - p1.rsi) * (k - p1.ri) / (p2.ri - p1.ri);
    if (bull ? r[k] < line - o.tolRsi : r[k] > line + o.tolRsi) errs.push('RSI 연결선 위반');
  }
  for (let k = p1.pi + 1; k < p2.pi; k++) {
    const line = p1.price + (p2.price - p1.price) * (k - p1.pi) / (p2.pi - p1.pi);
    if (bull ? candles[k].l < line * (1 - o.tolPrice) : candles[k].h > line * (1 + o.tolPrice)) errs.push('가격 연결선 위반');
  }

  // 이후에 깨지지 않았는지
  for (let k = p2.pi + 1; k < n; k++) if (bull ? candles[k].l < p2.price : candles[k].h > p2.price) errs.push('이후 가격이 피벗을 넘음');
  for (let k = p2.ri + 1; k < n; k++) if (bull ? r[k] < p2.rsi : r[k] > p2.rsi) errs.push('이후 RSI 가 피벗을 넘음');
  return errs;
}

module.exports = { naiveRsi, verify };
