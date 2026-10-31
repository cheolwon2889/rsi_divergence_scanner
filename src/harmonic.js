'use strict';

// ===========================================================================
//  하모닉 PRZ (순수 함수 — 네트워크·시간에 의존하지 않는다)
//
//  TradingView 지표 "하모닉 패턴 자동 탐지 · PRZ" (harmonic_prz.pine)의 계산을
//  그대로 옮겼다. 기본값도 지표와 같다 (스윙 10%, 허용 오차 10%, PRZ 폭 3%).
//
//  1) 지그재그: 직전 극값에서 dev% 이상 되돌면 그 극값을 스윙으로 확정
//  2) 최근 4개 스윙(X·A·B·C)으로, 아직 오지 않은 D 가 올 구간(PRZ)을 패턴별로 계산
//     PRZ = XA 되돌림(확장) 구간과 BC 확장 구간이 겹치는 곳. 안 겹치면 버린다.
//  3) C 이후 가격이 PRZ 에 닿았는지, 뚫고 내려갔는지, 다시 위로 마감했는지(반등 확인)
//
//  롱만 본다. C 가 고점이라 D 가 저점으로 올 차례인 "상승 패턴"만 계산한다.
//  (지표 기본값도 "매수만"이고, 지표 주석상 백테스트도 매수 패턴이 나았다)
//
//  입력은 [{ t, o, h, l, c }] 오름차순. 마지막 봉이 진행 중이어도 된다.
//  스윙(구조)은 마감된 봉으로만 잡고, 진행 중인 봉은 PRZ 도달 여부에만 쓴다.
//  진행 중인 봉으로 스윙을 확정하면 봉이 끝나기 전에 구조가 바뀌었다 돌아오기 때문이다.
// ===========================================================================

const DEFAULTS = Object.freeze({
  devPct: 10.0,      // 스윙 최소 변동 %
  tolPct: 10.0,      // 비율 허용 오차 %
  przPct: 3.0,       // PRZ 폭 (XA 길이 대비 %)
  tgtFib: 0.382,     // 반등 확인 목표: 터치 후 최저가에서 C 까지 거리의 비율
  patterns: null     // 쓸 패턴 이름 배열. null 이면 전부
});

//            이름          XAB           ABC            BCD            XAD
const PATS = [
  ['가틀리',     0.618, 0.618, 0.382, 0.886, 1.13,  1.618, 0.786, 0.786],
  ['뱃',         0.382, 0.5,   0.382, 0.886, 1.618, 2.618, 0.886, 0.886],
  ['얼트 뱃',    0.236, 0.382, 0.382, 0.886, 2.0,   3.618, 1.13,  1.13],
  ['버터플라이', 0.786, 0.786, 0.382, 0.886, 1.618, 2.618, 1.27,  1.618],
  ['크랩',       0.382, 0.618, 0.382, 0.886, 2.24,  3.618, 1.618, 1.618],
  ['딥 크랩',    0.886, 0.886, 0.382, 0.886, 2.0,   3.618, 1.618, 1.618]
].map(([name, xabLo, xabHi, abcLo, abcHi, bcdLo, bcdHi, xadLo, xadHi]) =>
  ({ name, xabLo, xabHi, abcLo, abcHi, bcdLo, bcdHi, xadLo, xadHi }));

const PATTERN_NAMES = [...PATS.map(p => p.name), '사이퍼', 'AB=CD'];

// base 에서 from 쪽으로 (base - from)의 r 배만큼 이동한 가격
const lvl = (base, from, r) => base - r * (base - from);

// ---------------------------------------------------------------- 지그재그
function zigzag(candles, devPct) {
  const dev = devPct / 100;
  let trend = 1;
  let extP = null;
  let extB = null;
  const piv = [];          // { p, b, t, cb }  t: 1 = 고점, -1 = 저점, cb = 스윙이 확정된 봉
  for (let i = 0; i < candles.length; i++) {
    const { h, l } = candles[i];
    if (extP === null) { extP = h; extB = i; continue; }
    if (trend === 1) {
      if (h >= extP) { extP = h; extB = i; }
      else if (l <= extP * (1 - dev)) { piv.push({ p: extP, b: extB, t: 1, cb: i }); trend = -1; extP = l; extB = i; }
    } else {
      if (l <= extP) { extP = l; extB = i; }
      else if (h >= extP * (1 + dev)) { piv.push({ p: extP, b: extB, t: -1, cb: i }); trend = 1; extP = h; extB = i; }
    }
  }
  return { piv, trend, extP, extB };
}

