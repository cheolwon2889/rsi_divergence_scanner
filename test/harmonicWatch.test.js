'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HarmonicWatcher } = require('../src/harmonicWatch');

// X=100 A=200 B=138.2 C=175.28 → 가틀리 PRZ [118.4, 124.4] (harmonic.test.js 와 같은 구조)
const HOUR = 3600;
function build(points, steps = 10) {
  const vals = [points[0]];
  for (let k = 1; k < points.length; k++) {
    for (let s = 1; s <= steps; s++) vals.push(points[k - 1] + ((points[k] - points[k - 1]) * s) / steps);
  }
  // 마지막 봉이 막 마감된 것으로 보이게 시각을 맞춘다 (진행 중인 봉 없음)
  const end = Math.floor(Date.now() / 1000 / HOUR) * HOUR - HOUR;
  return vals.map((v, i) => ({ t: end - (vals.length - 1 - i) * HOUR, o: v, h: v, l: v, c: v }));
}

function setup(seriesRef) {
  const sent = [];
  const market = { symbol: 'TEST_USDT', base: 'TEST', quoteVolume: 1e9 };
  const scanner = { ensureMarkets: async () => [market], throttle: async () => {} };
  const provider = { candles: async () => seriesRef.value };
  const w = new HarmonicWatcher({ scanner, provider, timeframes: ['1h'], notify: async (t) => { sent.push(t); }, opts: { patterns: ['가틀리'] } });
  return { w, sent };
}

test('서버가 켜지기 전에 이미 닿은 PRZ 는 첫 검사에서 보내지 않는다', async () => {
  const ref = { value: build([120, 100, 200, 138.2, 175.28, 121, 121.5, 122, 122.5, 123]) };
  const { w, sent } = setup(ref);
  await w.runOnce();
  assert.equal(sent.length, 0, sent.join('\n---\n'));
});

test('켜진 뒤 새로 닿으면 한 번만 보내고, 반등 확인과 이탈도 한 번씩만', async () => {
  const ref = { value: build([120, 100, 200, 138.2, 175.28, 160]) };
  const { w, sent } = setup(ref);
  await w.runOnce();                                    // 첫 검사: 아직 PRZ 위 (160)
  assert.equal(sent.length, 0);

  ref.value = build([120, 100, 200, 138.2, 175.28, 125.2]);   // 상단 124.4 의 0.6% 위 → 접근
  await w.runOnce();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /PRZ 접근/);
  assert.match(sent[0], /118\.4 ~ 124\.4/);

  ref.value = build([120, 100, 200, 138.2, 175.28, 122]);     // 닿음
  await w.runOnce();
  await w.runOnce();                                    // 같은 상태로 한 번 더 → 중복 없음
  assert.equal(sent.length, 2);
  assert.match(sent[1], /롱 트라이 구간 도달/);

  ref.value = build([120, 100, 200, 138.2, 175.28, 122, 124.8]); // 상단 124.4 위 마감 → 반등 확인
  await w.runOnce();
  assert.equal(sent.length, 3);
  assert.match(sent[2], /반등 확인/);
  assert.match(sent[2], /손절 115\.4/);
});

test('하단을 뚫으면 이탈 메시지', async () => {
  const ref = { value: build([120, 100, 200, 138.2, 175.28, 160]) };
  const { w, sent } = setup(ref);
  await w.runOnce();
  ref.value = build([120, 100, 200, 138.2, 175.28, 116]);
  await w.runOnce();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /하단 이탈/);
});

test('1시간봉과 4시간봉이 같은 구조를 잡으면 한 번만 보낸다', async () => {
  const ref = { value: build([120, 100, 200, 138.2, 175.28, 160]) };
  const sent = [];
  const scanner = { ensureMarkets: async () => [{ symbol: 'TEST_USDT', base: 'TEST' }], throttle: async () => {} };
  const provider = { candles: async () => ref.value };
  const w = new HarmonicWatcher({ scanner, provider, timeframes: ['1h', '4h'], notify: async (t) => { sent.push(t); }, opts: { patterns: ['가틀리'] } });
  await w.runOnce();
  ref.value = build([120, 100, 200, 138.2, 175.28, 122]);
  await w.runOnce();
  assert.equal(sent.length, 1, sent.join('\n---\n'));
});
