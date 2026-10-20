'use strict';

// ===========================================================================
//  스캐너
//
//  - 거래대금 상위 N개 종목을 시간봉별로 검사한다.
//  - 시간봉마다 "새 봉이 마감됐을 때"만 다시 검사한다. 1시간봉은 매시 정각 직후,
//    4시간봉은 UTC 0·4·8·12·16·20시 직후에 한 번씩이다. 그 사이에는 호출이 없다.
//  - 마감된 봉만 쓴다. 진행 중인 봉을 섞으면 RSI 가 계속 바뀌어 신호가 깜빡인다.
//  - 거래소 호출은 한 줄로 세워서 최소 간격을 둔다 (공개 API 한도 보호).
//  - 검사 도중에도 지금까지 찾은 결과를 보여준다. Render 무료 서버는 잠들었다
//    깨면 메모리가 비어 처음부터 다시 돌아야 하는데, 끝날 때까지 빈 화면이면 답답하다.
// ===========================================================================

const { detect } = require('./rsi');
const { TF_SECONDS, sleep } = require('./exchanges');
const { isNonCrypto } = require('./markets');

const CLOSE_LAG_SEC = 10;          // 봉이 마감된 뒤 거래소가 값을 확정할 때까지 기다리는 시간
const MARKETS_TTL_MS = 5 * 60 * 1000;
const CHART_TTL_MS = 45 * 1000;
const WORKERS = 3;
const CANDLE_LIMIT = 500;

class Scanner {
  constructor({ provider, timeframes, topN = 150, minVolume = 1_000_000, detectOpts = {} }) {
    this.provider = provider;
    this.timeframes = timeframes;
    this.topN = topN;
    this.minVolume = minVolume;
    this.detectOpts = detectOpts;

    this.marketMap = new Map();    // 전체 종목 (가격·거래대금 표시용)
    this.markets = [];             // 검사 대상 (거래대금 상위)
    this.marketsAt = 0;
    this.marketsLoading = null;

    this.nextAt = 0;               // 거래소 호출 간격 제한
    this.busy = false;
    this.timer = null;
    this.chartCache = new Map();

    this.byTf = {};
    for (const tf of timeframes) {
      this.byTf[tf] = {
        tf, bucket: null, scanning: false, done: 0, total: 0, errors: 0,
        scannedAt: null, durationMs: null, items: null, partial: []
      };
    }
  }

  // ----------------------------------------------------------------- 시작
  start() {
    const tick = () => this.tick().catch(e => console.error('[scan] tick 실패:', e.message));
    tick();
    this.timer = setInterval(tick, 15_000);
  }

  stop() { clearInterval(this.timer); }

  // ------------------------------------------------------------ 종목 목록
  async refreshMarkets() {
    if (this.marketsLoading) return this.marketsLoading;
    this.marketsLoading = (async () => {
      try {
        const all = await this.provider.listMarkets();
        const map = new Map(all.map(m => [m.symbol, m]));
        const picked = all
          .filter(m => m.quoteVolume >= this.minVolume)
          .sort((a, b) => b.quoteVolume - a.quoteVolume)
          .slice(0, this.topN);
        this.marketMap = map;
        this.markets = picked;
        this.marketsAt = Date.now();
        return picked;
      } finally {
        this.marketsLoading = null;
      }
    })();
    return this.marketsLoading;
  }

  async ensureMarkets() {
    if (this.markets.length && Date.now() - this.marketsAt < MARKETS_TTL_MS) return this.markets;
    try {
      return await this.refreshMarkets();
    } catch (e) {
      if (this.markets.length) { console.warn('[scan] 종목 목록 갱신 실패, 이전 목록 사용:', e.message); return this.markets; }
      throw e;
    }
  }

  // ------------------------------------------------------------- 호출 제한
  async throttle() {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.provider.requestGapMs;
    if (wait) await sleep(wait);
  }

  // ------------------------------------------------------------ 스케줄링
  bucketFor(tf, nowMs = Date.now()) {
    return Math.floor((nowMs / 1000 - CLOSE_LAG_SEC) / TF_SECONDS[tf]);
  }

