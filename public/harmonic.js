/* global LightweightCharts */
'use strict';

// ===========================================================================
//  하모닉 PRZ 목록과 차트
//
//  /api/harmonic 은 서버가 감시하는 구조 목록이다. 구간마다 한 줄씩 보여 준다.
//  행을 누르면 /api/harmonic/chart 로 캔들과 패턴 점을 받아 차트에 그린다.
//  차트 시각은 한국시간으로 보이도록 9시간을 더한다 (chart.js 와 같은 방식).
// ===========================================================================

const $ = (id) => document.getElementById(id);
const KST = 9 * 3600;
const BULL = '#15C47E';
const BEAR = '#F04452';
const ZONE_COLOR = { '대기': '#7FB0FF', '도달': '#3182F6', '반등 확인': BULL, '이탈': '#8B95A1' };

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let status = null;          // /api/harmonic 응답
let rows = [];              // 화면에 보이는 구간 목록
let tfOn = new Set();       // 켜 둔 시간봉
let seq = 0;

// ------------------------------------------------------------------ 포맷
function fmtPrice(n) {
  if (!Number.isFinite(n)) return '—';
  return Number(n.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 10 });
}
const kst = (sec) => new Date(sec * 1000).toLocaleString('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
});
const fmtAgo = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
};

async function api(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.message || `요청 실패 (${r.status})`); throw e; }
  return d;
}

function notice(html, err) {
  $('notices').innerHTML = html ? `<div class="notice${err ? ' err' : ''}"><div>${html}</div></div>` : '';
}

// ------------------------------------------------------------- 상태 판정
/** 구간이 지금 어떤 단계인지. 서버 상태 + 접근(상단 nearPct 이내) 여부. */
function stateOf(zone, price, nearPct) {
  if (zone.status === '대기' && price > zone.hi && (price - zone.hi) / zone.hi * 100 <= nearPct) return '접근 중';
  return zone.status;
}

function distanceOf(zone, price) {
  if (!Number.isFinite(price)) return { text: '—', cls: '' };
  if (price > zone.hi) {
    const p = ((price - zone.hi) / zone.hi) * 100;
    return { text: `+${p.toFixed(2)}%`, cls: p <= (status.nearPct || 1) ? 'dist-up' : '' };
  }
  if (price < zone.lo) return { text: `${(((price - zone.lo) / zone.lo) * 100).toFixed(2)}%`, cls: 'dist-below' };
  return { text: '구간 안', cls: 'dist-in' };
}

function passesFilter(state, mode) {
  if (mode === 'all') return true;
  if (mode === 'live') return state !== '이탈';
  if (mode === 'near') return state === '접근 중';
  if (mode === 'touch') return state === '도달' || state === '반등 확인';
  return true;
}

// ------------------------------------------------------------------ 조건
function buildTfChips() {
  const avail = status.timeframes;
  if (!tfOn.size) avail.forEach(t => tfOn.add(t));
  $('tfChips').innerHTML = avail.map(t => `<button data-tf="${t}">${t}</button>`).join('');
  syncChips();
}

function syncChips() {
  document.querySelectorAll('#tfChips button').forEach(b => b.classList.toggle('on', tfOn.has(b.dataset.tf)));
}

function bindControls() {
  $('tfChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const t = b.dataset.tf;
    if (tfOn.has(t)) { if (tfOn.size > 1) tfOn.delete(t); } else tfOn.add(t);
    syncChips();
    render();
  });
  $('status').addEventListener('change', render);
  let timer = null;
  $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 200); });
  $('btnRefresh').addEventListener('click', () => load());
}

// ------------------------------------------------------------------ 목록
function render() {
  if (!status) return;
  const mode = $('status').value;
  const needle = $('q').value.trim().toUpperCase();
  const near = status.nearPct || 1;

  rows = [];
  for (const a of status.active) {
    if (!tfOn.has(a.tf)) continue;
    if (needle && !String(a.base).toUpperCase().includes(needle)) continue;
    for (const z of a.zones) {
      const state = stateOf(z, a.price, near);
      if (!passesFilter(state, mode)) continue;
      rows.push({ a, z, state });
    }
  }
  // 접근·도달·반등을 앞으로, 그 안에서는 현재가가 구간에 가까운 순
  const rank = { '반등 확인': 0, '도달': 1, '접근 중': 2, '대기': 3, '이탈': 4 };
  const gap = (r) => {
    const { a, z } = r;
    if (a.price > z.hi) return (a.price - z.hi) / z.hi;
    if (a.price < z.lo) return (z.lo - a.price) / z.lo;
    return 0;
  };
  rows.sort((x, y) => (rank[x.state] - rank[y.state]) || (gap(x) - gap(y)));

  $('summary').innerHTML = `
    <span>감시 중 구조 <b style="color:var(--text)">${status.active.length}</b>개</span>
    <span class="pill up">접근·도달·반등 ${rows.filter(r => r.state !== '대기' && r.state !== '이탈').length}</span>`;

  if (!rows.length) {
    $('rows').innerHTML = '';
    $('empty').hidden = false;
    $('empty').textContent = status.firstPassDone
      ? '조건에 맞는 구간이 없습니다. 상태를 "전체"로 바꾸거나 시간봉을 더 켜 보세요.'
      : '첫 검사를 진행 중입니다. 끝나면 여기에 나타납니다.';
    return;
  }
  $('empty').hidden = true;

  $('rows').innerHTML = rows.map((r, i) => {
    const d = distanceOf(r.z, r.a.price);
    const cls = { '접근 중': 'near', '도달': 'touch', '반등 확인': 'sig', '이탈': 'pass' }[r.state] || 'wait';
    return `<tr data-i="${i}">
      <td><span class="coin">${esc(r.a.base)}</span></td>
      <td class="tfb">${esc(r.a.tf)}</td>
      <td>${esc(r.z.name)}</td>
      <td class="num">${fmtPrice(r.z.lo)}<span class="arrow">–</span>${fmtPrice(r.z.hi)}</td>
      <td class="num">${fmtPrice(r.a.price)}</td>
      <td class="num ${d.cls}">${d.text}</td>
      <td><span class="st ${cls}">${esc(r.state)}</span></td>
    </tr>`;
  }).join('');
}

