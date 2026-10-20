'use strict';

// 실제 거래소 데이터로 스캐너 결과를 독립 검증기에 통과시키는 점검 도구.
//   node tools/live-check.js [시간봉,...] [상위 N]      예) node tools/live-check.js 1h,4h 100
// 환경변수 EXCHANGE=binance 로 거래소를 바꿀 수 있다.

const { getProvider, TF_SECONDS, sleep } = require('../src/exchanges');
const { detect } = require('../src/rsi');
const { verify } = require('./verify');

(async () => {
  const tfs = (process.argv[2] || '1h,4h').split(',');
  const topN = Number(process.argv[3]) || 100;
  const provider = getProvider(process.env.EXCHANGE || 'gate');

  const markets = (await provider.listMarkets())
    .filter(m => m.quoteVolume >= 1_000_000)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, topN);
  console.log(`${provider.label} 상위 ${markets.length}종목 × ${tfs.join(', ')}`);

  const stats = { symbols: 0, signals: 0, bad: 0, openCandle: 0, kinds: {} };
  const problems = [];

  for (const tf of tfs) {
    for (const m of markets) {
      await sleep(provider.requestGapMs);
      let raw;
      try { raw = await provider.candles(m.symbol, tf, 500); } catch (e) { continue; }
      const now = Math.floor(Date.now() / 1000);
      const closed = raw.filter(k => k.t + TF_SECONDS[tf] <= now);
      if (closed.length < 80) continue;
      stats.symbols++;

      // 마감 봉만 넘겼는지: 마지막 봉이 아직 진행 중이면 안 된다.
      if (closed[closed.length - 1].t + TF_SECONDS[tf] > now) stats.openCandle++;

      const { divergences } = detect(closed);
      for (const d of divergences) {
        stats.signals++;
        const k = `${d.side}/${d.kind}/${d.status}`;
        stats.kinds[k] = (stats.kinds[k] || 0) + 1;
        const errs = verify(d, closed);
        if (errs.length) { stats.bad++; problems.push({ symbol: m.symbol, tf, k, errs }); }
      }
    }
  }

  console.log(JSON.stringify(stats, null, 2));
  if (problems.length) { console.log('문제 있는 신호:', JSON.stringify(problems.slice(0, 5), null, 1)); process.exit(1); }
  console.log('✅ 모든 신호가 독립 검증기를 통과했습니다.');
})().catch(e => { console.error('실패:', e.message); process.exit(1); });