// ------------------------------------------------------------- PRZ 계산
/** X·A·B·C 네 점으로 상승 패턴의 PRZ 목록을 만든다. 지표의 "진행 중 패턴" 계산과 같다. */
function projectZones(X, A, B, C, o) {
  const tol = o.tolPct / 100;
  const fits = (r, lo, hi) => r >= lo * (1 - tol) && r <= hi * (1 + tol);
  const on = (name) => !o.patterns || o.patterns.includes(name);

  const zones = [];
  const AB = Math.abs(B - A);
  const BC = Math.abs(C - B);
  if (!(AB > 0 && BC > 0)) return { zones, xab: null, abc: null };
  const abc = BC / AB;
  let xab = null;

  if (X !== null) {
    const XA = Math.abs(A - X);
    if (XA > 0) {
      xab = AB / XA;
      const w = (o.przPct / 100) * XA;
      for (const p of PATS) {
        if (!on(p.name) || !fits(xab, p.xabLo, p.xabHi) || !fits(abc, p.abcLo, p.abcHi)) continue;
        const z1a = lvl(A, X, p.xadLo), z1b = lvl(A, X, p.xadHi);
        const z1lo = Math.min(z1a, z1b) - w, z1hi = Math.max(z1a, z1b) + w;
        const z2a = lvl(C, B, p.bcdLo), z2b = lvl(C, B, p.bcdHi);
        const lo = Math.max(z1lo, Math.min(z2a, z2b));
        const hi = Math.min(z1hi, Math.max(z2a, z2b));
        // XA 구간과 BC 확장 구간이 안 겹치면 지표 기본값처럼 버린다.
        if (lo <= hi && hi > 0) zones.push({ name: p.name, lo: Math.max(lo, 0), hi, pad: w });
      }
      // 사이퍼: C 가 A 를 넘어서고(XA 의 1.13~1.414 확장), D 는 XC 의 0.786 되돌림
      if (on('사이퍼') && C > A && fits(xab, 0.382, 0.618) && fits(Math.abs(C - X) / XA, 1.13, 1.414)) {
        const d0 = lvl(C, X, 0.786);
        zones.push({ name: '사이퍼', lo: d0 - w, hi: d0 + w, pad: w });
      }
    }
  }
  if (on('AB=CD') && fits(abc, 0.382, 0.886)) {
    const d1 = C - (A - B);
    const wab = (o.przPct / 100) * AB;
    zones.push({ name: 'AB=CD', lo: d1 - wab, hi: d1 + wab, pad: wab });
  }
  return { zones, xab, abc };
}

// ------------------------------------------------------------------ 분석
/**
 * @param candles 오름차순. 마지막 봉이 진행 중이면 lastOpen = true
 * @returns null (상승 패턴 차례가 아니거나 스윙 부족) 또는 { X, A, B, C, zones: [...] }
 *   zone: { name, lo, hi, pad, touchIdx, passIdx, sig: { idx, close, stop, target } | null, minLow }
 *   *Idx 는 candles 기준 인덱스. 해당 사건이 없으면 -1.
 */
function analyze(candles, opts = {}, lastOpen = true) {
  const o = { ...DEFAULTS, ...opts };
  const nClosed = lastOpen ? candles.length - 1 : candles.length;
  if (nClosed < 10) return null;

  const zz = zigzag(candles.slice(0, nClosed), o.devPct);
  const piv = zz.piv;
  // 상승 패턴 = 마지막 확정 스윙(C)이 고점. 지금은 그 뒤 저점(D)을 찾아 내려가는 중.
  if (piv.length < 3 || piv[piv.length - 1].t !== 1) return null;

  const j = piv.length - 1;
  const Cp = piv[j], Bp = piv[j - 1], Ap = piv[j - 2], Xp = piv.length >= 4 ? piv[j - 3] : null;
  const { zones, xab, abc } = projectZones(Xp ? Xp.p : null, Ap.p, Bp.p, Cp.p, o);
  if (!zones.length) return null;

  // C 가 스윙으로 확정된 봉부터 끝(진행 중인 봉 포함)까지 PRZ 와의 관계를 본다.
  // 지표도 그 봉에서 PRZ 를 처음 계산하므로, C 와 확정 사이의 봉은 보지 않는다.
  for (const z of zones) {
    z.touchIdx = -1; z.passIdx = -1; z.sig = null;
    let minLow = Infinity;
    for (let i = Cp.cb; i < candles.length; i++) {
      const k = candles[i];
      if (z.touchIdx < 0 && k.l <= z.hi) z.touchIdx = i;
      if (z.touchIdx >= 0) minLow = Math.min(minLow, k.l);
      if (z.passIdx < 0 && k.l < z.lo) z.passIdx = i;
      // 반등 확인은 마감된 봉에서만: 터치 이후 종가가 PRZ 상단 위로 돌아온 첫 봉
      if (z.touchIdx >= 0 && !z.sig && i < nClosed && k.c > z.hi) {
        const stop = Math.min(minLow, z.lo) - z.pad;
        const target = minLow + o.tgtFib * (Cp.p - minLow);
        z.sig = { idx: i, close: k.c, stop, target, valid: target > k.c && stop < k.c };
      }
    }
    z.minLow = Number.isFinite(minLow) ? minLow : null;
  }

  return {
    X: Xp ? { p: Xp.p, t: candles[Xp.b].t } : null,
    A: { p: Ap.p, t: candles[Ap.b].t },
    B: { p: Bp.p, t: candles[Bp.b].t },
    C: { p: Cp.p, t: candles[Cp.b].t, idx: Cp.b },
    xab, abc, zones
  };
}

module.exports = { analyze, zigzag, projectZones, DEFAULTS, PATTERN_NAMES };
