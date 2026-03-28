window.onerror = function(msg, src, line, col, err) {
  const el = document.getElementById('toast');
  if (el) { el.textContent = 'Error: ' + msg; el.className = 'show error'; setTimeout(() => el.className = '', 5000); }
  console.error('Unhandled error:', msg, src, line, col, err);
  return true;
};
window.onunhandledrejection = function(e) {
  const msg = e.reason?.message || String(e.reason);
  const el = document.getElementById('toast');
  if (el) { el.textContent = 'Error: ' + msg; el.className = 'show error'; setTimeout(() => el.className = '', 5000); }
  console.error('Unhandled rejection:', e.reason);
};

const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const PAGE_SIZE = 100;
const state = {
  config: Object.fromEntries(['metaToken','accountId','claudeKey'].map(k => [k, localStorage.getItem(k) || ''])),
  ads: { current: [], previous: [], period: null },
  creatives: { current: [], previous: [], period: null },
  chatMessages: [],
  sort: { ads: { key: 'spend', dir: 1 }, creatives: { key: 'spend', dir: 1 } },
  filters: { ads: {}, creatives: {} },
  pageLimit: { ads: PAGE_SIZE, creatives: PAGE_SIZE },
};

// Table config
const METRIC_COLS = ['spend','roas','cpr','aov','cpm','ctr','cpc'];
const TABLES = {
  ads: {
    cols: 9, idKey: 'ad_name', searchCols: [1],
    columns: [
      null,
      { key: 'ad_name', type: 'text' },
      { key: 'spend', type: 'metric' },
      { key: 'roas', type: 'metric' },
      { key: 'cpr', type: 'metric' },
      { key: 'aov', type: 'metric' },
      { key: 'cpm', type: 'metric' },
      { key: 'ctr', type: 'metric' },
      { key: 'cpc', type: 'metric' },
    ],
    row: (r, p) => `<tr><td>${thumb(r.thumbnail_url, r.image_url)}</td><td class="td-name" title="${esc(r.ad_name)}">${esc(r.ad_name)}</td>${metrics(r, p)}</tr>`
  },
  creatives: {
    cols: 11, idKey: 'creative_id', searchCols: [1, 2, 3],
    columns: [
      null,
      { key: 'primary_text', type: 'text' },
      { key: 'format', type: 'select' },
      { key: 'ad_name', type: 'text' },
      { key: 'spend', type: 'metric' },
      { key: 'roas', type: 'metric' },
      { key: 'cpr', type: 'metric' },
      { key: 'aov', type: 'metric' },
      { key: 'cpm', type: 'metric' },
      { key: 'ctr', type: 'metric' },
      { key: 'cpc', type: 'metric' },
    ],
    row: (r, p) => {
      const f = r.format?.toLowerCase();
      return `<tr><td>${thumb(r.thumbnail_url, r.image_url)}</td><td class="td-name" title="${esc(r.primary_text)}">${esc(r.primary_text)}</td><td>${f ? `<span class="fmt-badge ${f}">${esc(r.format)}</span>` : ''}</td><td class="td-name" title="${esc(r.ad_name)}">${esc(r.ad_name)}</td>${metrics(r, p)}</tr>`;
    }
  }
};

// Cache
const cacheKey = (t, d) => `meta_cache_${state.config.accountId}_${t}_${d}`;
const saveCache = (t, d, v) => { try { localStorage.setItem(cacheKey(t, d), JSON.stringify(v)); } catch {} };
const loadCache = (t, d) => { try { return JSON.parse(localStorage.getItem(cacheKey(t, d))); } catch { return null; } };

// Init
window.addEventListener('DOMContentLoaded', async () => {
  // Fetch server-side config and show status
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    state.serverConfig = cfg;
    if (cfg.hasMetaToken) state.config.metaToken = '__SERVER__';
    if (cfg.hasAdAccountId) state.config.accountId = '__SERVER__';
    if (cfg.hasClaudeKey) state.config.claudeKey = '__SERVER__';
    const items = [
      ['Meta Token', cfg.hasMetaToken],
      ['Account ID', cfg.hasAdAccountId],
      ['Anthropic Key', cfg.hasClaudeKey],
    ];
    $('cfgStatusList').innerHTML = items.map(([name, ok]) =>
      `<div style="color:${ok ? '#28a745' : '#6c757d'}">${ok ? '\u2713' : '\u2717'} ${name}</div>`
    ).join('');
  } catch {}
  updateStatus();
  if (state.config.accountId) {
    const days = $('periodSelect').value;
    let hasLocal = false;
    for (const type of ['ads', 'creatives']) {
      const cached = loadCache(type, days);
      if (cached) { state[type] = cached; renderTable(type); showCacheTime(type, cached.cached_at); hasLocal = true; }
    }
    if (!hasLocal) fetchAll(false); // auto-load from server cache
    updateCtxSummary();
  }
});


