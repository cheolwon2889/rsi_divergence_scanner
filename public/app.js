'use strict';

// ===========================================================================
//  화면
//
//  서버가 시간봉별로 이미 검사해 둔 결과를 조건에 맞게 걸러서 보여준다.
//  브라우저는 거래소를 직접 부르지 않는다 (차트 한 종목만 서버를 통해 가져온다).
// ===========================================================================

const $ = (id) => document.getElementById(id);
const TF_SEC = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 };
const STORE_KEY = 'rsiDiv.filters.v1';

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------- 상태
const DEFAULTS = { tfs: null, side: 'all', kind: 'regular', status: 'all', maxAge: '20', sort: 'recent', q: '', zone: false, nonCrypto: false };
let f = loadFilters();
let status = null;
let items = [];
let total = 0;
let counts = { bull: 0, bear: 0 };
let lastQueryKey = '';
let seq = 0;               // 늦게 도착한 옛 응답이 새 결과를 덮어쓰지 않게

function loadFilters() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch (e) { return { ...DEFAULTS }; }
}
function saveFilters() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(f)); } catch (e) { /* 저장이 막혀도 동작에는 문제없다 */ }
}

// ------------------------------------------------------------------- 포맷
const fmtPrice = (n) => {
  if (!Number.isFinite(n)) return '—';
  return Number(n.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 10 });
};
const fmtVol = (n) => {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
};
const fmtDur = (sec) => {
  if (sec < 3600) return `약 ${Math.max(1, Math.round(sec / 60))}분`;
  if (sec < 48 * 3600) return `약 ${Math.round(sec / 3600)}시간`;
  return `약 ${Math.round(sec / 86400)}일`;
};
const fmtAgo = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return `${Math.floor(s / 3600)}시간 전`;
};
const kst = (sec) => new Date(sec * 1000).toLocaleString('ko-KR', {
  timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
});
const sgn = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

const labelOf = (it) => `${it.side === 'bull' ? '상승' : '하락'} ${it.kind === 'regular' ? '일반' : '히든'}`;

// ------------------------------------------------------------------- 요청
async function api(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.message || `요청 실패 (${r.status})`); e.status = r.status; throw e; }
  return d;
}

function notice(html, err) {
  $('notices').innerHTML = html ? `<div class="notice${err ? ' err' : ''}"><div>${html}</div></div>` : '';
}

// ------------------------------------------------------------------- 조건 UI
function buildTfChips() {
  const avail = status.timeframes.map(t => t.tf).sort((a, b) => TF_SEC[a] - TF_SEC[b]);
  if (!f.tfs || !f.tfs.length) f.tfs = ['1h', '4h'].filter(t => avail.includes(t));
  f.tfs = f.tfs.filter(t => avail.includes(t));
  if (!f.tfs.length) f.tfs = [avail[0]];

  $('tfChips').innerHTML = avail.map(t => `<button data-tf="${t}">${t}</button>`).join('');
  syncControls();
}

function syncControls() {
  document.querySelectorAll('#tfChips button').forEach(b => b.classList.toggle('on', f.tfs.includes(b.dataset.tf)));
  document.querySelectorAll('.seg').forEach(seg => {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === f[seg.dataset.key]));
  });
  $('maxAge').value = f.maxAge;
  $('sort').value = f.sort;
  $('q').value = f.q;
  $('zone').checked = f.zone;
  $('nonCrypto').checked = f.nonCrypto;

  // 접어 둔 상태에서도 지금 어떤 조건인지 보이게 한 줄로 요약한다.
  const L = { all: '전체', bull: '상승', bear: '하락', regular: '일반', hidden: '히든', confirmed: '확정', forming: '형성 중' };
  const bits = [f.tfs.join('·'), L[f.side], L[f.kind], L[f.status], `${f.maxAge}봉 이내`];
  if (f.q) bits.push(`"${esc(f.q)}"`);
  if (f.zone) bits.push('과매도·과매수권');
  if (f.nonCrypto) bits.push('주식 포함');
  $('ctlSum').innerHTML = `조건 <b>${bits.join(' · ')}</b>`;
}

