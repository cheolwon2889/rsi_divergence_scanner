'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, zigzag, projectZones, DEFAULTS } = require('../src/harmonic');

// 꼭짓점 사이를 일정 간격으로 잇는 봉. 꼬리 없이 h = l = c 라서 스윙 값이 꼭짓점과 정확히 같다.
function path(points, steps = 10) {
  const out = [];
  let t = 1_700_000_000;
  const push = (v) => { out.push({ t, o: v, h: v, l: v, c: v }); t += 3600; };
  push(points[0]);
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], b = points[k];
    for (let s = 1; s <= steps; s++) push(a + ((b - a) * s) / steps);
  }
  return out;
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);

// X=100 A=200 B=138.2 (XA 의 0.618 되돌림) C=175.28 (AB 의 0.6 반등)
const X = 100, A = 200, B = 138.2, C = 175.28;

test('PRZ: 가틀리와 AB=CD 를 손계산 값과 비교', () => {
  const { zones, xab, abc } = projectZones(X, A, B, C, DEFAULTS);
  near(xab, 0.618, 'XAB');
  near(abc, 0.6, 'ABC');

  // 가틀리: XA 0.786 되돌림 121.4 ± 3 = [118.4, 124.4]
  //         BC 1.13~1.618 확장 = [115.285..., 133.3796]  → 겹치는 곳 [118.4, 124.4]
  const g = zones.find(z => z.name === '가틀리');
  assert.ok(g, '가틀리가 있어야 함');
  near(g.lo, 118.4, '가틀리 하단');
  near(g.hi, 124.4, '가틀리 상단');

  // AB=CD: D = C - AB = 113.48, 폭 = AB 61.8 의 3% = 1.854
  const ab = zones.find(z => z.name === 'AB=CD');
  near(ab.lo, 113.48 - 1.854, 'AB=CD 하단');
  near(ab.hi, 113.48 + 1.854, 'AB=CD 상단');

  // XAB 0.618 은 뱃(0.382~0.5, 허용 ±10% → 0.55 까지)에 안 맞는다
  assert.ok(!zones.some(z => z.name === '뱃'));
  // C(175.28) 가 A(200) 를 못 넘었으므로 사이퍼도 아니다
  assert.ok(!zones.some(z => z.name === '사이퍼'));
});

test('도달 → 반등 확인 순서와 손절·목표', () => {
  // C 이후 121 까지 내려와 가틀리 PRZ 에 닿고, 126 으로 돌아온다 (PRZ 상단 124.4 위 마감)
  const candles = path([120, X, A, B, C, 121, 126, 127]);
  const r = analyze(candles, {}, false);
  assert.ok(r, '분석 결과가 있어야 함');
  near(r.C.p, C, 'C');
  near(r.X.p, X, 'X');

  const g = r.zones.find(z => z.name === '가틀리');
  assert.ok(g.touchIdx > 0, '터치');
  assert.equal(candles[g.touchIdx].l <= g.hi, true);
  assert.equal(candles[g.touchIdx - 1].l > g.hi, true, '터치는 처음 닿은 봉이어야 함');
  assert.equal(g.passIdx, -1, '121 은 하단 118.4 를 안 깼다');
  assert.ok(g.sig && g.sig.idx > g.touchIdx, '반등 확인은 터치 뒤');
  assert.ok(g.sig.close > g.hi && candles[g.sig.idx - 1].c <= g.hi, '처음으로 상단 위에서 마감한 봉');
  near(g.minLow, 121, '터치 이후 최저가');
  near(g.sig.stop, 118.4 - 3, '손절 = min(최저가, 하단) - 여유폭');
  near(g.sig.target, 121 + 0.382 * (C - 121), '목표');
  assert.equal(g.sig.valid, true);
});

test('하단을 뚫고 내려가면 이탈로 잡힌다', () => {
  const r = analyze(path([120, X, A, B, C, 117]), {}, false);
  const g = r.zones.find(z => z.name === '가틀리');
  assert.ok(g.touchIdx > 0 && g.passIdx >= g.touchIdx);
});

test('진행 중인 봉은 스윙에 안 쓰고 도달 여부에만 쓴다', () => {
  const closed = path([120, X, A, B, C, 130]);
  const live = { t: closed[closed.length - 1].t + 3600, o: 130, h: 130, l: 122, c: 125 };
  const r = analyze([...closed, live], {}, true);
  const g = r.zones.find(z => z.name === '가틀리');
  assert.equal(g.touchIdx, closed.length, '진행 중인 봉에서 터치');
  assert.equal(g.sig, null, '진행 중인 봉으로는 반등 확인을 내지 않는다');
});

test('C 가 저점이면(하락 패턴 차례) 아무것도 내지 않는다', () => {
  assert.equal(analyze(path([120, X, A, B]), {}, false), null);
});

test('지그재그: 스윙은 고점·저점이 번갈아 나오고 서로 dev% 이상 떨어져 있다', () => {
  let a = 7;
  const rnd = () => ((a = (a * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let seed = 0; seed < 200; seed++) {
    const candles = [];
    let p = 100;
    for (let i = 0; i < 800; i++) {
      p *= 1 + (rnd() - 0.5) * 0.04;
      const h = p * (1 + rnd() * 0.01), l = p * (1 - rnd() * 0.01);
      candles.push({ t: i, o: p, h, l, c: p });
    }
    for (const dev of [3, 10]) {
      const { piv } = zigzag(candles, dev);
      for (let k = 1; k < piv.length; k++) {
        const prev = piv[k - 1], cur = piv[k];
        assert.notEqual(prev.t, cur.t, '같은 종류가 연달아 나오면 안 됨');
        if (prev.t === 1) assert.ok(cur.p <= prev.p * (1 - dev / 100) + 1e-9);
        else assert.ok(cur.p >= prev.p * (1 + dev / 100) - 1e-9);
        // 스윙 값은 그 봉의 실제 고가/저가
        assert.equal(cur.p, cur.t === 1 ? candles[cur.b].h : candles[cur.b].l);
        assert.ok(cur.cb > cur.b, '확정은 극값 이후 봉');
      }
    }
  }
});