function updateStatus() {
  const ok = !!(state.config.metaToken && state.config.accountId);
  $('apiStatus').className = 'status-dot ' + (ok ? 'ok' : 'err');
  $('apiStatusText').textContent = ok ? 'Connected' : 'Not configured';
}

function showCacheTime(type, iso) {
  const el = $(type + 'CachedAt');
  if (!el || !iso) { if (el) el.textContent = ''; return; }
  const d = new Date(iso);
  el.textContent = `Updated ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} ${d.toLocaleDateString('en-US')}`;
}

// Navigation
function showPage(name) {
  $$('.page').forEach(p => p.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $('page-' + name).classList.add('active');
  const nav = [...$$('.nav-item')].find(n => n.getAttribute('onclick')?.includes(`'${name}'`));
  if (nav) nav.classList.add('active');
}

// Fetch
async function fetchAll(refresh = true) {
  if (!state.config.metaToken || !state.config.accountId)
    return toast('Please enter Meta Token and Account ID first', 'error');

  const days = $('periodSelect').value;
  const headers = {};
  if (state.config.metaToken && state.config.metaToken !== '__SERVER__') headers['x-meta-token'] = state.config.metaToken;
  if (state.config.accountId && state.config.accountId !== '__SERVER__') headers['x-meta-account-id'] = state.config.accountId;

  // Show loading overlay on each table
  for (const t of ['ads', 'creatives']) {
    const wrap = $(t + 'Table').closest('.table-wrap');
    let ov = wrap.querySelector('.load-overlay');
    if (!ov) { ov = document.createElement('div'); ov.className = 'load-overlay'; wrap.appendChild(ov); }
    ov.innerHTML = `<div class="load-popup"><div class="loader"></div><div class="load-text" id="loadProgress-${t}">Connecting...</div></div>`;
    ov.style.display = 'flex';
  }

  const startTime = performance.now();
  try {
    const res = await fetch(`/api/dashboard?days=${days}${refresh ? '&refresh=1' : ''}`, { headers });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', data = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const j = JSON.parse(line.slice(6));
          if (j.progress) {
            $$('.load-text').forEach(el => el.textContent = j.progress);
          }
          if (j.result) data = j.result;
          if (j.error) throw new Error(j.error + ': ' + JSON.stringify(j.detail));
        } catch (e) { if (e.message) throw e; }
      }
    }

    if (!data) throw new Error('No data received');

    state.ads = { current: data.ads.current, previous: data.ads.previous, period: data.period };
    state.creatives = { current: data.creatives.current, previous: data.creatives.previous, period: data.period };

    saveCache('ads', days, state.ads);
    saveCache('creatives', days, state.creatives);
    renderTable('ads');
    renderTable('creatives');
    showCacheTime('ads', data.cached_at);
    showCacheTime('creatives', data.cached_at);
    updateCtxSummary();

    $$('.load-overlay').forEach(el => el.style.display = 'none');
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    $('apiStatus').className = 'status-dot ok';
    $('apiStatusText').textContent = `Loaded in ${elapsed}s`;
    $('apiStatusText').style.color = '';
    toast(`Loaded ${data.ads.current.length} ads and ${data.creatives.current.length} creatives in ${elapsed}s`, 'success');
  } catch (err) {
    $$('.load-overlay').forEach(el => el.style.display = 'none');
    $('apiStatus').className = 'status-dot err';
    $('apiStatusText').textContent = 'Error';
    $('apiStatusText').style.color = '';
    toast('Error: ' + err.message, 'error');
    for (const t of ['ads', 'creatives']) $(t + 'Body').innerHTML = empty(TABLES[t].cols);
  }
}

