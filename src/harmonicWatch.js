'use strict';

// ===========================================================================
//  하모닉 PRZ 감시 → 텔레그램
//
//  몇 분마다 거래대금 상위 코인을 시간봉별로 훑고, 상승 하모닉 패턴의 PRZ(롱 트라이 구간)에
//  가격이 다가오거나 들어오면 메시지를 보낸다. 주문은 하지 않는다. 메시지를 보고
//  DOA 를 직접 켜는 용도다.
//
//  보내는 메시지 (같은 패턴 구조에서 단계별로 한 번씩만)
//    📍 접근      PRZ 상단까지 NEAR_PCT % 이내로 내려옴 (아직 안 닿음)
//    🎯 도달      PRZ 에 닿음 — 롱 트라이 구간
//    ✅ 반등 확인  닿은 뒤 종가가 PRZ 상단 위로 돌아옴 (지표의 매수 확인 신호와 같음)
//    ⚠️ 이탈      PRZ 하단 아래로 내려감 — 패턴 무효 가능성
//
//  서버가 켜진 직후 첫 검사에서는 이미 지나간 일을 다시 보내지 않는다.
//  도달·반등·이탈은 최근 2개 봉 안에 일어난 것만, 접근은 켜진 뒤 새로 접근한 것만 보낸다.
// ===========================================================================

const { analyze, DEFAULTS } = require('./harmonic');
const { TF_SECONDS } = require('./exchanges');
const { isNonCrypto } = require('./markets');

const CANDLES = 1000;            // 스윙 4개가 잡힐 만큼 넉넉히 (4시간봉 약 166일)
const FRESH_BARS = 2;            // 이 봉 수 안에 일어난 사건만 "방금 일어난 일"로 본다
const KEEP_MS = 21 * 86400e3;    // 보낸 기록 보관 기간

const fmt = (n) => (Number.isFinite(n) ? String(Number(n.toPrecision(6))) : '—');

class HarmonicWatcher {
  constructor({ scanner, provider, timeframes, notify, intervalMs = 5 * 60e3, nearPct = 1.0, opts = {} }) {
    this.scanner = scanner;          // 종목 목록과 거래소 호출 간격 제한을 같이 쓴다
    this.provider = provider;
    this.timeframes = timeframes;
    this.notify = notify;
    this.intervalMs = intervalMs;
    this.nearPct = nearPct;
    this.opts = { ...DEFAULTS, ...opts };

    this.sent = new Map();           // 키 -> 보낸 시각
    this.zones = new Map();          // `${symbol}|${tf}` -> 지금 살아 있는 PRZ (화면·확인용)
    this.firstPass = true;
    this.running = false;
    this.lastRun = null;
    this.lastDurationMs = null;
    this.lastErrors = 0;
  }