  /** 새 봉이 마감돼서 다시 검사해야 하는 시간봉 중 가장 큰 것. */
  nextDue() {
    const due = this.timeframes.filter(tf => this.byTf[tf].bucket !== this.bucketFor(tf));
    if (!due.length) return null;
    due.sort((a, b) => TF_SECONDS[b] - TF_SECONDS[a]);
    return due[0];
  }

  async tick() {
    if (this.busy) return;
    const tf = this.nextDue();
    if (!tf) {
      // 검사할 게 없어도 가격·거래대금은 가끔 갱신한다.
      if (Date.now() - this.marketsAt > MARKETS_TTL_MS) await this.refreshMarkets().catch(() => {});
      return;
    }
    this.busy = true;
    try { await this.scanTimeframe(tf); } finally { this.busy = false; }
  }

  // --------------------------------------------------------------- 검사
  closedCandles(raw, tf, nowSec = Math.floor(Date.now() / 1000)) {
    const sec = TF_SECONDS[tf];
    return raw.filter(k => k.t + sec <= nowSec);
  }

  async scanTimeframe(tf) {
    const st = this.byTf[tf];
    const bucket = this.bucketFor(tf);
    const t0 = Date.now();
    st.scanning = true; st.done = 0; st.errors = 0; st.partial = [];

    try {
      const list = await this.ensureMarkets();
      st.total = list.length;
      const items = [];
      let cursor = 0;

      const worker = async () => {
        while (cursor < list.length) {
          const m = list[cursor++];
          try {
            await this.throttle();
            const raw = await this.provider.candles(m.symbol, tf, CANDLE_LIMIT);
            const closed = this.closedCandles(raw, tf);
            if (closed.length >= 80) {
              const res = detect(closed, this.detectOpts);
              for (const d of res.divergences) {
                const item = this.toItem(m, tf, d, closed, res.rsi);
                items.push(item);
                st.partial.push(item);
              }
            }
          } catch (e) {
            st.errors++;
            if (st.errors <= 3) console.warn(`[scan] ${tf} ${m.symbol} 실패: ${e.message}`);
          } finally {
            st.done++;
          }
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, worker));

      // 거의 다 실패했으면 이전 결과를 지우지 않고 다음 틱에서 다시 시도한다.
      if (st.errors > list.length * 0.5) throw new Error(`실패가 너무 많음 (${st.errors}/${list.length})`);

      st.items = items;
      st.bucket = bucket;
      st.scannedAt = Date.now();
      st.durationMs = Date.now() - t0;
      console.log(`[scan] ${tf} 완료: ${list.length}종목 → 신호 ${items.length}개 (${(st.durationMs / 1000).toFixed(1)}초, 오류 ${st.errors})`);
    } catch (e) {
      console.error(`[scan] ${tf} 검사 실패: ${e.message}`);
      // bucket 을 갱신하지 않으므로 다음 틱에서 다시 시도한다. 연속 실패 때 폭주하지 않게 잠깐 쉰다.
      await sleep(10_000);
    } finally {
      st.scanning = false;
    }
  }

  toItem(m, tf, d, closed, rsiArr) {
    const last = closed[closed.length - 1];
    const sec = TF_SECONDS[tf];
    return {
      id: `${m.symbol}|${tf}|${d.side}|${d.kind}|${d.status}`,
      symbol: m.symbol,
      base: m.base,
      tf,
      side: d.side,
      kind: d.kind,
      status: d.status,
      p1: d.p1,
      p2: d.p2,
      ageBars: d.ageBars,
      spanBars: d.spanBars,
      rsiDiff: d.rsiDiff,
      pricePct: d.pricePct,
      inZone: d.inZone,
      lastClose: last.c,
      rsiNow: rsiArr[rsiArr.length - 1],
      // 두 번째 피벗이 찍힌 시각과, 마지막으로 확인한 봉의 마감 시각
      p2Time: d.p2.rt,
      checkedThrough: last.t + sec,
      nonCrypto: isNonCrypto(m.base),
      url: this.provider.tradeUrl(m.symbol)
    };
  }

  // ----------------------------------------------------------------- 조회
  /** 완료된 결과가 있으면 그것을, 첫 검사가 진행 중이면 지금까지 찾은 것을 보여준다. */
  itemsOf(tf) {
    const st = this.byTf[tf];
    return st.items || st.partial || [];
  }