// Data helpers
function enrichRow(row) {
  const findAction = (arr, type) => (arr || []).find(x => x.action_type === type || x.action_type === 'omni_' + type);
  const pc = row.purchase_count ?? parseFloat(findAction(row.actions, 'purchase')?.value || 0);
  const pv = row.purchase_value ?? parseFloat(findAction(row.action_values, 'purchase')?.value || 0);
  const roas = row.purchase_roas ? parseFloat(Array.isArray(row.purchase_roas) ? (row.purchase_roas[0]?.value || 0) : row.purchase_roas) : 0;
  return { ...row, roas, cpr: pc ? parseFloat(row.spend || 0) / pc : 0, aov: pc && pv ? pv / pc : 0 };
}

// Render
function renderTable(type) {
  const cfg = TABLES[type];
  const data = state[type];
  const prevEnriched = data.previous.map(enrichRow);
  const prevMap = {};
  prevEnriched.forEach(r => prevMap[r[cfg.idKey]] = r);
  const { key, dir } = state.sort[type];
  const sorted = data.current.map(enrichRow).sort((a, b) => (parseFloat(b[key] || 0) - parseFloat(a[key] || 0)) * dir);

  // Store enriched data for filtering + previous totals for delta
  state[type]._enriched = sorted;
  state[type]._prevEnriched = prevEnriched;

  if (data.period) $(type + 'PeriodLabel').textContent = `${data.period.current.since} - ${data.period.current.until} vs ${data.period.previous.since} - ${data.period.previous.until}`;

  // Filter first, then paginate
  const filtered = applyFilters(type, sorted);
  const limit = state.pageLimit[type];
  const page = filtered.slice(0, limit);

  let html = page.map(r => cfg.row(r, prevMap[r[cfg.idKey]] || {})).join('');
  if (filtered.length > limit) {
    html += `<tr class="show-more-row"><td colspan="${cfg.cols}"><button class="btn-show-more" onclick="showMore('${type}')">Show more (${filtered.length - limit} remaining)</button></td></tr>`;
  }
  $(type + 'Body').innerHTML = html || empty(cfg.cols);

  const typeLabel = type === 'ads' ? 'ad names' : 'creatives';
  $(type + 'Count').textContent = filtered.length < sorted.length
    ? `${Math.min(page.length, filtered.length)}/${sorted.length} ${typeLabel}`
    : `${sorted.length} ${typeLabel}`;

  $$(`#${type}Table thead th`).forEach(th => {
    th.classList.toggle('sorted', th.dataset.sort === key);
  });
  buildTotalRow(type, filtered, prevMap, cfg);
}

function showMore(type) {
  state.pageLimit[type] += PAGE_SIZE;
  renderTable(type);
}

function sortTable(type, key) {
  const s = state.sort[type];
  s.dir = s.key === key ? s.dir * -1 : 1;
  s.key = key;
  state.pageLimit[type] = PAGE_SIZE;
  renderTable(type);
}

// Pure filter: returns filtered subset of rows
function applyFilters(type, rows) {
  const metricFilters = state.filters[type];

  // Collect text/select filters from header row
  const colFilters = {};
  $$(`#${type}Table thead [data-col]`).forEach(el => {
    const col = el.dataset.col;
    const t = el.dataset.type;
    const v = el.value.trim();
    if (v && !(t === 'select' && v === '')) colFilters[col] = { type: t, value: v };
  });

  const hasFilters = Object.keys(colFilters).length > 0 || Object.keys(metricFilters).length > 0;
  if (!hasFilters) return rows;

  return rows.filter(row => {
    for (const [col, f] of Object.entries(colFilters)) {
      if (f.type === 'text') {
        if (!String(row[col] || '').toLowerCase().includes(f.value.toLowerCase())) return false;
      } else if (f.type === 'select') {
        if (f.value && String(row[col] || '') !== f.value) return false;
      }
    }
    for (const [col, f] of Object.entries(metricFilters)) {
      const v = parseFloat(row[col] || 0);
      if (f.op === 'gt' && !(v > f.val1)) return false;
      if (f.op === 'lt' && !(v < f.val1)) return false;
      if (f.op === 'between' && !(v >= f.val1 && v <= f.val2)) return false;
      if (f.op === 'notBetween' && !(v < f.val1 || v > f.val2)) return false;
    }
    return true;
  });
}

// Re-filter + re-render (called from filter inputs)
function filterTable(type) {
  state.pageLimit[type] = PAGE_SIZE;
  renderTable(type);
}

