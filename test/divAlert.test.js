'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDivAlerter, message } = require('../src/divAlert');

const item = (over = {}) => ({
  symbol: 'XPL_USDT', base: 'XPL', tf: '4h', side: 'bull', kind: 'regular', status: 'confirmed',
  p1: { price: 0.08074, rsi: 38.2, rt: 1793232000 }, p2: { price: 0.07328, rsi: 41.5 },
  p2Time: 1793304000, ageBars: 5, inZone: true, lastClose: 0.0741, rsiNow: 47.3, nonCrypto: false,
  url: 'https://www.gate.io/futures/USDT/XPL_USDT', ...over
});

test('처음 검사 때 이미 있던 확정 신호는 보내지 않는다', () => {
  const sent = [];
  const a = createDivAlerter({ notify: (t) => sent.push(t) });
  a.onScan('4h', [item()]);
  assert.equal(sent.length, 0);
});

test('두 번째 검사부터 새로 확정된 신호만 한 번 보낸다', () => {
  const sent = [];
  const a = createDivAlerter({ notify: (t) => sent.push(t) });
  a.onScan('4h', []);
  const it = item();
  a.onScan('4h', [it]);
  a.onScan('4h', [it]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /상승 다이버전스 확정 · 4시간봉/);
});

test('형성 중(forming) 신호는 보내지 않는다', () => {
  const sent = [];
  const a = createDivAlerter({ notify: (t) => sent.push(t) });
  a.onScan('4h', []);
  a.onScan('4h', [item({ status: 'forming', ageBars: 3 })]);
  assert.equal(sent.length, 0);
});

test('오래된 확정 신호(ageBars > maxAgeBars)는 보내지 않는다', () => {
  const sent = [];
  const a = createDivAlerter({ notify: (t) => sent.push(t), maxAgeBars: 6 });
  a.onScan('4h', []);
  a.onScan('4h', [item({ ageBars: 20 })]);
  assert.equal(sent.length, 0);
});

test('side 설정에 맞는 방향만 보낸다', () => {
  const sent = [];
  const a = createDivAlerter({ notify: (t) => sent.push(t), side: 'bull' });
  a.onScan('4h', []);
  a.onScan('4h', [item({ side: 'bear', p2Time: 1793390400 }), item({ side: 'bull', p2Time: 1793304000 })]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /상승/);
});

test('비코인 종목과 지정하지 않은 시간봉은 보내지 않는다', () => {
  const sent = [];
  const a = createDivAlerter({ notify: (t) => sent.push(t), timeframes: ['4h', '1d'] });
  a.onScan('4h', []);
  a.onScan('4h', [item({ nonCrypto: true })]);
  a.onScan('1h', [item({ tf: '1h' })]);
  assert.equal(sent.length, 0);
});

test('메시지에 가격·RSI·시각·링크가 들어간다', () => {
  const text = message(item({ inZone: true }));
  assert.match(text, /가격\s+0\.08074 → 0\.07328/);
  assert.match(text, /RSI\s+38\.2 → 41\.5/);
  assert.match(text, /첫 번째 저점\s+\S+ \S+ KST/);
  assert.match(text, /두 번째 저점\s+\S+ \S+ KST/);
  assert.match(text, /지금 RSI\s+47\.3/);
  assert.match(text, /과매도권/);
  assert.match(text, /https:\/\/www\.gate\.io/);
});

test('일반·과매도권 조건을 켜면 히든과 30 위에서 시작한 신호는 보내지 않는다', () => {
  const sent = [];
  const a = createDivAlerter({ notify: (t) => sent.push(t), kind: 'regular', zoneOnly: true });
  a.onScan('4h', []);
  a.onScan('4h', [
    item({ kind: 'hidden', p2Time: 1793304000 }),
    item({ inZone: false, p2Time: 1793318400 }),
    item({ p2Time: 1793332800 })
  ]);
  assert.equal(sent.length, 1);
});

test('거래대금이 기준보다 적은 종목은 보내지 않는다', () => {
  const sent = [];
  const volumes = { XPL_USDT: 2_000_000, BTC_USDT: 900_000_000 };
  const a = createDivAlerter({
    notify: (t) => sent.push(t), minVolume: 5_000_000, volumeOf: (s) => volumes[s] || 0
  });
  a.onScan('4h', []);
  a.onScan('4h', [item({ symbol: 'XPL_USDT', p2Time: 1793304000 }), item({ symbol: 'BTC_USDT', base: 'BTC', p2Time: 1793390400 })]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /BTC\/USDT/);
});
