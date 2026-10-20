'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rsi, detect, DEFAULTS } = require('../src/rsi');
const { naiveRsi, verify } = require('../tools/verify');

// ------------------------------------------------------------------ 도구
function rng(seed) {                       // 결정적 난수 (mulberry32)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toCandles = (closes, wick = 0.002) =>
  closes.map((c, i) => ({ t: 1_700_000_000 + i * 3600, o: c, h: c * (1 + wick), l: c * (1 - wick), c }));

/** 급락 → 반등 → 완만한 신저점 → 소폭 반등. 두 번째 저점에서 RSI 가 더 높아야 한다. */
function bullishScenario() {
  const r = rng(7);
  const c = [];
  let p = 100;
  for (let i = 0; i < 40; i++) { p *= 1 + (r() - 0.5) * 0.004; c.push(p); }   // 워밍업
  for (let i = 0; i < 6; i++) { p *= 0.965; c.push(p); }                       // 급락 (RSI 매우 낮음)
  for (let i = 0; i < 10; i++) { p *= 1.012; c.push(p); }                      // 반등
  for (let i = 0; i < 24; i++) { p *= 0.9945; c.push(p * (1 + (r() - 0.5) * 0.001)); } // 느린 하락 → 더 낮은 가격
  for (let i = 0; i < 8; i++) { p *= 1.006; c.push(p); }                       // 소폭 반등 (피벗 확정용)
  return c;
}

// ------------------------------------------------------------------ RSI
test('RSI: 손으로 계산한 값과 일치 (period=2)', () => {
  // 변화량 +1, -1 → 평균이득 0.5, 평균손실 0.5 → 50
  // 다음 +1 → 이득 (0.5+1)/2=0.75, 손실 0.25 → 100-100/(1+3)=75
  // 다음 +1 → 이득 0.875, 손실 0.125 → 100-100/(1+7)=87.5
  const out = rsi([10, 11, 10, 11, 12], 2);
  assert.ok(Number.isNaN(out[0]) && Number.isNaN(out[1]));
  assert.equal(out[2], 50);
  assert.equal(out[3], 75);
  assert.equal(out[4], 87.5);
});

test('RSI: 다른 방식으로 짠 구현과 일치 (랜덤 5000개)', () => {
  const r = rng(42);
  for (const period of [7, 14, 21]) {
    const closes = [];
    let p = 100;
    for (let i = 0; i < 5000; i++) { p *= 1 + (r() - 0.5) * 0.03; closes.push(p); }
    const a = rsi(closes, period), b = naiveRsi(closes, period);
    for (let i = 0; i < closes.length; i++) {
      if (Number.isNaN(b[i])) assert.ok(Number.isNaN(a[i]));
      else assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `period ${period} idx ${i}`);
    }
  }
});

test('RSI: 경계값', () => {
  assert.ok(rsi([1, 2, 3], 14).every(Number.isNaN), '길이가 짧으면 전부 NaN');
  const up = rsi(Array.from({ length: 40 }, (_, i) => 100 + i), 14);
  assert.equal(up[39], 100, '계속 오르면 100');
  const flat = rsi(new Array(40).fill(50), 14);
  assert.equal(flat[39], 50, '변화가 없으면 50');
  const down = rsi(Array.from({ length: 40 }, (_, i) => 100 - i), 14);
  assert.equal(down[39], 0, '계속 내리면 0');
  const r = rng(1);
  const rnd = rsi(Array.from({ length: 500 }, () => 100 + r() * 10), 14).filter(Number.isFinite);
  assert.ok(rnd.every(v => v >= 0 && v <= 100));
});

// -------------------------------------------------------------- 다이버전스
test('상승 일반 다이버전스를 찾고, 정의대로인지 독립 검증기로 확인', () => {
  const candles = toCandles(bullishScenario());
  const { divergences } = detect(candles);
  const hit = divergences.find(d => d.side === 'bull' && d.kind === 'regular' && d.status === 'confirmed');
  assert.ok(hit, '상승 일반(확정)이 잡혀야 함. 실제: ' + JSON.stringify(divergences.map(d => [d.side, d.kind, d.status])));
  assert.ok(hit.p2.price < hit.p1.price, '가격 저점은 낮아졌어야 함');
  assert.ok(hit.p2.rsi > hit.p1.rsi, 'RSI 저점은 높아졌어야 함');
  assert.deepEqual(verify(hit, candles), []);
});

test('하락 일반 다이버전스: 가격을 뒤집으면 대칭으로 잡힌다', () => {
  const base = bullishScenario();
  const mirrored = toCandles(base.map(v => 200 - v));
  const { divergences } = detect(mirrored);
  const hit = divergences.find(d => d.side === 'bear' && d.kind === 'regular' && d.status === 'confirmed');
  assert.ok(hit, '하락 일반(확정)이 잡혀야 함');
  assert.ok(hit.p2.price > hit.p1.price && hit.p2.rsi < hit.p1.rsi);
  assert.deepEqual(verify(hit, mirrored), []);
});

test('이후에 신저점이 나오면 바로 그 신호가 사라진다 (깨진 다이버전스 제외)', () => {
  const base = bullishScenario();
  const before = detect(toCandles(base)).divergences
    .find(d => d.side === 'bull' && d.kind === 'regular' && d.status === 'confirmed');
  assert.ok(before, '기준 시나리오에서는 신호가 있어야 비교가 의미 있음');

  // 두 번째 저점보다 더 아래로 떨어지는 구간을 붙인다.
  const broken = [...base];
  let p = base[base.length - 1];
  for (let i = 0; i < 12; i++) { p *= 0.985; broken.push(p); }
  const candles = toCandles(broken);
  assert.ok(Math.min(...candles.map(c => c.l)) < before.p2.price, '붙인 구간이 저점을 깨야 함');

  const after = detect(candles).divergences;
  assert.ok(!after.some(d => d.side === 'bull' && d.p2.ri === before.p2.ri),
    '저점이 깨졌는데 같은 피벗이 여전히 신호로 남아 있음');
  after.forEach(d => assert.deepEqual(verify(d, candles), []));
});

test('봉이 너무 적으면 아무것도 내지 않고 죽지도 않는다', () => {
  assert.deepEqual(detect([]).divergences, []);
  assert.deepEqual(detect(toCandles([1, 2, 3, 4, 5])).divergences, []);
});

test('랜덤 장 3000개: 나온 신호는 전부 정의를 만족한다', () => {
  let total = 0;
  const kinds = new Set();
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const n = 120 + Math.floor(r() * 200);
    const vol = 0.004 + r() * 0.02;
    const closes = [];
    let p = 100, drift = 0;
    for (let i = 0; i < n; i++) {
      if (i % 40 === 0) drift = (r() - 0.5) * 0.01;      // 추세가 바뀌는 장
      p *= 1 + drift + (r() - 0.5) * vol;
      closes.push(p);
    }
    const candles = closes.map((c, i) => {
      const w = c * r() * 0.006;
      return { t: 1_700_000_000 + i * 900, o: c, h: c + w, l: c - w * (0.5 + r()), c };
    });
    const { divergences } = detect(candles);
    for (const d of divergences) {
      const errs = verify(d, candles);
      assert.deepEqual(errs, [], `seed ${seed} ${d.side}/${d.kind}/${d.status}`);
      kinds.add(`${d.side}|${d.kind}|${d.status}`);
      total++;
    }
  }
  assert.ok(total > 100, `신호가 너무 적으면 테스트가 의미 없음 (${total}개)`);
  assert.ok(kinds.size >= 6, `다양한 종류가 나와야 함: ${[...kinds].join(', ')}`);
});