function buildTotalRow(type, filtered, prevMap, cfg) {
  if (filtered.length === 0) return;

  const s = k => filtered.reduce((a, r) => a + parseFloat(r[k] || 0), 0);
  const totalSpend = s('spend'), totalImpr = s('impressions'), totalClicks = s('clicks');
  const totalPc = s('purchase_count'), totalPv = s('purchase_value');
  const tRoas = totalSpend ? totalPv / totalSpend : 0;
  const tCpr = totalPc ? totalSpend / totalPc : 0;
  const tAov = totalPc ? totalPv / totalPc : 0;
  const tCpm = totalImpr ? totalSpend / totalImpr * 1000 : 0;
  const tCtr = totalImpr ? totalClicks / totalImpr * 100 : 0;
  const tCpc = totalClicks ? totalSpend / totalClicks : 0;

  const prev = state[type]._prevEnriched || [];
  const ps = k => prev.reduce((a, r) => a + parseFloat(r[k] || 0), 0);
  const pSpend = ps('spend'), pImpr = ps('impressions'), pClicks = ps('clicks');
  const pPc = ps('purchase_count'), pPv = ps('purchase_value');
  const pRoas = pSpend ? pPv / pSpend : 0;
  const pCpr = pPc ? pSpend / pPc : 0;
  const pAov = pPc ? pPv / pPc : 0;
  const pCpm = pImpr ? pSpend / pImpr * 1000 : 0;
  const pCtr = pImpr ? pClicks / pImpr * 100 : 0;
  const pCpc = pClicks ? pSpend / pClicks : 0;

  const totalRow = { spend: totalSpend, roas: tRoas, cpr: tCpr, aov: tAov, cpm: tCpm, ctr: tCtr, cpc: tCpc };
  const prevRow = { spend: pSpend, roas: pRoas, cpr: pCpr, aov: pAov, cpm: pCpm, ctr: pCtr, cpc: pCpc };

  const labelCols = type === 'ads' ? 2 : 4;
  const tr = document.createElement('tr');
  tr.className = 'total-row';
  const emptyTds = '<td></td>'.repeat(labelCols - 1);
  tr.innerHTML = `<td><b>Total (${filtered.length})</b></td>${emptyTds}${metrics(totalRow, prevRow)}`;
  $(type + 'Body').appendChild(tr);
}

// ── Filter Popup ──────────────────────────────────────────────────────────────
let _fpState = { type: null, col: null, btn: null };

function openFilterPopup(type, col, btn) {
  const popup = $('filterPopup');
  _fpState = { type, col, btn };

  // Load existing filter
  const existing = state.filters[type][col];
  $('filterOp').value = existing?.op || 'gt';
  $('filterVal1').value = existing?.val1 ?? '';
  $('filterVal2').value = existing?.val2 ?? '';
  $('filterPopupTitle').textContent = col.toUpperCase() + ' Filter';
  onFilterOpChange();

  // Position popup near button, ensure it stays in viewport
  const rect = btn.getBoundingClientRect();
  popup.style.display = 'block';
  const popH = popup.offsetHeight;
  const popW = popup.offsetWidth;
  const top = rect.bottom + 4 + popH > window.innerHeight ? rect.top - popH - 4 : rect.bottom + 4;
  popup.style.top = Math.max(4, top) + 'px';
  popup.style.left = Math.min(rect.left, window.innerWidth - popW - 8) + 'px';

  // Close on outside click
  setTimeout(() => document.addEventListener('mousedown', _fpOutsideClick), 0);
}

function _fpOutsideClick(e) {
  const popup = $('filterPopup');
  if (!popup.contains(e.target) && e.target !== _fpState.btn) {
    cancelFilter();
  }
}

function onFilterOpChange() {
  const op = $('filterOp').value;
  const isBetween = op === 'between' || op === 'notBetween';
  $('filterAnd').style.display = isBetween ? '' : 'none';
  $('filterVal2').style.display = isBetween ? '' : 'none';
}

function applyFilter() {
  const { type, col } = _fpState;
  const op = $('filterOp').value;
  const val1 = parseFloat($('filterVal1').value);
  if (isNaN(val1)) { cancelFilter(); return; }
  const filter = { op, val1 };
  if (op === 'between' || op === 'notBetween') {
    const val2 = parseFloat($('filterVal2').value);
    if (isNaN(val2)) { cancelFilter(); return; }
    filter.val2 = val2;
  }
  state.filters[type][col] = filter;
  cancelFilter();
  filterTable(type);
  updateFilterBtns(type);
}

