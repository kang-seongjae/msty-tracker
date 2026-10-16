// 화면 담당. 입력을 읽어 state 를 바꾸고, calc.js 로 계산한 결과를 화면에 그립니다.

import { computePortfolio, computeReport, simulate, findTargetWeek, addWeeks } from './calc.js';
import { loadState, saveState, exportState, importStateFile, defaultState, STORAGE_KEY, SCENARIO_KEYS } from './storage.js';
import { renderLineChart } from './chart.js';
import { refreshQuotes, loadApiConfig, saveApiConfig, loadQuoteCache, saveQuoteCache, PRICE_PROVIDERS } from './quotes.js';

const SCENARIO_META = {
  optimistic: { label: '낙관', color: 'var(--series-optimistic)' },
  base: { label: '보통', color: 'var(--series-base)' },
  pessimistic: { label: '비관', color: 'var(--series-pessimistic)' },
};

let state = loadState();
let editingId = null;
let chartMetric = 'valueKRW';
let apiConfig = loadApiConfig();
let quoteCache = loadQuoteCache();
let quotesLoading = false;
let prefilled = { price: null, fx: null }; // 기록 폼에 미리 채운 값 (사용자가 고쳤는지 알아보려고 기억)

const $ = (id) => document.getElementById(id);

// ---------- 숫자 표시 ----------
const krw = (v) => `${Math.round(v).toLocaleString('ko-KR')}원`;
const usd = (v, d = 2) => `$${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const sharesFmt = (v) => `${v.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}주`;
const pct = (v) => (v == null ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`);
const signed = (v, fmt) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}`;
const shortKRW = (v) => {
  const a = Math.abs(v);
  if (a >= 1e8) return `${+(v / 1e8).toFixed(2)}억`;
  if (a >= 1e4) return `${+(v / 1e4).toFixed(a >= 1e6 ? 0 : 1)}만`;
  return `${Math.round(v)}`;
};
const today = () => new Date().toISOString().slice(0, 10);
const tone = (node, v) => {
  node.classList.toggle('up', v > 0);
  node.classList.toggle('down', v < 0);
};

// ---------- 저장 ----------
function persist() {
  const ok = saveState(state);
  $('save-status').textContent = ok ? '' : '⚠ 이 브라우저에 저장할 수 없어요. 백업 파일을 꼭 내려받으세요.';
}

function update() {
  persist();
  render();
}

// ---------- 탭 ----------
function showTab(name) {
  document.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[role=tabpanel]').forEach((p) => (p.hidden = p.id !== `tab-${name}`));
  try { sessionStorage.setItem('msty-tab', name); } catch {}
  if (name === 'sim') renderSim();
}
document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

// ---------- 입력칸 <-> state 연결 ----------
function bindNumber(id, get, set) {
  const input = $(id);
  const v = get();
  input.value = v === '' || v == null || v === 0 ? '' : v;
  input.addEventListener('input', () => {
    set(input.value === '' ? 0 : Number(input.value));
    update();
  });
}

bindNumber('market-price', () => state.market.price, (v) => { state.market.price = v; renderQuoteLabels(); });
bindNumber('market-fx', () => state.market.fxRate, (v) => { state.market.fxRate = v; renderQuoteLabels(); });
bindNumber('s-shares', () => state.settings.initialShares, (v) => (state.settings.initialShares = v));
bindNumber('s-avg', () => state.settings.initialAvgCost, (v) => (state.settings.initialAvgCost = v));
bindNumber('s-principal', () => state.settings.principalKRW, (v) => (state.settings.principalKRW = v));
bindNumber('sim-target', () => state.sim.targetKRW, (v) => (state.sim.targetKRW = v));

$('sim-fractional').checked = state.sim.fractional;
$('sim-fractional').addEventListener('change', (e) => { state.sim.fractional = e.target.checked; update(); });

function buildScenarioInputs() {
  const wrap = $('scenario-inputs');
  wrap.innerHTML = '';
  for (const key of SCENARIO_KEYS) {
    const meta = SCENARIO_META[key];
    const sc = state.sim.scenarios[key];
    const box = document.createElement('fieldset');
    box.className = 'scenario';
    box.innerHTML = `
      <legend><span class="swatch" style="background:${meta.color}"></span>${meta.label}</legend>
      <label>주당 주간 분배금 ($)<input type="number" inputmode="decimal" step="any" min="0" data-f="dps"></label>
      <label>52주 뒤 주가 변화 (%)<input type="number" inputmode="decimal" step="any" data-f="priceChangePct"></label>
      <label>52주 뒤 환율 (원/$)<input type="number" inputmode="decimal" step="any" min="0" data-f="fxRate" placeholder="비우면 현재 환율"></label>`;
    box.querySelectorAll('input').forEach((inp) => {
      const f = inp.dataset.f;
      inp.value = sc[f] === '' ? '' : sc[f];
      inp.addEventListener('input', () => {
        sc[f] = inp.value === '' ? (f === 'fxRate' ? '' : 0) : Number(inp.value);
        update();
      });
    });
    wrap.appendChild(box);
  }
}

// ---------- 분배 기록 폼 ----------
const form = $('record-form');
const fields = { date: $('f-date'), div: $('f-div'), price: $('f-price'), shares: $('f-shares'), fx: $('f-fx') };

function resetForm() {
  editingId = null;
  form.reset();
  fields.date.value = today();
  prefilled = { price: null, fx: null };
  prefillFromQuotes();
  if (!fields.fx.value) {
    const last = state.records.at(-1);
    if (last) fields.fx.value = last.fxRate;
    else if (state.market.fxRate) fields.fx.value = state.market.fxRate;
  }
  $('record-form-title').textContent = '분배 기록 추가';
  $('f-submit').textContent = '기록 추가';
  $('f-cancel').hidden = true;
  $('f-error').textContent = '';
  updateHint();
}

/**
 * 새 기록 폼의 매수 가격·환율 칸을 가져온 시세로 미리 채웁니다.
 * 비어 있거나 전에 미리 채운 값 그대로인 칸만 바꾸고, 사용자가 고친 칸은 건드리지 않습니다.
 */
function prefillFromQuotes() {
  if (editingId) return;
  const fill = (input, key, value) => {
    if (!(value > 0)) return;
    const untouched = input.value === '' || Number(input.value) === prefilled[key];
    if (!untouched) return;
    input.value = value;
    prefilled[key] = value;
  };
  fill(fields.price, 'price', quoteCache.price?.value);
  fill(fields.fx, 'fx', quoteCache.fx?.value);
  updatePrefillNote();
}

function updatePrefillNote() {
  const used = (prefilled.price != null && Number(fields.price.value) === prefilled.price)
    || (prefilled.fx != null && Number(fields.fx.value) === prefilled.fx);
  $('f-prefill').textContent = !editingId && used
    ? '매수 가격·환율은 가져온 시세로 미리 채웠어요. 실제 체결가와 적용 환율로 고쳐 주세요.'
    : '';
}

function updateHint() {
  const div = Number(fields.div.value);
  const price = Number(fields.price.value);
  const bought = Number(fields.shares.value);
  const hint = $('f-hint');
  if (!(div > 0 && price > 0)) { hint.textContent = ''; return; }
  // 수정 중이면 그 기록을 뺀 나머지로 남은 현금을 계산
  const others = state.records.filter((r) => r.id !== editingId);
  const cash = computePortfolio(state.settings, others).cashUSD;
  const available = Math.max(cash, 0) + div;
  const maxShares = Math.floor(available / price + 1e-9);
  let text = `남은 현금 ${usd(Math.max(cash, 0))} 포함 ${usd(available)}로 최대 ${maxShares}주 살 수 있어요.`;
  if (bought > 0) text += ` 이번 매수 금액 ${usd(bought * price)}, 남는 돈 ${usd(available - bought * price)}.`;
  hint.textContent = text;
}
Object.values(fields).forEach((f) => f.addEventListener('input', () => { updateHint(); updatePrefillNote(); }));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const rec = {
    date: fields.date.value,
    dividendUSD: Number(fields.div.value),
    sharesBought: Number(fields.shares.value),
    price: Number(fields.price.value),
    fxRate: Number(fields.fx.value),
  };
  const err = !rec.date ? '날짜를 입력해 주세요.'
    : !(rec.dividendUSD >= 0) || fields.div.value === '' ? '분배금을 입력해 주세요.'
    : !(rec.price > 0) ? '매수 가격을 입력해 주세요.'
    : !(rec.sharesBought >= 0) || fields.shares.value === '' ? '재매수 주수를 입력해 주세요. (안 샀으면 0)'
    : !(rec.fxRate > 0) ? '환율을 입력해 주세요.'
    : '';
  if (err) { $('f-error').textContent = err; return; }

  if (editingId) {
    const i = state.records.findIndex((r) => r.id === editingId);
    state.records[i] = { ...state.records[i], ...rec };
  } else {
    state.records.push({ id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...rec });
  }
  state.records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  update();
  resetForm();
});
$('f-cancel').addEventListener('click', resetForm);

$('records-body').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;
  if (btn.dataset.act === 'del') {
    if (!confirm(`${rec.date} 기록을 지울까요?`)) return;
    state.records = state.records.filter((r) => r.id !== id);
    if (editingId === id) resetForm();
    update();
  } else {
    editingId = id;
    fields.date.value = rec.date;
    fields.div.value = rec.dividendUSD;
    fields.price.value = rec.price;
    fields.shares.value = rec.sharesBought;
    fields.fx.value = rec.fxRate;
    $('record-form-title').textContent = `${rec.date} 기록 수정`;
    $('f-submit').textContent = '수정 저장';
    $('f-cancel').hidden = false;
    updatePrefillNote();
    updateHint();
    form.scrollIntoView({ behavior: 'smooth' });
  }
});

// ---------- 백업 ----------
$('btn-export').addEventListener('click', () => {
  exportState(state);
  $('backup-msg').textContent = '백업 파일을 내려받았어요.';
});
$('file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const next = await importStateFile(file);
    if (!confirm(`기록 ${next.records.length}개가 들어 있는 백업이에요. 지금 데이터를 이 파일로 바꿀까요?`)) return;
    state = next;
    reloadInputs();
    $('backup-msg').textContent = '백업 파일을 불러왔어요.';
  } catch (err) {
    $('backup-msg').textContent = `불러오기 실패: ${err.message}`;
  }
});
$('btn-reset').addEventListener('click', () => {
  if (!confirm('정말 모든 데이터를 지울까요? 되돌릴 수 없어요.')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  state = defaultState();
  reloadInputs();
});

function reloadInputs() {
  const setVal = (id, v) => ($(id).value = v === 0 || v === '' ? '' : v);
  setVal('market-price', state.market.price);
  setVal('market-fx', state.market.fxRate);
  setVal('s-shares', state.settings.initialShares);
  setVal('s-avg', state.settings.initialAvgCost);
  setVal('s-principal', state.settings.principalKRW);
  setVal('sim-target', state.sim.targetKRW);
  $('sim-fractional').checked = state.sim.fractional;
  buildScenarioInputs();
  resetForm();
  update();
}

// ---------- 그리기 ----------
function render() {
  renderReport();
  renderRecords();
  if (!$('tab-sim').hidden) renderSim();
}

function renderReport() {
  const r = computeReport(state.settings, state.records, state.market);
  const hasMarket = r.price > 0 && r.fxRate > 0;
  $('setup-hint').hidden = r.initialShares > 0 || state.records.length > 0;

  $('r-shares').textContent = sharesFmt(r.shares);
  $('r-shares-sub').textContent = r.shareGrowth == null ? '' : `처음보다 ${signed(r.addedShares, sharesFmt)} (${pct(r.shareGrowth)})`;
  tone($('r-shares-sub'), r.addedShares);
  $('r-initial-shares').textContent = sharesFmt(r.initialShares);
  $('r-added-shares').textContent = signed(r.addedShares, sharesFmt);
  $('r-avg').textContent = usd(r.avgCost, 4);
  $('r-price-vs-avg').textContent = hasMarket ? pct(r.priceVsAvg) : '현재 주가 필요';
  tone($('r-price-vs-avg'), hasMarket ? r.priceVsAvg : 0);

  $('r-principal').textContent = krw(r.principalKRW);
  $('r-dividends').textContent = `${usd(r.dividendsUSD)} (약 ${krw(r.dividendsKRW)})`;
  $('r-cash').textContent = usd(r.cashUSD);

  if (hasMarket) {
    $('r-return').textContent = r.totalReturn == null ? '원금 필요' : pct(r.totalReturn);
    $('r-profit').textContent = r.principalKRW > 0 ? `손익 ${signed(r.profitKRW, krw)}` : '';
    $('r-value').textContent = `${krw(r.valueKRW)} (${usd(r.valueUSD)})`;
    $('r-orig-value').textContent = krw(r.originalValueKRW);
    $('r-reinv-value').textContent = krw(r.reinvestedValueKRW);
    $('r-price-only').textContent = pct(r.priceOnlyReturn);
    $('r-broker-return').textContent = r.brokerReturn == null ? '원금 필요' : pct(r.brokerReturn);
    $('r-broker-profit').textContent = r.principalKRW > 0 ? `손익 ${signed(r.brokerProfitKRW, krw)}` : '';
    $('r-stock-value').textContent = krw(r.stockValueKRW);
    $('r-return-again').textContent = $('r-return').textContent;
    $('verdict').textContent = r.verdict;
    const total = Math.max(r.originalValueKRW, 0) + Math.max(r.reinvestedValueKRW, 0);
    const a = total > 0 ? (Math.max(r.originalValueKRW, 0) / total) * 100 : 0;
    $('split-bar').innerHTML = total > 0 ? `<span class="s-orig" style="width:${a}%"></span><span class="s-reinv" style="width:${100 - a}%"></span>` : '';
  } else {
    for (const id of ['r-return', 'r-value', 'r-orig-value', 'r-reinv-value', 'r-price-only', 'r-broker-return', 'r-stock-value', 'r-return-again']) $(id).textContent = '–';
    $('r-broker-profit').textContent = '';
    $('r-profit').textContent = '현재 주가와 환율을 입력하세요';
    $('verdict').textContent = '';
    $('split-bar').innerHTML = '';
  }
  tone($('r-return'), hasMarket ? r.profitKRW : 0);
  tone($('r-profit'), hasMarket ? r.profitKRW : 0);
  tone($('r-price-only'), hasMarket ? r.priceOnlyReturn : 0);
  tone($('r-broker-return'), hasMarket ? r.brokerProfitKRW : 0);
  tone($('r-broker-profit'), hasMarket ? r.brokerProfitKRW : 0);
  tone($('r-return-again'), hasMarket ? r.profitKRW : 0);
  $('r-broker-cost').textContent = krw(r.brokerCostKRW);
  $('verdict').className = `verdict ${r.sharesUp ? 's-up' : 's-flat'} ${r.moneyUp ? 'm-up' : 'm-down'}`;
}

function renderRecords() {
  const p = computePortfolio(state.settings, state.records);
  const byId = new Map(p.history.map((h) => [h.id, h]));
  const has = state.records.length > 0;
  $('records-empty').hidden = has;
  $('records-table').hidden = !has;
  // 최신 기록이 위에 오도록
  $('records-body').innerHTML = [...state.records].reverse().map((r) => {
    const h = byId.get(r.id);
    return `<tr>
      <td>${r.date}</td>
      <td data-label="분배금">${usd(r.dividendUSD)}</td>
      <td data-label="매수">${sharesFmt(r.sharesBought)} × ${usd(r.price)}</td>
      <td data-label="보유 주수">${sharesFmt(h.shares)}</td>
      <td data-label="평균 단가">${usd(h.avgCost, 4)}</td>
      <td class="actions"><button type="button" data-act="edit" data-id="${r.id}">수정</button><button type="button" class="danger" data-act="del" data-id="${r.id}">삭제</button></td>
    </tr>`;
  }).join('');
}

function renderSim() {
  const p = computePortfolio(state.settings, state.records);
  const start = { shares: p.shares, cashUSD: p.cashUSD, price: state.market.price, fxRate: state.market.fxRate };
  const ready = start.shares > 0 && start.price > 0 && start.fxRate > 0;
  $('sim-empty').hidden = ready;
  $('chart').hidden = !ready;
  $('legend').hidden = !ready;
  if (!ready) { $('sim-results').innerHTML = ''; return; }

  const results = SCENARIO_KEYS.map((key) => {
    const points = simulate(start, state.sim.scenarios[key], { weeks: 52, fractional: state.sim.fractional });
    return { key, ...SCENARIO_META[key], points, targetWeek: findTargetWeek(points, state.sim.targetKRW) };
  });

  const isValue = chartMetric === 'valueKRW';
  $('chart-title').textContent = isValue ? '52주 평가금액 (원)' : '52주 보유 주수';
  $('legend').innerHTML = results.map((r) => `<li><span class="swatch line" style="background:${r.color}"></span>${r.label}</li>`).join('');

  renderLineChart($('chart'), {
    series: results.map((r) => ({ key: r.key, label: r.label, color: r.color, values: r.points.map((pt) => pt[chartMetric]) })),
    target: isValue ? state.sim.targetKRW : null,
    xLabel: '주',
    formatY: isValue ? shortKRW : (v) => `${+v.toFixed(1)}`,
    formatTooltip: (i, series) =>
      `<strong>${i}주 뒤 · ${addWeeks(today(), i)}</strong>` +
      series.map((s) => `<div><span class="swatch line" style="background:${s.color}"></span>${s.label} ${isValue ? krw(s.values[i]) : sharesFmt(s.values[i])}</div>`).join(''),
  });

  const target = state.sim.targetKRW;
  $('sim-results').innerHTML = results.map((r) => {
    const last = r.points.at(-1);
    let reach = '목표 미입력';
    if (target > 0) {
      reach = r.targetWeek == null ? '52주 안에 도달 못 함'
        : r.targetWeek === 0 ? '이미 달성'
        : `${r.targetWeek}주 뒤 (${addWeeks(today(), r.targetWeek)})`;
    }
    return `<tr>
      <th scope="row"><span class="swatch line" style="background:${r.color}"></span>${r.label}</th>
      <td>${sharesFmt(Math.round(last.shares * 10000) / 10000)}</td>
      <td>${krw(last.valueKRW)}</td>
      <td>${reach}</td>
    </tr>`;
  }).join('');
}

document.querySelectorAll('[data-metric]').forEach((b) =>
  b.addEventListener('click', () => {
    chartMetric = b.dataset.metric;
    document.querySelectorAll('[data-metric]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderSim();
  })
);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$('tab-sim').hidden) renderSim(); }, 150);
});

// ---------- 시세 자동 가져오기 ----------
const timeFmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', timeZone: 'UTC' });
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function sourceLabel(entry) {
  const parts = [`<a href="${escapeHTML(entry.sourceUrl)}" target="_blank" rel="noopener">${escapeHTML(entry.source)}</a>`];
  if (entry.asOf) parts.push(entry.dateOnly ? `${dateFmt.format(entry.asOf)} 고시` : `${timeFmt.format(entry.asOf)} 시세`);
  parts.push(`${timeFmt.format(entry.fetchedAt)} 가져옴`);
  return parts.join(' · ');
}

/** 주가·환율 칸 아래에 출처와 시각을 표시. 직접 고친 값이면 "직접 입력"으로 표시합니다. */
function renderQuoteLabels() {
  const one = (key, current, format) => {
    const node = $(`src-${key}`);
    const entry = quoteCache[key];
    node.classList.remove('warn');
    const useBtn = entry ? `<button type="button" class="link" data-use-quote="${key}">가져온 값 ${format(entry.value)} 쓰기</button>` : '';
    if (entry && current === entry.value) node.innerHTML = sourceLabel(entry);
    else if (current > 0) node.innerHTML = entry ? `직접 입력 · ${useBtn}` : '직접 입력';
    else node.innerHTML = useBtn;
  };
  one('price', state.market.price, (v) => usd(v));
  one('fx', state.market.fxRate, (v) => `${v.toLocaleString('ko-KR')}원`);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-use-quote]');
  if (!btn) return;
  e.preventDefault(); // label 안의 버튼이라 입력칸으로 포커스가 넘어가지 않게
  const key = btn.dataset.useQuote;
  const entry = quoteCache[key];
  if (!entry) return;
  if (key === 'price') state.market.price = entry.value;
  else state.market.fxRate = entry.value;
  $(key === 'price' ? 'market-price' : 'market-fx').value = entry.value;
  update();
  renderQuoteLabels();
});

async function loadQuotes(force = false) {
  if (quotesLoading) return;
  quotesLoading = true;
  const btn = $('btn-refresh-quotes');
  btn.disabled = true;
  btn.textContent = '가져오는 중…';
  try {
    const r = await refreshQuotes({ cache: quoteCache, provider: apiConfig.provider, apiKey: apiConfig.apiKey, force });
    quoteCache = r.cache;
    saveQuoteCache(quoteCache);

    // 방금 가져왔거나 10분 안의 값이면 화면에 반영.
    // 실패했을 땐 지금 칸의 값(마지막으로 가져온 값이나 직접 입력한 값)을 그대로 둡니다.
    let changed = false;
    if ((r.price.status === 'fetched' || r.price.status === 'cached') && r.price.entry) {
      state.market.price = r.price.entry.value;
      $('market-price').value = r.price.entry.value;
      changed = true;
    }
    if ((r.fx.status === 'fetched' || r.fx.status === 'cached') && r.fx.entry) {
      state.market.fxRate = r.fx.entry.value;
      $('market-fx').value = r.fx.entry.value;
      changed = true;
    }
    if (changed) update();
    renderQuoteLabels();
    renderQuoteStatus(r);
    refStatus = { mstr: r.mstr, btc: r.btc };
    renderReference();
    prefillFromQuotes();
    updateHint();
    return r;
  } finally {
    quotesLoading = false;
    btn.disabled = false;
    btn.textContent = '새로고침';
  }
}

function renderQuoteStatus(r) {
  const describe = (name, x) => {
    if (x.status === 'nokey') return `${name}: 설정에서 API 키를 넣으면 자동으로 가져와요. 지금은 직접 입력해 주세요.`;
    if (x.status === 'stale') return `${name}: 가져오지 못했어요 (${x.error}) 지금 칸의 값을 쓰거나 직접 고쳐 주세요.`;
    if (x.status === 'failed') return `${name}: 가져오지 못했어요 (${x.error}) 직접 입력해 주세요.`;
    return null;
  };
  const msgs = [describe('주가', r.price), describe('환율', r.fx)].filter(Boolean);
  if (r.price.status === 'cached' || r.fx.status === 'cached') msgs.push('호출 횟수를 아끼려고 10분 안에 가져온 값은 다시 써요. 바로 받으려면 새로고침을 누르세요.');
  $('quote-status').textContent = msgs.join(' ');
  if (r.price.status === 'stale' || r.price.status === 'failed') $('src-price').classList.add('warn');
  if (r.fx.status === 'stale' || r.fx.status === 'failed') $('src-fx').classList.add('warn');
}

/**
 * 참고 시세 카드(비트코인, MSTR). 화면 표시만 하고 state 나 수익률 계산에는 넣지 않습니다.
 * refStatus 는 마지막 가져오기 결과로, 실패 이유를 보여 줄 때 씁니다.
 */
let refStatus = {};
function renderReference() {
  const one = (key, changeLabel) => {
    const entry = quoteCache[key];
    const st = refStatus[key];
    const valueEl = $(`ref-${key}`);
    const chgEl = $(`ref-${key}-chg`);
    const srcEl = $(`src-${key}`);
    srcEl.classList.remove('warn');
    if (!entry) {
      valueEl.textContent = '–';
      chgEl.textContent = '';
      srcEl.textContent = st?.status === 'nokey' ? '설정에서 API 키를 넣으면 보여요.'
        : st?.status === 'failed' ? `가져오지 못했어요 (${st.error})`
        : '';
      if (st?.status === 'failed') srcEl.classList.add('warn');
      return;
    }
    valueEl.textContent = usd(entry.value);
    chgEl.textContent = entry.changePct == null ? '' : `${changeLabel} ${entry.changePct > 0 ? '+' : ''}${entry.changePct.toFixed(2)}%`;
    tone(chgEl, entry.changePct ?? 0);
    let src = sourceLabel(entry);
    if (st?.status === 'stale') {
      src += ` · 마지막으로 가져온 값 (새로 못 가져옴: ${escapeHTML(st.error)})`;
      srcEl.classList.add('warn');
    } else if (st?.status === 'nokey') {
      src += ' · 예전 값 (API 키 없음)';
    }
    srcEl.innerHTML = src;
  };
  one('btc', '24시간');
  one('mstr', '전일 대비');
}

$('btn-refresh-quotes').addEventListener('click', () => loadQuotes(true));

// 설정: API 키 (이 브라우저에만 저장, 백업 파일에는 넣지 않음)
function renderApiForm() {
  $('api-provider').value = apiConfig.provider;
  $('api-key').value = apiConfig.apiKey;
  $('api-key-link').href = PRICE_PROVIDERS[apiConfig.provider].keyPage;
}
$('api-provider').addEventListener('change', (e) => {
  $('api-key-link').href = PRICE_PROVIDERS[e.target.value].keyPage;
});
$('api-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  apiConfig = { provider: $('api-provider').value, apiKey: $('api-key').value.trim() };
  if (!saveApiConfig(apiConfig)) { $('api-msg').textContent = '이 브라우저에 저장할 수 없어요.'; return; }
  $('api-msg').textContent = '저장했어요. 시세를 가져오는 중…';
  const r = await loadQuotes(true);
  if (!r) return;
  $('api-msg').textContent = !apiConfig.apiKey ? '키 없이 저장했어요. 환율만 자동으로 가져와요.'
    : r.price.status === 'fetched' ? `저장했어요. 주가 ${usd(r.price.entry.value)}를 가져왔어요.`
    : `저장했지만 주가를 가져오지 못했어요: ${r.price.error}`;
});
$('api-key-clear').addEventListener('click', () => {
  apiConfig = { ...apiConfig, apiKey: '' };
  saveApiConfig(apiConfig);
  renderApiForm();
  $('api-msg').textContent = '키를 지웠어요.';
});

// ---------- 시작 ----------
buildScenarioInputs();
renderApiForm();
resetForm();
render();
renderQuoteLabels();
renderReference();
loadQuotes(false);
let startTab = 'report';
try { startTab = sessionStorage.getItem('msty-tab') || 'report'; } catch {}
showTab(startTab);