  query({ tfs, side = 'all', kind = 'all', status = 'all', maxAge = 40, zoneOnly = false,
    includeNonCrypto = false, q = '', sort = 'recent', limit = 500 }) {
    const needle = String(q || '').trim().toUpperCase();
    const out = [];
    for (const tf of tfs) {
      if (!this.byTf[tf]) continue;
      for (const it of this.itemsOf(tf)) {
        if (side !== 'all' && it.side !== side) continue;
        if (kind !== 'all' && it.kind !== kind) continue;
        if (status !== 'all' && it.status !== status) continue;
        if (it.ageBars > maxAge) continue;
        if (zoneOnly && !it.inZone) continue;
        if (!includeNonCrypto && it.nonCrypto) continue;
        if (needle && !it.base.toUpperCase().includes(needle)) continue;
        const mk = this.marketMap.get(it.symbol);
        out.push({
          ...it,
          price: mk ? mk.last : it.lastClose,
          change24h: mk ? mk.change24h : null,
          quoteVolume: mk ? mk.quoteVolume : null
        });
      }
    }

    const tfRank = (tf) => TF_SECONDS[tf];
    const sorters = {
      // 최근에 만들어진 순. 같은 봉 수면 큰 시간봉을 앞에 둔다. 봉 수가 같아도 시간봉이 다르면
      // 실제 경과 시간이 다르므로 초 단위로 비교한다.
      recent: (a, b) => a.ageBars * TF_SECONDS[a.tf] - b.ageBars * TF_SECONDS[b.tf] || tfRank(b.tf) - tfRank(a.tf),
      rsi: (a, b) => b.rsiDiff - a.rsiDiff,
      volume: (a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0)
    };
    out.sort(sorters[sort] || sorters.recent);

    const counts = { bull: 0, bear: 0 };
    for (const it of out) counts[it.side]++;
    return { total: out.length, counts, items: out.slice(0, limit) };
  }

  status() {
    return {
      exchange: this.provider.label,
      exchangeId: this.provider.name,
      universe: this.markets.length,
      marketsAt: this.marketsAt || null,
      topN: this.topN,
      minVolume: this.minVolume,
      timeframes: this.timeframes.map(tf => {
        const s = this.byTf[tf];
        return {
          tf, ready: s.items !== null, scanning: s.scanning, done: s.done, total: s.total,
          errors: s.errors, scannedAt: s.scannedAt, durationMs: s.durationMs,
          count: (s.items || s.partial || []).length
        };
      })
    };
  }

  // ------------------------------------------------------------- 차트 데이터
  hasSymbol(symbol) { return this.marketMap.has(symbol); }

  async chart(symbol, tf) {
    const key = `${symbol}|${tf}`;
    const hit = this.chartCache.get(key);
    if (hit && Date.now() - hit.at < CHART_TTL_MS) return hit.promise;

    const promise = (async () => {
      await this.throttle();
      const raw = await this.provider.candles(symbol, tf, CANDLE_LIMIT);
      const closed = this.closedCandles(raw, tf);
      const res = detect(closed, { ...this.detectOpts, maxAge: 120 });
      const from = Math.max(0, closed.length - 300);
      const base = (this.marketMap.get(symbol) || {}).base || symbol;
      return {
        symbol, base, tf,
        url: this.provider.tradeUrl(symbol),
        candles: closed.slice(from).map(k => ({ time: k.t, open: k.o, high: k.h, low: k.l, close: k.c })),
        rsi: closed.slice(from).map((k, i) => ({ time: k.t, value: res.rsi[from + i] })).filter(p => Number.isFinite(p.value)),
        divergences: res.divergences.filter(d => d.p1.rt >= closed[from].t)
      };
    })();

    this.chartCache.set(key, { at: Date.now(), promise });
    promise.catch(() => this.chartCache.delete(key));   // 실패는 캐시하지 않는다
    // 오래된 항목 정리
    if (this.chartCache.size > 200) {
      for (const [k, v] of this.chartCache) if (Date.now() - v.at > CHART_TTL_MS) this.chartCache.delete(k);
    }
    return promise;
  }
}

module.exports = { Scanner };