function clearCurrentFilter() {
  const { type, col } = _fpState;
  delete state.filters[type][col];
  cancelFilter();
  filterTable(type);
  updateFilterBtns(type);
}

function cancelFilter() {
  $('filterPopup').style.display = 'none';
  document.removeEventListener('mousedown', _fpOutsideClick);
}

function updateFilterBtns(type) {
  $$(`#${type}Table .col-filter-btn`).forEach(btn => {
    const col = btn.dataset.col;
    const f = state.filters[type][col];
    btn.classList.toggle('active', !!f);
    if (f) {
      const opLabels = { gt: '>', lt: '<', between: '', notBetween: '!' };
      const valStr = f.op === 'between' || f.op === 'notBetween' ? `${f.val1}–${f.val2}` : `${opLabels[f.op]}${f.val1}`;
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13L9 8v5l-2 1.5V8z"/></svg> ${valStr}`;
    } else {
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1.5h13L9 8v5l-2 1.5V8z"/></svg>`;
    }
  });
}

// Helpers
const empty = cols => `<tr><td colspan="${cols}"><div class="state-box">No data</div></td></tr>`;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmtF = n => parseFloat(n || 0).toFixed(2);
const fmtMoney = n => '$' + parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function thumb(url, fullUrl) {
  if (!url) return `<div class="thumb-placeholder"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></div>`;
  const hasFullSize = fullUrl && fullUrl !== url;
  return `<img class="thumb" src="${esc(url)}"${hasFullSize ? ` data-full="${esc(fullUrl)}" onmouseenter="showThumbPreview(event)" onmouseleave="hideThumbPreview()"` : ''} alt="" loading="lazy">`;
}

const _thumbPreview = (() => {
  const el = document.createElement('img');
  el.style.cssText = 'display:none;position:fixed;width:240px;height:240px;object-fit:cover;border-radius:8px;border:1px solid #ced4da;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:9998;background:#fff;pointer-events:none';
  el.onerror = () => { el.style.display = 'none'; };
  document.body.appendChild(el);
  return el;
})();

function showThumbPreview(e) {
  const src = e.target.dataset.full || e.target.src;
  _thumbPreview.onload = function() {
    // Hide if Meta returns a tiny placeholder image
    if (_thumbPreview.naturalWidth < 100 || _thumbPreview.naturalHeight < 100) {
      _thumbPreview.style.display = 'none';
      return;
    }
    _thumbPreview.style.display = 'block';
  };
  _thumbPreview.src = src;
  const rect = e.target.getBoundingClientRect();
  let top = rect.top + rect.height / 2 - 120;
  let left = rect.right + 10;
  if (left + 240 > window.innerWidth) left = rect.left - 250;
  if (top + 240 > window.innerHeight) top = window.innerHeight - 244;
  if (top < 4) top = 4;
  _thumbPreview.style.top = top + 'px';
  _thumbPreview.style.left = left + 'px';
}

function hideThumbPreview() {
  _thumbPreview.style.display = 'none';
}

function deltaCell(curr, prev, fmt, invert) {
  const cv = parseFloat(curr || 0), pv = parseFloat(prev || 0);
  const pct = pv ? (cv - pv) / pv * 100 : 0;
  const good = invert ? pct < 0 : pct > 0;
  const cls = Math.abs(pct) < 1 ? 'flat' : good ? 'up' : 'down';
  return `<div class="delta-cell"><span>${fmt(cv)}</span><span class="delta-pill ${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</span></div>`;
}

function metrics(row, prev) {
  return [
    [row.spend, prev.spend, fmtMoney], [row.roas, prev.roas, v => fmtF(v) + 'x'],
    [row.cpr, prev.cpr, fmtMoney, true], [row.aov, prev.aov, fmtMoney],
    [row.cpm, prev.cpm, fmtMoney, true], [row.ctr, prev.ctr, v => fmtF(v) + '%'],
    [row.cpc, prev.cpc, fmtMoney, true],
  ].map(([c, p, f, inv]) => `<td>${deltaCell(c, p, f, inv)}</td>`).join('');
}

