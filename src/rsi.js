'use strict';

// ===========================================================================
//  RSI 와 다이버전스 판정 (순수 함수 — 네트워크·시간에 의존하지 않는다)
//
//  입력은 "마감된 봉"만 담긴 배열이다: [{ t(초), o, h, l, c }, ...] 오름차순.
//  진행 중인 봉을 섞으면 RSI 가 봉 마감 때마다 바뀌어 신호가 깜빡이므로
//  호출하는 쪽(scanner.js)이 마감 여부를 걸러서 넘긴다.
//
//  RSI: Wilder 방식. 처음 period 개 변화량의 단순평균으로 시작해서
//       이후 (이전값 × (period-1) + 새값) / period 로 이어간다.
//       TradingView 의 ta.rsi(= RMA 기반)와 같은 계산이다.
//
//  다이버전스 4종
//    상승 일반  가격 저점은 낮아졌는데 RSI 저점은 높아짐   (하락 힘이 약해짐)
//    하락 일반  가격 고점은 높아졌는데 RSI 고점은 낮아짐   (상승 힘이 약해짐)
//    상승 히든  가격 저점은 높아졌는데 RSI 저점은 낮아짐   (상승 추세 지속)
//    하락 히든  가격 고점은 낮아졌는데 RSI 고점은 높아짐   (하락 추세 지속)
//
//  피벗은 RSI 기준으로 잡고(TradingView 내장 RSI Divergence 와 같은 방식),
//  가격은 그 피벗 근처(±priceWin 봉)의 실제 저가/고가를 쓴다. RSI 저점과
//  가격 저점이 한두 봉 어긋나는 일이 흔해서 같은 봉으로 고정하면 놓친다.
// ===========================================================================

const DEFAULTS = Object.freeze({
  period: 14,
  lbL: 5,            // 피벗 왼쪽에서 확인하는 봉 수
  lbR: 5,            // 피벗 오른쪽에서 확인하는 봉 수 (다 채워지면 "확정")
  minRight: 2,       // 형성 중 후보가 최소로 가져야 하는 오른쪽 봉 수
  minGap: 5,         // 두 피벗 사이 최소 봉 수
  maxGap: 60,        // 두 피벗 사이 최대 봉 수
  minRsiDiff: 1.0,   // 두 피벗의 RSI 차이 최소값 (포인트)
  minPricePct: 0.1,  // 두 피벗의 가격 차이 최소값 (%)
  priceWin: 2,       // 가격 극값을 찾는 피벗 주변 봉 수
  tolRsi: 0.3,       // 연결선을 RSI 가 뚫을 수 있는 허용 폭 (포인트)
  tolPrice: 0.0015,  // 연결선을 가격이 뚫을 수 있는 허용 폭 (비율)
  maxAge: 40,        // 두 번째 피벗이 이 봉 수보다 오래되면 버린다
  maxPrev: 4,        // 두 번째 피벗과 짝지어 볼 이전 피벗 수
  zoneLow: 40,       // 상승 다이버전스: 첫 피벗 RSI 가 이 이하면 "과매도권"
  zoneHigh: 60       // 하락 다이버전스: 첫 피벗 RSI 가 이 이상이면 "과매수권"
});