function bindControls() {
  $('tfChips').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const t = b.dataset.tf;
    f.tfs = f.tfs.includes(t) ? f.tfs.filter(x => x !== t) : [...f.tfs, t];
    if (!f.tfs.length) f.tfs = [t];                 // 최소 하나는 켜 둔다
    changed();
  });
  document.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    f[seg.dataset.key] = b.dataset.v;
    changed();
  }));
  $('maxAge').addEventListener('change', (e) => { f.maxAge = e.target.value; changed(); });
  $('sort').addEventListener('change', (e) => { f.sort = e.target.value; changed(); });
  $('zone').addEventListener('change', (e) => { f.zone = e.target.checked; changed(); });
  $('nonCrypto').addEventListener('change', (e) => { f.nonCrypto = e.target.checked; changed(); });

  let t = null;
  $('q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { f.q = e.target.value.trim(); changed(); }, 250);
  });

  $('btnRefresh').addEventListener('click', () => { refreshStatus(); refresh(true); });
}

function changed() { saveFilters(); syncControls(); refresh(true); }

// ------------------------------------------------------------------- 결과
function queryString() {
  const p = new URLSearchParams({
    tf: f.tfs.join(','), side: f.side, kind: f.kind, status: f.status,
    maxAge: f.maxAge, sort: f.sort, q: f.q, limit: '500'
  });
  if (f.zone) p.set('zone', '1');
  if (f.nonCrypto) p.set('nonCrypto', '1');
  return p.toString();
}

async function refresh(force) {
  if (!status) return;
  const qs = queryString();
  const mine = ++seq;
  try {
    const d = await api(`/api/divergences?${qs}`);
    if (mine !== seq) return;                       // 더 새로운 요청이 있으면 버린다
    items = d.items; total = d.total; counts = d.counts;
    lastQueryKey = qs;
    renderRows();
  } catch (e) {
    if (mine === seq) notice(esc(e.message || '결과를 불러오지 못했습니다.'), true);
  }
}

function renderSummary() {
  $('summary').innerHTML = `
    <span>조건에 맞는 신호 <b style="color:var(--text)">${total}</b>개</span>
    <span class="pill up">상승 ${counts.bull}</span>
    <span class="pill down">하락 ${counts.bear}</span>
    ${total > items.length ? `<span>(상위 ${items.length}개만 표시)</span>` : ''}`;
}