// Chat
async function sendMessage() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;

  const apiKey = state.config.claudeKey;
  if (!apiKey) return toast('Anthropic API Key not configured', 'error');

  const container = $('chatMessages');
  state.chatMessages.push({ role: 'user', content: text });
  appendMsg('user', text, 'You');
  input.value = '';
  input.style.height = 'auto';

  const typingEl = document.createElement('div');
  typingEl.className = 'msg assistant';
  typingEl.innerHTML = '<div class="msg-bubble"><div class="typing-indicator"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div></div>';
  container.appendChild(typingEl);
  scrollChat();

  const context = {};
  if (state.ads.current.length) { context.ads = state.ads; context.period = state.ads.period; }
  if (state.creatives.current.length) { context.creatives = state.creatives; }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(state.config.claudeKey && state.config.claudeKey !== '__SERVER__' ? {'x-claude-key': state.config.claudeKey} : {}) },
      body: JSON.stringify({ messages: state.chatMessages, context }),
    });

    if (!res.ok) {
      const raw = await res.text();
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(raw); msg = j.error + (j.hint ? '\n' + j.hint : ''); } catch {}
      throw new Error(msg);
    }

    typingEl.innerHTML = '<div class="msg-bubble"></div><div class="msg-meta">Claude</div>';
    const bubble = typingEl.querySelector('.msg-bubble');

    let fullText = '', buf = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') break;
        try {
          const j = JSON.parse(payload);
          if (j.error) throw new Error(j.error);
          fullText += j.text || '';
          bubble.innerHTML = renderMd(fullText);
          scrollChat();
        } catch (e) { if (e.message) { fullText = 'Error: ' + e.message; bubble.textContent = fullText; bubble.style.color = '#dc3545'; } }
      }
    }
    state.chatMessages.push({ role: 'assistant', content: fullText });
  } catch (err) {
    typingEl.innerHTML = `<div class="msg-bubble" style="color:#dc3545">${esc('Error: ' + err.message)}</div><div class="msg-meta">Claude</div>`;
    state.chatMessages.push({ role: 'assistant', content: 'Error: ' + err.message });
  }
}

function appendMsg(role, text, label) {
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = `<div class="msg-bubble">${esc(text)}</div><div class="msg-meta">${label}</div>`;
  $('chatMessages').appendChild(el);
  scrollChat();
}

function scrollChat() { const c = $('chatMessages'); if (c) c.scrollTop = c.scrollHeight; }

// Lightweight markdown → HTML (bold, italic, headers, lists, code blocks, inline code)
function renderMd(text) {
  return esc(text)
    // Code blocks (``` ... ```)
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Headers
    .replace(/^### (.+)$/gm, '<strong style="font-size:14px">$1</strong>')
    .replace(/^## (.+)$/gm, '<strong style="font-size:15px">$1</strong>')
    .replace(/^# (.+)$/gm, '<strong style="font-size:16px">$1</strong>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Unordered lists
    .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    // Line breaks (but not inside pre/ul)
    .replace(/\n/g, '<br>');
}

function updateCtxSummary() {
  const a = state.ads.current.length, c = state.creatives.current.length;
  if (!a && !c) { $('ctxSummary').innerHTML = 'No data loaded yet.'; return; }
  const adsCtx = state.ads.current.filter(r => parseFloat(r.spend || 0) > 10);
  const creCtx = state.creatives.current.filter(r => parseFloat(r.spend || 0) > 10);
  const adsPrev = (state.ads.previous || []).filter(r => parseFloat(r.spend || 0) > 10);
  const crePrev = (state.creatives.previous || []).filter(r => parseFloat(r.spend || 0) > 10);
  // Estimate tokens: ~210 chars per entry ÷ 4
  const entries = adsCtx.length + adsPrev.length + creCtx.length + crePrev.length;
  const estTokens = Math.round(entries * 210 / 4) + 150;
  // Claude Sonnet 4.5: $3/M input tokens
  const estCost = (estTokens / 1000000 * 3).toFixed(4);
  $('ctxSummary').innerHTML = `Loaded: ${a} ads, ${c} creatives<br><br><b>Context for Claude</b> (only ads with spend &gt; $10):<br>${adsCtx.length} ads + ${creCtx.length} creatives<br>Estimated: ~${estTokens.toLocaleString()} tokens (~$${estCost}/message)`;
}

// Toast
let toastTimer;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3500);
}