  start() {
    const run = () => this.runOnce().catch(e => console.error('[harmonic] 실패:', e.message));
    setTimeout(run, 20_000);          // 기동 직후 RSI 첫 검사와 겹치지 않게 조금 늦게
    this.timer = setInterval(run, this.intervalMs);
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();
    let errors = 0;
    let messages = 0;
    try {
      const markets = (await this.scanner.ensureMarkets()).filter(m => !isNonCrypto(m.base));
      for (const tf of this.timeframes) {
        for (const m of markets) {
          try {
            await this.scanner.throttle();
            const candles = await this.provider.candles(m.symbol, tf, CANDLES);
            messages += await this.check(m, tf, candles);
          } catch (e) {
            errors++;
            if (errors <= 3) console.warn(`[harmonic] ${tf} ${m.symbol} 실패: ${e.message}`);
          }
        }
      }
      const cutoff = Date.now() - KEEP_MS;
      for (const [k, at] of this.sent) if (at < cutoff) this.sent.delete(k);
      console.log(`[harmonic] 검사 완료 ${markets.length}종목 × ${this.timeframes.join(',')} · 메시지 ${messages}건 · 오류 ${errors}${this.firstPass ? ' (첫 검사)' : ''} · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
      this.firstPass = false;
    } finally {
      this.lastRun = Date.now();
      this.lastDurationMs = Date.now() - t0;
      this.lastErrors = errors;
      this.running = false;
    }
  }

  /** 한 종목·한 시간봉을 보고 보낼 메시지 수를 돌려준다. */
  async check(m, tf, candles) {
    const per = TF_SECONDS[tf];
    const now = Date.now() / 1000;
    const lastOpen = candles.length > 0 && candles[candles.length - 1].t + per > now;
    const r = analyze(candles, this.opts, lastOpen);
    const mapKey = `${m.symbol}|${tf}`;
    if (!r) { this.zones.delete(mapKey); return 0; }

    const n = candles.length;
    const nClosed = lastOpen ? n - 1 : n;
    const price = candles[n - 1].c;
    const isFresh = (idx) => idx >= 0 && idx >= nClosed - FRESH_BARS;

    // 단계별로 묶는다. 같은 구조에서 여러 패턴이 같이 닿으면 한 메시지로 보낸다.
    const stages = { near: [], touch: [], sig: [], pass: [] };
    for (const z of r.zones) {
      // 스윙 10% 기준이면 1시간봉과 4시간봉이 같은 고점·저점을 잡아 같은 PRZ 가 나온다.
      // 시간봉 대신 C 가격으로 키를 잡아서, 같은 구조는 어느 시간봉에서든 한 번만 보낸다.
      const base = `${m.symbol}|${r.C.p}|${z.name}`;
      if (z.passIdx >= 0) { this.mark(`${base}|pass`, isFresh(z.passIdx), stages.pass, z); continue; }
      if (z.sig) {
        this.mark(`${base}|touch`, false, null, z);
        if (z.sig.valid) this.mark(`${base}|sig`, isFresh(z.sig.idx), stages.sig, z);
        continue;
      }
      if (z.touchIdx >= 0) { this.mark(`${base}|touch`, isFresh(z.touchIdx), stages.touch, z); continue; }
      const gap = ((price - z.hi) / z.hi) * 100;
      if (gap > 0 && gap <= this.nearPct) this.mark(`${base}|near`, !this.firstPass, stages.near, z);
    }

    this.zones.set(mapKey, {
      symbol: m.symbol, base: m.base, tf, price, C: r.C.p, X: r.X ? r.X.p : null,
      zones: r.zones.map(z => ({
        name: z.name, lo: z.lo, hi: z.hi,
        status: z.passIdx >= 0 ? '이탈' : z.sig ? '반등 확인' : z.touchIdx >= 0 ? '도달' : '대기'
      }))
    });

    let count = 0;
    const head = `${m.base} ${tf}`;
    const names = (zs) => zs.map(z => z.name).join(', ');
    const range = (zs) => `${fmt(Math.min(...zs.map(z => z.lo)))} ~ ${fmt(Math.max(...zs.map(z => z.hi)))}`;

    if (stages.near.length) {
      const zs = stages.near;
      const top = Math.max(...zs.map(z => z.hi));
      count += await this.send([
        `📍 ${head} PRZ 접근`,
        `패턴: ${names(zs)}`,
        `롱 트라이 구간: ${range(zs)}`,
        `현재가: ${fmt(price)} (구간 상단까지 ${(((price - top) / top) * 100).toFixed(2)}%)`
      ]);
    }
    if (stages.touch.length) {
      const zs = stages.touch;
      count += await this.send([
        `🎯 ${head} 롱 트라이 구간 도달`,
        `패턴: ${names(zs)}`,
        `구간: ${range(zs)}`,
        `현재가: ${fmt(price)}`,
        `하단 ${fmt(Math.min(...zs.map(z => z.lo)))} 아래로 내려가면 무효`
      ]);
    }
    if (stages.sig.length) {
      const z = stages.sig[0];
      count += await this.send([
        `✅ ${head} 반등 확인`,
        `패턴: ${names(stages.sig)} · 구간 ${range(stages.sig)}`,
        `종가 ${fmt(z.sig.close)} · 손절 ${fmt(z.sig.stop)} · 목표 ${fmt(z.sig.target)}`
      ]);
    }
    if (stages.pass.length) {
      const zs = stages.pass;
      count += await this.send([
        `⚠️ ${head} PRZ 하단 이탈`,
        `패턴: ${names(zs)} · 구간 ${range(zs)}`,
        `현재가: ${fmt(price)} — 패턴 무효 가능성. 켜 둔 롱이 있으면 확인하세요.`
      ]);
    }
    return count;
  }

  /** 처음 보는 사건이면 기록하고, 보내야 할 때만 목록에 넣는다. */
  mark(key, shouldSend, list, z) {
    if (this.sent.has(key)) return;
    this.sent.set(key, Date.now());
    if (shouldSend && list) list.push(z);
  }

  async send(lines) {
    await this.notify(lines.join('\n'));
    return 1;
  }

  status() {
    const active = [];
    for (const v of this.zones.values()) active.push(v);
    active.sort((a, b) => a.base.localeCompare(b.base) || a.tf.localeCompare(b.tf));
    return {
      timeframes: this.timeframes, intervalMs: this.intervalMs, nearPct: this.nearPct,
      settings: { devPct: this.opts.devPct, tolPct: this.opts.tolPct, przPct: this.opts.przPct },
      lastRun: this.lastRun, lastDurationMs: this.lastDurationMs, lastErrors: this.lastErrors,
      running: this.running, firstPassDone: !this.firstPass, active
    };
  }
}

module.exports = { HarmonicWatcher };