// ------------------------------------------------------------------- RSI
function calcRsi(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** @returns {number[]} closes 와 같은 길이. 앞쪽 period 개는 NaN. */
function rsi(closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(NaN);
  if (n <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = calcRsi(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = calcRsi(avgGain, avgLoss);
  }
  return out;
}

// ----------------------------------------------------------------- 피벗
/**
 * RSI 의 피벗 저점/고점을 찾는다.
 * 왼쪽 lbL 봉은 엄격하게(더 높아야/낮아야), 오른쪽은 같아도 인정한다.
 * 오른쪽이 lbR 봉 이상 있으면 confirmed, 그보다 적으면(minRight 이상) 형성 중이다.
 */
function findPivots(r, type, o) {
  const n = r.length;
  const out = [];
  const first = o.period + o.lbL; // 왼쪽 창 전체가 유효한 RSI 값인 첫 위치
  for (let i = first; i <= n - 1 - o.minRight; i++) {
    const avail = n - 1 - i;
    const right = Math.min(avail, o.lbR);
    const v = r[i];
    let ok = true;
    for (let j = i - o.lbL; j < i && ok; j++) ok = type === 'low' ? r[j] > v : r[j] < v;
    for (let j = i + 1; j <= i + right && ok; j++) ok = type === 'low' ? r[j] >= v : r[j] <= v;
    if (ok) out.push({ i, confirmed: avail >= o.lbR });
  }
  return out;
}

/** 피벗 근처 ±w 봉에서 가장 낮은 저가(또는 가장 높은 고가)의 위치. 동률이면 피벗에 가까운 쪽. */
function priceExtreme(candles, i, type, w) {
  const n = candles.length;
  let best = i;
  let bv = type === 'low' ? candles[i].l : candles[i].h;
  for (let d = 1; d <= w; d++) {
    for (const j of [i - d, i + d]) {
      if (j < 0 || j >= n) continue;
      const v = type === 'low' ? candles[j].l : candles[j].h;
      if (type === 'low' ? v < bv : v > bv) { best = j; bv = v; }
    }
  }
  return best;
}

// ------------------------------------------------------------ 연결선 검증
/** RSI 연결선을 사이의 RSI 가 뚫고 지나가지 않는지. */
function rsiLineClean(side, r, a, b, tol) {
  for (let k = a.i + 1; k < b.i; k++) {
    const line = a.rsi + ((b.rsi - a.rsi) * (k - a.i)) / (b.i - a.i);
    if (side === 'bull' ? r[k] < line - tol : r[k] > line + tol) return false;
  }
  return true;
}

/** 가격 연결선을 사이의 저가/고가가 뚫고 지나가지 않는지. */
function priceLineClean(side, candles, a, b, tol) {
  if (b.pi <= a.pi) return false;
  for (let k = a.pi + 1; k < b.pi; k++) {
    const line = a.price + ((b.price - a.price) * (k - a.pi)) / (b.pi - a.pi);
    if (side === 'bull' ? candles[k].l < line * (1 - tol) : candles[k].h > line * (1 + tol)) return false;
  }
  return true;
}

/** 두 번째 피벗 이후에 구조가 깨졌는지(가격이나 RSI 가 그 피벗을 넘어섰는지). */
function brokenAfter(side, candles, r, p2) {
  const n = candles.length;
  for (let k = p2.pi + 1; k < n; k++) {
    if (side === 'bull' ? candles[k].l < p2.price : candles[k].h > p2.price) return true;
  }
  for (let k = p2.i + 1; k < n; k++) {
    if (side === 'bull' ? r[k] < p2.rsi : r[k] > p2.rsi) return true;
  }
  return false;
}

// ------------------------------------------------------------------ 탐지
/**
 * @param {{t:number,o:number,h:number,l:number,c:number}[]} candles 마감된 봉, 오름차순
 * @param {Partial<typeof DEFAULTS>} opts
 */
function detect(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = candles.length;
  const r = rsi(candles.map(c => c.c), o.period);
  const result = { rsi: r, divergences: [] };
  if (n < o.period + o.lbL + o.minGap + o.lbR + 2) return result;

  const point = (side, p) => {
    const type = side === 'bull' ? 'low' : 'high';
    const pi = priceExtreme(candles, p.i, type, o.priceWin);
    return {
      i: p.i, rsi: r[p.i], rt: candles[p.i].t,
      pi, price: type === 'low' ? candles[pi].l : candles[pi].h, pt: candles[pi].t,
      confirmed: p.confirmed
    };
  };

  for (const side of ['bull', 'bear']) {
    const pivots = findPivots(r, side === 'bull' ? 'low' : 'high', o).map(p => point(side, p));
    const seen = new Set();

    // 가장 최근 피벗부터 거꾸로 본다. 같은 (종류, 상태)는 가장 최근 것 하나만 남긴다.
    for (let a = pivots.length - 1; a >= 0; a--) {
      const p2 = pivots[a];
      const age = n - 1 - p2.i;
      if (age > o.maxAge) break;

      let tried = 0;
      for (let b = a - 1; b >= 0 && tried < o.maxPrev; b--, tried++) {
        const p1 = pivots[b];
        const gap = p2.i - p1.i;
        if (gap < o.minGap) continue;
        if (gap > o.maxGap) break;

        const pricePct = (Math.abs(p2.price - p1.price) / p1.price) * 100;
        const rsiDiff = Math.abs(p2.rsi - p1.rsi);
        if (pricePct < o.minPricePct || rsiDiff < o.minRsiDiff) continue;

        // 가격과 RSI 가 같은 방향이면 다이버전스가 아니다.
        const priceUp = p2.price > p1.price;
        const rsiUp = p2.rsi > p1.rsi;
        if (priceUp === rsiUp) continue;

        // 상승: 저점 기준. 가격↓·RSI↑ = 일반, 가격↑·RSI↓ = 히든
        // 하락: 고점 기준. 가격↑·RSI↓ = 일반, 가격↓·RSI↑ = 히든
        const kind = side === 'bull' ? (priceUp ? 'hidden' : 'regular') : (priceUp ? 'regular' : 'hidden');
        const status = p2.confirmed ? 'confirmed' : 'forming';
        const key = `${kind}|${status}`;
        if (seen.has(key)) continue;

        if (!rsiLineClean(side, r, p1, p2, o.tolRsi)) continue;
        if (!priceLineClean(side, candles, p1, p2, o.tolPrice)) continue;
        if (brokenAfter(side, candles, r, p2)) continue;

        seen.add(key);
        result.divergences.push({
          side, kind, status,
          p1: { ri: p1.i, rt: p1.rt, rsi: p1.rsi, pi: p1.pi, pt: p1.pt, price: p1.price },
          p2: { ri: p2.i, rt: p2.rt, rsi: p2.rsi, pi: p2.pi, pt: p2.pt, price: p2.price },
          ageBars: age,
          spanBars: gap,
          rsiDiff,
          pricePct,
          inZone: side === 'bull' ? p1.rsi <= o.zoneLow : p1.rsi >= o.zoneHigh
        });
        break; // 이 p2 는 가장 가까운 유효한 p1 하나로 충분하다
      }
    }
  }

  // 최근 것이 앞으로
  result.divergences.sort((x, y) => x.ageBars - y.ageBars);
  return result;
}

module.exports = { rsi, findPivots, priceExtreme, detect, DEFAULTS };
