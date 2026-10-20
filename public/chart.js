/* global LightweightCharts */
'use strict';

// ===========================================================================
//  차트 — 가격(위) + RSI(아래), 다이버전스 선을 양쪽에 그린다.
//
//  - 일반 다이버전스는 실선, 히든은 점선. 상승은 초록, 하락은 빨강.
//  - 고른 신호는 굵게, 나머지는 얇고 흐리게 그려서 한 신호에 집중할 수 있다.
//  - lightweight-charts 는 시각을 UTC 로 표시하므로, 한국시간으로 보이도록
//    모든 시각에 9시간을 더해서 넣는다.
//  - 두 차트의 가로 범위는 서로 묶어서 같이 움직이게 한다.
// ===========================================================================

window.DivChart = (function () {
  const KST = 9 * 3600;
  const BULL = '#15C47E';
  const BEAR = '#F04452';

  let priceChart = null;
  let rsiChart = null;
  let candles = null;
  let rsiLine = null;
  let overlays = [];       // 다이버전스 선 (두 차트 각각)
  let observers = [];
  let syncing = false;

  const theme = (height, showTime) => ({
    height,
    layout: { background: { color: '#1E1E24' }, textColor: '#8B95A1', fontSize: 11 },
    grid: { vertLines: { color: '#26262E' }, horzLines: { color: '#26262E' } },
    rightPriceScale: { borderColor: '#2E2E38', minimumWidth: 64 },
    timeScale: { borderColor: '#2E2E38', timeVisible: true, secondsVisible: false, visible: showTime },
    crosshair: {
      vertLine: { color: '#3182F6', width: 1, style: 2, labelBackgroundColor: '#3182F6' },
      horzLine: { color: '#3182F6', width: 1, style: 2, labelBackgroundColor: '#3182F6' }
    },
    handleScale: { axisPressedMouseMove: { price: false } }
  });

  function precisionFor(price) {
    if (price >= 1000) return 2;
    if (price >= 100) return 2;
    if (price >= 1) return 4;
    if (price >= 0.01) return 6;
    return 8;
  }

  function destroy() {
    observers.forEach(o => o.disconnect());
    observers = [];
    if (priceChart) { priceChart.remove(); priceChart = null; }
    if (rsiChart) { rsiChart.remove(); rsiChart = null; }
    candles = null; rsiLine = null; overlays = [];
  }

  function create(elPrice, elRsi) {
    destroy();
    priceChart = LightweightCharts.createChart(elPrice, { ...theme(elPrice.clientHeight, false), width: elPrice.clientWidth });
    rsiChart = LightweightCharts.createChart(elRsi, { ...theme(elRsi.clientHeight, true), width: elRsi.clientWidth });

    candles = priceChart.addCandlestickSeries({
      upColor: BULL, downColor: BEAR, borderUpColor: BULL, borderDownColor: BEAR, wickUpColor: BULL, wickDownColor: BEAR
    });

    rsiLine = rsiChart.addLineSeries({
      color: '#7FB0FF', lineWidth: 2, priceLineVisible: false,
      // RSI 는 항상 0~100 으로 고정해서 보는 위치가 흔들리지 않게 한다.
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } })
    });
    [70, 50, 30].forEach(v => rsiLine.createPriceLine({
      price: v, color: v === 50 ? '#3A3A46' : '#5A5A68', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: ''
    }));

    // 가로 범위 동기화 (서로를 다시 부르지 않도록 잠금)
    const link = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncing || !range) return;
      syncing = true;
      to.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    });
    link(priceChart, rsiChart);
    link(rsiChart, priceChart);

    [[priceChart, elPrice], [rsiChart, elRsi]].forEach(([chart, el]) => {
      const ro = new ResizeObserver(() => { if (el.clientWidth > 0) chart.applyOptions({ width: el.clientWidth }); });
      ro.observe(el);
      observers.push(ro);
    });
  }

  /**
   * @param data   /api/chart 응답
   * @param selKey 굵게 그릴 신호의 "side|kind|status"
   */
  function render(elPrice, elRsi, data, selKey) {
    if (!priceChart) create(elPrice, elRsi);

    const last = data.candles[data.candles.length - 1];
    const p = precisionFor(last ? last.close : 1);
    candles.applyOptions({ priceFormat: { type: 'price', precision: p, minMove: Math.pow(10, -p) } });

    candles.setData(data.candles.map(c => ({ ...c, time: c.time + KST })));
    rsiLine.setData(data.rsi.map(r => ({ time: r.time + KST, value: r.value })));

    // 이전 선 지우기
    overlays.forEach(o => o.chart.removeSeries(o.series));
    overlays = [];

    const markers = [];
    for (const d of data.divergences) {
      const bull = d.side === 'bull';
      const color = bull ? BULL : BEAR;
      const picked = `${d.side}|${d.kind}|${d.status}` === selKey;
      const opts = {
        color: picked ? color : color + '66',
        lineWidth: picked ? 3 : 1,
        lineStyle: d.kind === 'hidden' ? 2 : 0,      // 히든은 점선
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false
      };

      const sp = priceChart.addLineSeries(opts);
      sp.setData([{ time: d.p1.pt + KST, value: d.p1.price }, { time: d.p2.pt + KST, value: d.p2.price }]);
      overlays.push({ chart: priceChart, series: sp });

      const sr = rsiChart.addLineSeries({ ...opts, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      sr.setData([{ time: d.p1.rt + KST, value: d.p1.rsi }, { time: d.p2.rt + KST, value: d.p2.rsi }]);
      overlays.push({ chart: rsiChart, series: sr });

      if (picked) {
        for (const pt of [d.p1, d.p2]) {
          markers.push({
            time: pt.pt + KST,
            position: bull ? 'belowBar' : 'aboveBar',
            color, shape: bull ? 'arrowUp' : 'arrowDown', text: ''
          });
        }
      }
    }
    markers.sort((a, b) => a.time - b.time);
    candles.setMarkers(markers);

    const n = data.candles.length;
    priceChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 120), to: n + 3 });
  }

  return { render, destroy };
})();