function renderRows() {
  renderSummary();
  const tfReady = status.timeframes.filter(t => f.tfs.includes(t.tf));
  const scanning = tfReady.some(t => !t.ready);

  if (!items.length) {
    $('rows').innerHTML = '';
    $('empty').hidden = false;
    $('empty').textContent = scanning
      ? '첫 검사를 진행 중입니다. 끝나기 전에도 찾은 만큼은 위에 나타납니다.'
      : '조건에 맞는 신호가 없습니다. 최근 봉 수를 늘리거나 종류를 "전체"로 바꿔 보세요.';
    return;
  }
  $('empty').hidden = true;

  $('rows').innerHTML = items.map((it, i) => {
    const bull = it.side === 'bull';
    const priceChg = ((it.p2.price - it.p1.price) / it.p1.price) * 100;
    const ageSec = it.ageBars * TF_SEC[it.tf];
    const zoneTag = it.inZone ? `<span class="tag zone">${bull ? '과매도권' : '과매수권'}</span>` : '';
    const chg = Number.isFinite(it.change24h)
      ? `<span class="sub ${it.change24h >= 0 ? 'pos' : 'neg'}">${sgn(it.change24h)}</span>` : '';

    return `<tr data-i="${i}" title="두 번째 피벗: ${esc(kst(it.p2Time))} (한국시간)">
      <td><span class="coin">${esc(it.base)}</span><span class="sub">${fmtVol(it.quoteVolume)}${it.nonCrypto ? ' · 비코인(추정)' : ''}</span></td>
      <td class="tfb">${esc(it.tf)}</td>
      <td><span class="sig">
        <span class="tag ${it.side}">${labelOf(it)}</span>
        ${it.status === 'forming' ? '<span class="tag forming">형성 중</span>' : ''}
        ${zoneTag}
      </span></td>
      <td class="num">${fmtPrice(it.price)}${chg}</td>
      <td class="num hide-sm">${fmtPrice(it.p1.price)}<span class="arrow">→</span>${fmtPrice(it.p2.price)}<span class="sub ${priceChg >= 0 ? 'pos' : 'neg'}">${sgn(priceChg)}</span></td>
      <td class="num">${it.p1.rsi.toFixed(1)}<span class="arrow">→</span>${it.p2.rsi.toFixed(1)}<span class="sub">현재 ${Number.isFinite(it.rsiNow) ? it.rsiNow.toFixed(1) : '—'}</span></td>
      <td class="num">${it.ageBars}봉 전<span class="sub">${fmtDur(ageSec)}</span></td>
    </tr>`;
  }).join('');
}

// ------------------------------------------------------------------- 상태
async function refreshStatus() {
  try {
    const first = !status;
    status = await api('/api/status');
    $('exBadge').textContent = status.exchange;
    if (first) { buildTfChips(); }
    renderStatus();
    return first;
  } catch (e) {
    notice(esc(e.message || '서버에 연결하지 못했습니다.'), true);
    return false;
  }
}

function renderStatus() {
  const sel = status.timeframes.filter(t => f.tfs.includes(t.tf));
  const busy = sel.find(t => t.scanning);
  const pending = sel.filter(t => !t.ready);

  if (busy) {
    $('scanMeta').textContent = `${busy.tf} 검사 중 ${busy.done}/${busy.total}`;
  } else {
    const parts = sel.filter(t => t.scannedAt).map(t => `${t.tf} ${fmtAgo(t.scannedAt)}`);
    $('scanMeta').textContent = parts.length ? `검사: ${parts.join(' · ')}` : '준비 중…';
  }

  if (pending.length) {
    const pct = (t) => (t.total ? Math.round((t.done / t.total) * 100) : 0);
    notice(`첫 검사를 진행 중입니다 — ${pending.map(t => `<b>${t.tf}</b> ${t.scanning ? `${t.done}/${t.total}` : '대기'}`).join(' · ')}
      <div class="bar"><i style="width:${Math.max(...pending.map(pct), 3)}%"></i></div>
      <div style="margin-top:6px;font-size:12.5px;opacity:.85">무료 서버는 잠들었다 깨면 처음부터 다시 검사합니다. 끝나기 전에도 찾은 만큼은 아래에 보입니다.</div>`);
  } else {
    notice('');
  }
}

let scanStamp = '';
async function pollStatus() {
  if (document.hidden) return;
  await refreshStatus();
  if (!status) return;
  // 검사가 새로 끝났거나 진행 중이면 결과도 다시 받는다.
  const stamp = status.timeframes.map(t => `${t.scannedAt}:${t.scanning ? t.done : 'x'}`).join('|');
  if (stamp !== scanStamp) { scanStamp = stamp; refresh(false); }
}

// ------------------------------------------------------------------- 차트
const modal = { item: null, tf: null, data: null, sel: null };

async function openChart(it) {
  modal.item = it; modal.tf = it.tf; modal.sel = `${it.side}|${it.kind}|${it.status}`;
  $('modal').hidden = false;
  document.body.style.overflow = 'hidden';
  $('mTitle').textContent = `${it.base} · ${it.tf}`;
  $('mSub').textContent = '불러오는 중…';
  $('mLink').href = it.url;
  $('mNotice').innerHTML = '';
  $('mLegend').innerHTML = '';
  buildModalTf();
  await loadChart();
}

