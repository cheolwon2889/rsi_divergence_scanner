'use strict';

// ===========================================================================
//  비코인 계약 표시 (추정)
//
//  Gate 선물에는 코인과 함께 주식·ETF·원자재 계약이 섞여 있다
//  (NVDA, TSLA, SOXL, QQQ, XAU …). 계약 정보에 종류를 구분하는 필드가 없어서
//  알려진 티커를 직접 적어 두고 거른다.
//
//  완벽할 수 없다. 새로 상장된 주식 계약은 목록에 없으면 코인처럼 보인다.
//  그래서 "숨김"이 아니라 "표시"로 처리하고, 화면에서 켜고 끌 수 있게 했다.
//  목록에 없는 것을 발견하면 환경변수 EXTRA_NON_CRYPTO 로 더할 수 있다.
//
//  PAXG·XAUT 는 금을 따라가는 토큰이라 코인이라기보다 금에 가까워 같이 뺐다.
// ===========================================================================

const BASE_LIST = [
  // 원자재
  'XAU', 'XAG', 'CL', 'BZ', 'PAXG', 'XAUT',
  // 지수·ETF
  'SPY', 'QQQ', 'SQQQ', 'TQQQX', 'SOXL', 'SOXS', 'KORU', 'EWY', 'DRAM', 'SPCX', 'US30', 'MUU', 'MVLL', 'SNXX',
  // 미국 주식
  'NVDA', 'TSLA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'AMD', 'INTC', 'MU', 'AVGO', 'ARM', 'ORCL', 'TSM',
  'DELL', 'WDC', 'SNDK', 'MRVL', 'LITE', 'COHR', 'GLW', 'AAOI', 'AXTI', 'BE', 'PLTR', 'RKLB', 'ASTS', 'HOOD',
  'COIN', 'MSTR', 'CRCL', 'CRWV', 'NBIS', 'IREN', 'BMNR', 'CBRS', 'BABA', 'INTW',
  // 한국·중국 주식 및 상장 전 종목
  'SAMSUNG', 'SKHYNIX', 'SKHY', 'CXMT', 'OPENAI', 'UNITREE', 'ZHIPU', 'MINIMAX'
];

const extra = String(process.env.EXTRA_NON_CRYPTO || '')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const NON_CRYPTO = new Set([...BASE_LIST, ...extra]);

/** 비코인(주식·ETF·원자재)으로 추정되면 true */
function isNonCrypto(base) {
  return NON_CRYPTO.has(String(base).toUpperCase());
}

module.exports = { isNonCrypto, NON_CRYPTO };