async function load() {
  const mine = ++seq;
  try {
    const d = await api('/api/harmonic');
    if (mine !== seq) return;
    if (!d.enabled) { notice('하모닉 감시가 꺼져 있습니다 (HARMONIC=off).', true); return; }
    status = d;
    $('exBadge').textContent = 'Gate.io 선물';
    const ago = d.lastRun ? `검사 ${fmtAgo(d.lastRun)}` : '검사 전';
    $('scanMeta').textContent = d.running ? '검사 중…' : ago;
    if (!tfOn.size || !$('tfChips').children.length) buildTfChips();
    notice(d.firstPassDone ? '' : '첫 검사를 진행 중입니다. 끝나기 전에도 찾은 구간은 바로 보입니다.');
    render();
  } catch (e) {
    notice(esc(e.message || '목록을 불러오지 못했습니다.'), true);
  }
}

// ------------------------------------------------------------------ 차트
const modal = { row: null, tf: null, sym: null, data: null, chart: null, ro: null };

function openChart(row) {
  modal.row = row;
  modal.sym = row.a.symbol;
  modal.tf = row.a.tf;
  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  buildModalTf();
  loadChart();
}

function buildModalTf() {
  $('mTf').innerHTML = status.timeframes.map(t => `<button data-tf="${t}" class="${t === modal.tf ? 'on' : ''}">${t}</button>`).join('');
}

async function loadChart() {
  const sym = modal.sym, tf = modal.tf;
  $('mTitle').textContent = `${modal.row.a.base} · ${tf}`;
  $('mSub').textContent = '불러오는 중…';
  $('mNotice').innerHTML = '';
  $('mLegend').innerHTML = '';
  try {
    const d = await api(`/api/harmonic/chart?symbol=${encodeURIComponent(sym)}&tf=${encodeURIComponent(tf)}`);
    if ($('modal').hidden || modal.sym !== sym || modal.tf !== tf) return;
    modal.data = d;
    $('mLink').href = d.url;
    $('mSub').textContent = `한국시간 · 최근 ${d.candles.length}봉` + (d.lastOpen ? ' · 진행 중인 봉 포함' : '');
    if (!d.structure) {
      $('mNotice').innerHTML = '<div class="notice">지금은 상승 하모닉 패턴이 없습니다. 패턴이 완성되거나 사라지면 바뀝니다.</div>';
    }
    drawChart(d);
    renderLegend(d);
  } catch (e) {
    $('mNotice').innerHTML = `<div class="notice err">${esc(e.message || '차트를 불러오지 못했습니다.')}</div>`;
  }
}