function buildModalTf() {
  const avail = status.timeframes.map(t => t.tf).sort((a, b) => TF_SEC[a] - TF_SEC[b]);
  $('mTf').innerHTML = avail.map(t => `<button data-tf="${t}" class="${t === modal.tf ? 'on' : ''}">${t}</button>`).join('');
}

async function loadChart() {
  const it = modal.item;
  try {
    const d = await api(`/api/chart?symbol=${encodeURIComponent(it.symbol)}&tf=${encodeURIComponent(modal.tf)}`);
    if ($('modal').hidden || modal.item !== it) return;
    modal.data = d;
    if (!d.divergences.some(x => `${x.side}|${x.kind}|${x.status}` === modal.sel) && d.divergences.length) {
      const x = d.divergences[0]; modal.sel = `${x.side}|${x.kind}|${x.status}`;
    }
    $('mTitle').textContent = `${d.base} · ${d.tf}`;
    $('mSub').textContent = `마감된 봉 기준 · 시각은 한국시간 · 최근 ${d.candles.length}봉`;
    $('mLink').href = d.url;
    $('mNotice').innerHTML = d.divergences.length ? '' : '<div class="notice">이 시간봉에는 현재 다이버전스가 없습니다.</div>';
    DivChart.render($('chartPrice'), $('chartRsi'), d, modal.sel);
    renderLegend();
  } catch (e) {
    $('mNotice').innerHTML = `<div class="notice err">${esc(e.message || '차트를 불러오지 못했습니다.')}</div>`;
  }
}

function renderLegend() {
  const ds = modal.data ? modal.data.divergences : [];
  $('mLegend').innerHTML = ds.map(d => {
    const key = `${d.side}|${d.kind}|${d.status}`;
    const bull = d.side === 'bull';
    return `<button data-key="${key}" class="${key === modal.sel ? 'on' : ''}">
      <span class="tag ${d.side}">${bull ? '상승' : '하락'} ${d.kind === 'regular' ? '일반' : '히든'}</span>
      ${d.status === 'forming' ? '<span class="tag forming">형성 중</span>' : ''}
      <span class="mono">가격 ${fmtPrice(d.p1.price)} → ${fmtPrice(d.p2.price)}</span>
      <span class="mono">RSI ${d.p1.rsi.toFixed(1)} → ${d.p2.rsi.toFixed(1)}</span>
      <span class="mono">${d.ageBars}봉 전 · ${esc(kst(d.p2.rt))}</span>
    </button>`;
  }).join('');
}

function closeChart() {
  $('modal').hidden = true;
  document.body.style.overflow = '';
  DivChart.destroy();
  modal.item = null; modal.data = null;
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
  $('mLegend').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    modal.sel = b.dataset.key;
    DivChart.render($('chartPrice'), $('chartRsi'), modal.data, modal.sel);
    renderLegend();
  });
  $('rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const it = items[Number(tr.dataset.i)];
    if (it) openChart(it);
  });
}

// ------------------------------------------------------------------- 시작
(async function init() {
  bindControls();
  bindModal();
  if (window.innerWidth < 760) $('ctl').open = false;   // 모바일은 결과가 먼저 보이게 접어 둔다
  await refreshStatus();
  if (!status) return;
  scanStamp = status.timeframes.map(t => `${t.scannedAt}:${t.scanning ? t.done : 'x'}`).join('|');
  await refresh(true);

  // 검사 중이면 자주, 아니면 천천히 상태를 확인한다.
  const loop = async () => {
    await pollStatus();
    const busy = status && status.timeframes.some(t => t.scanning || !t.ready);
    setTimeout(loop, busy ? 3000 : 20000);
  };
  setTimeout(loop, 3000);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollStatus(); });
})();