function drawChart(d) {
  const el = $('chart');
  if (modal.chart) { modal.chart.remove(); modal.chart = null; }
  if (modal.ro) { modal.ro.disconnect(); modal.ro = null; }

  const chart = LightweightCharts.createChart(el, {
    width: el.clientWidth, height: el.clientHeight || 420,
    layout: { background: { color: '#1E1E24' }, textColor: '#8B95A1', fontSize: 11 },
    grid: { vertLines: { color: '#26262E' }, horzLines: { color: '#26262E' } },
    rightPriceScale: { borderColor: '#2E2E38', minimumWidth: 70 },
    timeScale: { borderColor: '#2E2E38', timeVisible: true, secondsVisible: false },
    crosshair: { vertLine: { color: '#3182F6', labelBackgroundColor: '#3182F6' }, horzLine: { color: '#3182F6', labelBackgroundColor: '#3182F6' } }
  });
  modal.chart = chart;
  modal.ro = new ResizeObserver(() => { if (el.clientWidth > 0) chart.applyOptions({ width: el.clientWidth }); });
  modal.ro.observe(el);

  const last = d.candles[d.candles.length - 1];
  const p = last && last.close < 1 ? 6 : 2;
  const cs = chart.addCandlestickSeries({
    upColor: BULL, downColor: BEAR, borderUpColor: BULL, borderDownColor: BEAR, wickUpColor: BULL, wickDownColor: BEAR,
    priceFormat: { type: 'price', precision: p, minMove: Math.pow(10, -p) }
  });
  cs.setData(d.candles.map(c => ({ time: c.time + KST, open: c.open, high: c.high, low: c.low, close: c.close })));

  const s = d.structure;
  if (s) {                                              // 서버는 상승 패턴만 계산한다
    const pts = [s.X, s.A, s.B, s.C].filter(Boolean);
    const line = chart.addLineSeries({ color: '#7FB0FF', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    line.setData(pts.map(q => ({ time: q.t + KST, value: q.p })));

    const markers = [];
    const label = (q, text, pos) => markers.push({ time: q.t + KST, position: pos, color: '#7FB0FF', shape: pos === 'aboveBar' ? 'arrowDown' : 'arrowUp', text });
    if (s.X) label(s.X, 'X', 'belowBar');
    label(s.A, 'A', 'aboveBar');
    label(s.B, 'B', 'belowBar');
    label(s.C, 'C', 'aboveBar');

    for (const z of s.zones) {
      const col = ZONE_COLOR[z.status] || '#7FB0FF';
      const tag = `${z.name} ${z.status}`;
      cs.createPriceLine({ price: z.hi, color: col, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `${tag} 상단` });
      cs.createPriceLine({ price: z.lo, color: col, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `${tag} 하단` });
      if (z.touchT) markers.push({ time: z.touchT + KST, position: 'belowBar', color: col, shape: 'circle', text: `${z.name} 도달` });
      if (z.passT) markers.push({ time: z.passT + KST, position: 'belowBar', color: '#8B95A1', shape: 'circle', text: `${z.name} 이탈` });
      if (z.sig && z.sig.valid) {
        markers.push({ time: z.sig.t + KST, position: 'belowBar', color: BULL, shape: 'arrowUp', text: `${z.name} 반등 확인` });
        cs.createPriceLine({ price: z.sig.stop, color: BEAR, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '손절' });
        cs.createPriceLine({ price: z.sig.target, color: BULL, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '목표' });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    cs.setMarkers(markers);
  }

  // 패턴이 있으면 그 앞 15봉부터 보이게 한다. 1000봉 전체를 맞추면 패턴이 오른쪽 끝에 몰린다.
  const PER = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
  const first = s && (s.X || s.A);
  if (first && last) {
    chart.timeScale().setVisibleRange({
      from: first.t + KST - 15 * PER[modal.tf],
      to: last.time + KST + 5 * PER[modal.tf]
    });
  } else {
    chart.timeScale().fitContent();
  }
}

function renderLegend(d) {
  const s = d.structure;
  if (!s) { $('mLegend').innerHTML = ''; return; }
  const ratio = (v) => (Number.isFinite(v) ? v.toFixed(3) : '—');
  $('mLegend').innerHTML = `
    <div class="mono">XAB ${ratio(s.xab)} · ABC ${ratio(s.abc)} · C ${fmtPrice(s.C.p)} (${esc(kst(s.C.t))})</div>
    ${s.zones.map(z => `
      <button class="${z.status === '반등 확인' ? 'on' : ''}" disabled>
        <span class="st ${z.status === '반등 확인' ? 'sig' : z.status === '도달' ? 'touch' : z.status === '이탈' ? 'pass' : 'wait'}">${esc(z.status)}</span>
        <span>${esc(z.name)}</span>
        <span class="mono">구간 ${fmtPrice(z.lo)} – ${fmtPrice(z.hi)}</span>
        ${z.sig && z.sig.valid ? `<span class="mono">손절 ${fmtPrice(z.sig.stop)} · 목표 ${fmtPrice(z.sig.target)}</span>` : ''}
      </button>`).join('')}
    <div class="note">마감된 봉 기준 계산입니다. 진행 중인 봉에서 닿은 것은 도달로 보일 수 있고, 마감되면 바뀔 수 있습니다.</div>`;
}

function closeChart() {
  $('modal').hidden = true;
  document.body.style.overflow = '';
  if (modal.chart) { modal.chart.remove(); modal.chart = null; }
  if (modal.ro) { modal.ro.disconnect(); modal.ro = null; }
  modal.data = null;
}

function bindModal() {
  $('mClose').addEventListener('click', closeChart);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeChart(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeChart(); });
  $('mTf').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.dataset.tf === modal.tf) return;
    modal.tf = b.dataset.tf;
    buildModalTf();
    loadChart();
  });
  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const row = rows[Number(tr.dataset.i)];
    if (row) openChart(row);
  });
}

// ------------------------------------------------------------------ 시작
(function init() {
  bindControls();
  bindModal();
  load();
  setInterval(() => { if (!document.hidden) load(); }, 60_000);
})();
