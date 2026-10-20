// 화면 담당. 입력을 읽어 state 를 바꾸고, calc.js 로 계산한 결과를 화면에 그립니다.

import { computePortfolio, computeReport, computeFxBreakdown, compareToPrincipal, simulate, findTargetWeek, addWeeks } from './calc.js';
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

/**
 * id 로 화면 요소를 찾습니다. 없으면(예: 옛 index.html 과 새 app.js 가 섞였을 때) null 대신
 * 화면에 붙지 않은 빈 요소를 돌려줘서, 값을 넣거나 이벤트를 다는 코드가 멈추지 않게 합니다.
 * 빠진 id 는 콘솔에 한 번만 알립니다.
 */
const missingIds = new Set();
const $ = (id) => {
  const el = document.getElementById(id);
  if (el) return el;
  if (!missingIds.has(id)) {
    missingIds.add(id);
    console.error(`화면 요소 #${id} 를 찾지 못했어요. 페이지를 새로고침해 주세요.`);
  }
  return document.createElement(id.startsWith('tab-') ? 'section' : 'input');
};

/** 카드 하나를 그리다 오류가 나도 나머지 카드는 계속 그리도록 감쌉니다. */
function safe(name, fn) {
  try {
    return fn();
  } catch (e) {
    console.error(`[${name}] 그리는 중 오류`, e);
  }
}

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
bindNumber('s-usd', () => state.settings.initialUSD, (v) => (state.settings.initialUSD = v));
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
  const cash = computePortfolio(state.settings, others, state.sells).cashUSD;
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

// ---------- 매도 기록 폼 ----------
const sellForm = $('sell-form');
const sf = { date: $('sf-date'), shares: $('sf-shares'), price: $('sf-price'), fee: $('sf-fee'), fx: $('sf-fx') };
let editingSellId = null;

function readSellForm() {
  return {
    date: sf.date.value,
    shares: Number(sf.shares.value),
    price: Number(sf.price.value),
    feeUSD: sf.fee.value === '' ? 0 : Number(sf.fee.value),
    fxRate: sf.fx.value === '' ? '' : Number(sf.fx.value),
  };
}

function resetSellForm() {
  editingSellId = null;
  sellForm.reset();
  sf.date.value = today();
  $('sell-form-title').textContent = '매도 기록 추가';
  $('sf-submit').textContent = '매도 기록 추가';
  $('sf-cancel').hidden = true;
  $('sf-error').textContent = '';
  updateSellHint();
}

/** 이 매도를 넣었을 때의 계산 결과 (수정 중이면 원래 기록 대신) */
function previewSell(candidate) {
  const id = editingSellId ?? '__new__';
  const sells = [...state.sells.filter((s) => s.id !== id), { ...candidate, id }];
  const r = computeReport(state.settings, state.records, state.market, sells);
  return { r, h: r.sellHistory.find((x) => x.id === id) };
}

function updateSellHint() {
  const c = readSellForm();
  const hint = $('sf-hint');
  if (!c.date) { hint.textContent = ''; return; }
  const { h } = previewSell({ ...c, shares: c.shares > 0 ? c.shares : 0, price: c.price > 0 ? c.price : 0, feeUSD: c.feeUSD > 0 ? c.feeUSD : 0 });
  let text = `${c.date} 기준 보유 ${sharesFmt(h.sharesBefore)}, 평균 단가 ${usd(h.avgCost, 4)}, 주당 원금 ${krw(h.principalPerShareKRW)}.`;
  if (c.shares > 0 && c.price > 0) {
    text += ` 수수료 뺀 판 돈 ${usd(h.netUSD)}, 실현 손익 ${signed(h.realizedUSD, (v) => usd(v))}`;
    const fx = h.fxRate ?? (state.market.fxRate > 0 ? state.market.fxRate : null);
    if (fx) text += ` (원화 ${signed(h.netUSD * fx - h.principalRemovedKRW, krw)}${h.fxRate ? '' : ', 현재 환율'})`;
    text += '.';
  }
  hint.textContent = text;
}
Object.values(sf).forEach((f) => f.addEventListener('input', () => safe('매도 미리보기', updateSellHint)));

sellForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const c = readSellForm();
  let err = !c.date ? '날짜를 입력해 주세요.'
    : !(c.shares > 0) ? '판 주수를 입력해 주세요.'
    : !(c.price > 0) ? '매도 가격을 입력해 주세요.'
    : !(c.feeUSD >= 0) ? '수수료는 0 이상이어야 해요. (없으면 비우기)'
    : c.fxRate !== '' && !(c.fxRate > 0) ? '환율은 0보다 커야 해요. 원화로 안 바꿨으면 비워 두세요.'
    : '';
  if (!err) {
    const { r, h } = previewSell(c);
    if (h.oversold) err = `${c.date}에는 ${sharesFmt(h.sharesBefore)}만 갖고 있어서 ${sharesFmt(c.shares)}를 팔 수 없어요.`;
    else if (r.sellHistory.some((x) => x.oversold)) err = '이 기록을 넣으면 뒤에 있는 매도 기록이 그날 보유 주수보다 많아져요. 날짜나 주수를 확인해 주세요.';
  }
  if (err) { $('sf-error').textContent = err; return; }

  if (editingSellId) {
    const i = state.sells.findIndex((s) => s.id === editingSellId);
    state.sells[i] = { ...state.sells[i], ...c };
  } else {
    state.sells.push({ id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...c });
  }
  state.sells.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  update();
  resetSellForm();
});
$('sf-cancel').addEventListener('click', resetSellForm);

$('sells-body').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const s = state.sells.find((x) => x.id === id);
  if (!s) return;
  if (btn.dataset.act === 'del') {
    if (!confirm(`${s.date} 매도 기록(${sharesFmt(s.shares)})을 지울까요?`)) return;
    state.sells = state.sells.filter((x) => x.id !== id);
    if (editingSellId === id) resetSellForm();
    update();
  } else {
    editingSellId = id;
    sf.date.value = s.date;
    sf.shares.value = s.shares;
    sf.price.value = s.price;
    sf.fee.value = s.feeUSD || '';
    sf.fx.value = s.fxRate === '' ? '' : s.fxRate;
    $('sell-form-title').textContent = `${s.date} 매도 기록 수정`;
    $('sf-submit').textContent = '수정 저장';
    $('sf-cancel').hidden = false;
    $('sf-error').textContent = '';
    updateSellHint();
    sellForm.scrollIntoView({ behavior: 'smooth' });
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
    if (!confirm(`분배 기록 ${next.records.length}개, 매도 기록 ${next.sells.length}개가 들어 있는 백업이에요. 지금 데이터를 이 파일로 바꿀까요?`)) return;
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
  setVal('s-usd', state.settings.initialUSD);
  setVal('sim-target', state.sim.targetKRW);
  $('sim-fractional').checked = state.sim.fractional;
  buildScenarioInputs();
  resetForm();
  resetSellForm();
  update();
}

// ---------- 그리기 ----------
function render() {
  safe('성적표', renderReport);
  safe('달러 기준·환율 효과', renderFx);
  safe('분배 기록', renderRecords);
  safe('매도 기록', renderSells);
  if (!$('tab-sim').hidden) safe('시뮬레이션', renderSim);
}

function renderReport() {
  const r = computeReport(state.settings, state.records, state.market, state.sells);
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
    $('hero-value').textContent = krw(r.valueKRW);
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
    for (const id of ['r-return', 'r-value', 'hero-value', 'r-orig-value', 'r-reinv-value', 'r-price-only', 'r-broker-return', 'r-stock-value', 'r-return-again']) $(id).textContent = '–';
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
  safe('남은 주식·전체 기준', () => renderSellSummary(r, hasMarket));
  $('verdict').className = `verdict ${r.sharesUp ? 's-up' : 's-flat'} ${r.moneyUp ? 'm-up' : 'm-down'}`;
}

/** 성적표의 "남은 주식 기준과 전체 기준" 카드와 핵심 지표의 판 돈 표시 */
function renderSellSummary(r, hasMarket) {
  // 판 적이 있으면 총수익률은 판 돈까지 합친 "전체 기준"이고, 그 아래에 남은 주식 기준을 따로 보여 줌
  $('hero-basis').textContent = r.hasSells ? '분배금·판 돈 포함' : '분배금 포함';
  $('hero-remaining-line').hidden = !r.hasSells;
  const rate = (v) => (v == null ? '원금 필요' : pct(v));
  const set = (id, text, toneValue) => { $(id).textContent = text; tone($(id), hasMarket ? toneValue : 0); };

  $('r-sold-shares').textContent = sharesFmt(r.soldShares);
  $('r-remaining-principal').textContent = krw(r.remainingPrincipalKRW);
  $('sell-note').textContent = r.hasSells
    ? '남은 주식 기준은 남은 주식과 남은 원금만 비교하고, 전체 기준은 판 돈까지 합쳐 처음 넣은 원금과 비교해요. 실현 손익(원화)은 판 주식의 원금 몫과 비교하고, 원화로 바꾸지 않은 판 돈은 현재 환율로 계산해요.'
    : '아직 매도 기록이 없어서 두 기준이 같아요. 매도는 "분배 기록" 탭에서 적을 수 있어요.';
  set('r-realized-usd', signed(r.realizedUSD, (v) => usd(v)), r.realizedUSD);
  if (!hasMarket) {
    for (const id of ['r-remaining-return', 'r-overall-return', 'hero-remaining', 'r-realized-krw']) set(id, '–', 0);
    $('r-remaining-profit').textContent = '현재 주가와 환율을 입력하세요';
    $('r-overall-profit').textContent = '';
    $('r-sold-proceeds').textContent = r.hasSells ? `${usd(r.soldProceedsUSD)} (원화는 현재 환율 필요)` : krw(0);
    return;
  }
  set('r-remaining-return', rate(r.remainingReturn), r.remainingProfitKRW);
  set('r-remaining-profit', `손익 ${signed(r.remainingProfitKRW, krw)}`, r.remainingProfitKRW);
  set('r-overall-return', rate(r.overallReturn), r.profitKRW);
  set('r-overall-profit', r.principalKRW > 0 ? `손익 ${signed(r.profitKRW, krw)}` : '', r.profitKRW);
  set('hero-remaining', rate(r.remainingReturn), r.remainingProfitKRW);
  $('r-sold-proceeds').textContent = `${krw(r.soldProceedsKRW)} (${usd(r.soldProceedsUSD)})`;
  set('r-realized-krw', signed(r.realizedKRW, krw), r.realizedKRW);
}

/** 달러 기준 수익률과 환율 효과 카드, 설정 화면의 평균 환전 환율 */
function renderFx() {
  const b = computeFxBreakdown(state.settings, state.records, state.market, state.sells);
  const fxFmt = (v) => `${v.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}원`;
  $('s-avgfx').textContent = b.ready
    ? `평균 환전 환율: ${fxFmt(b.avgFxRate)} (원금 ${krw(state.settings.principalKRW)} ÷ ${usd(b.initialUSD)})`
    : state.settings.principalKRW > 0 ? '넣은 달러를 입력하면 평균 환전 환율을 계산해 드려요.' : '';

  $('fx-basis').textContent = b.hasSells ? '남은 주식 기준' : '';
  $('fx-empty').hidden = b.ready;
  $('fx-body').hidden = !b.ready;
  if (!b.ready) return;

  const hasMarket = state.market.price > 0 && state.market.fxRate > 0;
  const set = (id, text, toneValue) => { $(id).textContent = text; tone($(id), hasMarket ? toneValue : 0); };
  $('fx-initial-usd').textContent = usd(b.initialUSD);
  $('fx-rate-detail').textContent = `${fxFmt(b.avgFxRate)} → ${hasMarket ? fxFmt(b.fxRate) : '현재 환율 필요'}`;
  if (!hasMarket) {
    for (const id of ['fx-usd-return', 'fx-usd-profit', 'fx-rate-change', 'fx-part-usd', 'fx-part-fx', 'fx-part-total', 'fx-value-usd']) set(id, '–', 0);
    $('fx-usd-profit').textContent = '현재 주가와 환율을 입력하세요';
    return;
  }
  set('fx-usd-return', pct(b.usdReturn), b.usdProfit);
  set('fx-usd-profit', `손익 ${signed(b.usdProfit, (v) => usd(v))}`, b.usdProfit);
  set('fx-rate-change', pct(b.fxReturn), b.fxReturn);
  $('fx-value-usd').textContent = usd(b.valueUSD);
  // 원 단위 표시값은 합이 총손익과 정확히 맞도록 calc.js 가 맞춰 준 값을 씁니다.
  set('fx-part-usd', signed(b.display.usdProfitKRW, krw), b.display.usdProfitKRW);
  set('fx-part-fx', signed(b.display.fxEffectKRW, krw), b.display.fxEffectKRW);
  set('fx-part-total', signed(b.display.totalKRW, krw), b.display.totalKRW);
}

function renderRecords() {
  const p = computePortfolio(state.settings, state.records, state.sells);
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

function renderSells() {
  const r = computeReport(state.settings, state.records, state.market, state.sells);
  const byId = new Map(r.sellHistory.map((h) => [h.id, h]));
  const has = state.sells.length > 0;
  $('sells-empty').hidden = has;
  $('sells-table').hidden = !has;
  const fxNow = state.market.fxRate;
  const toneClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  // 최신 기록이 위에 오도록 (날짜순으로 정렬해 둔 목록을 뒤집음)
  $('sells-body').innerHTML = [...state.sells].reverse().map((s) => {
    const h = byId.get(s.id);
    // 원화 실현 손익: 원화로 바꿨으면 그때 환율, 아니면 현재 환율로
    const krwRealized = h.realizedKRW ?? (fxNow > 0 ? h.netUSD * fxNow - h.principalRemovedKRW : null);
    const krwLabel = krwRealized == null ? '' : `<small>${signed(krwRealized, krw)}${h.fxRate ? '' : ' (현재 환율)'}</small>`;
    const fxNote = s.fxRate ? `<br><small class="muted">${s.fxRate.toLocaleString('ko-KR')}원에 환전</small>` : '';
    const warn = h.oversold ? `<br><span class="warn-text">⚠ 그날 보유 ${sharesFmt(h.sharesBefore)}보다 많아요</span>` : '';
    return `<tr>
      <td>${escapeHTML(s.date)}</td>
      <td data-label="매도">${sharesFmt(s.shares)} × ${usd(s.price)}${fxNote}${warn}</td>
      <td data-label="수수료">${usd(s.feeUSD)}</td>
      <td data-label="실현 손익"><span class="realized"><span class="${toneClass(h.realizedUSD)}">${signed(h.realizedUSD, (v) => usd(v))}</span>${krwLabel}</span></td>
      <td data-label="남은 주수">${sharesFmt(h.sharesAfter)}</td>
      <td class="actions"><button type="button" data-act="edit" data-id="${escapeHTML(s.id)}">수정</button><button type="button" class="danger" data-act="del" data-id="${escapeHTML(s.id)}">삭제</button></td>
    </tr>`;
  }).join('');
}

/** 수익률을 +12.34% / −5.67% 처럼 기호를 붙여 표시 (0 은 기호 없음) */
const signedPct = (v) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(2)}%`);
/** 원금 대비 칸 색: 플러스 초록, 마이너스 빨강 (+, − 기호도 함께 붙음) */
const gainClass = (v) => (v > 0 ? 'gain' : v < 0 ? 'loss' : '');

/** 시뮬레이션 결과 표의 "원금 대비" 칸: 수익률과 손익 금액, 매도가 있으면 전체 기준도 작게 */
function vsPrincipalCell(vs) {
  const { remaining, overall } = vs;
  const main = remaining.rate == null
    ? '<strong>원금 필요</strong>'
    : `<strong class="${gainClass(remaining.profitKRW)}">${signedPct(remaining.rate)}</strong>`
      + `<small class="${gainClass(remaining.profitKRW)}">${signed(remaining.profitKRW, krw)}</small>`;
  const all = overall && overall.rate != null
    ? `<small class="overall">전체 기준 <span class="${gainClass(overall.profitKRW)}">${signedPct(overall.rate)}</span></small>`
    : '';
  return `<span class="vs-principal">${main}${all}</span>`;
}

function renderSim() {
  const p = computePortfolio(state.settings, state.records, state.sells);
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

  // 원금 비교 기준: 성적표의 "남은 주식 기준"과 같은 남은 원금 (매도가 있으면 판 돈 포함 전체 기준도)
  const report = computeReport(state.settings, state.records, state.market, state.sells);
  const basePrincipal = report.remainingPrincipalKRW;
  for (const r of results) r.vs = compareToPrincipal(r.points.at(-1).valueKRW, report);

  const isValue = chartMetric === 'valueKRW';
  const showBase = isValue && basePrincipal > 0;
  const showTarget = isValue && state.sim.targetKRW > 0;
  $('chart-title').textContent = isValue ? '52주 평가금액 (원)' : '52주 보유 주수';
  $('legend').innerHTML = results.map((r) => `<li><span class="swatch line" style="background:${r.color}"></span>${r.label}</li>`).join('')
    + (showBase ? '<li><span class="swatch dot"></span>원금</li>' : '')
    + (showTarget ? '<li><span class="swatch dash"></span>목표</li>' : '');

  renderLineChart($('chart'), {
    series: results.map((r) => ({ key: r.key, label: r.label, color: r.color, values: r.points.map((pt) => pt[chartMetric]) })),
    target: isValue ? state.sim.targetKRW : null,
    baseline: showBase ? { value: basePrincipal, label: '원금' } : null,
    xLabel: '주',
    formatY: isValue ? shortKRW : (v) => `${+v.toFixed(1)}`,
    formatTooltip: (i, series) =>
      `<strong>${i}주 뒤 · ${addWeeks(today(), i)}</strong>` +
      series.map((s) => {
        const vs = showBase ? ` (원금 대비 ${signedPct(compareToPrincipal(s.values[i], report).remaining.rate)})` : '';
        return `<div><span class="swatch line" style="background:${s.color}"></span>${s.label} ${isValue ? krw(s.values[i]) + vs : sharesFmt(s.values[i])}</div>`;
      }).join(''),
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
      <td data-label="52주 뒤 주수">${sharesFmt(Math.round(last.shares * 10000) / 10000)}</td>
      <td data-label="52주 뒤 평가금액">${krw(last.valueKRW)}</td>
      <td data-label="원금 대비">${vsPrincipalCell(r.vs)}</td>
      <td data-label="목표 도달">${reach}</td>
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

const isOffline = () => navigator.onLine === false;

/** 마지막 가져오기에서 MSTY 주가·환율의 상태 ('fetched' | 'cached' | 'stale' | 'failed' | 'nokey') */
let quoteStatus = {};

/** 시세를 새로 못 가져와 예전 값을 보여 줄 때 숫자 옆의 작은 경고 표시를 켜고 끕니다. */
function setStaleBadge(id, entry, show, reason = '') {
  const badge = $(id);
  badge.hidden = !show;
  badge.title = show && entry
    ? `새로 못 가져와서 ${timeFmt.format(entry.fetchedAt)}에 가져온 값을 보여 주고 있어요${reason ? ` (${reason})` : ''}`
    : '';
}

/**
 * 주가·환율 칸 아래에 출처와 시각을 표시. 직접 고친 값이면 "직접 입력"으로 표시합니다.
 * 칸의 값이 새로 못 가져온 예전 값이면 경고 표시를 붙입니다.
 */
function renderQuoteLabels() {
  let anyStale = false;
  const one = (key, current, format) => {
    const node = $(`src-${key}`);
    const entry = quoteCache[key];
    const status = quoteStatus[key]?.status;
    node.classList.toggle('warn', status === 'failed');
    const useBtn = entry ? `<button type="button" class="link" data-use-quote="${key}">가져온 값 ${format(entry.value)} 쓰기</button>` : '';
    const showingFetched = !!entry && current === entry.value;
    if (showingFetched) node.innerHTML = sourceLabel(entry);
    else if (current > 0) node.innerHTML = entry ? `직접 입력 · ${useBtn}` : '직접 입력';
    else node.innerHTML = useBtn;
    const stale = showingFetched && (status === 'stale' || status === 'nokey' || (isOffline() && status === 'cached'));
    setStaleBadge(`stale-${key}`, entry, stale);
    anyStale ||= stale;
  };
  one('price', state.market.price, (v) => usd(v));
  one('fx', state.market.fxRate, (v) => `${v.toLocaleString('ko-KR')}원`);
  $('hero-stale').hidden = !anyStale;
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
    quoteStatus = { price: r.price, fx: r.fx };
    refStatus = { mstr: r.mstr, btc: r.btc };
    safe('시세 출처', renderQuoteLabels);
    safe('시세 안내', () => renderQuoteStatus(r));
    safe('참고 시세', renderReference);
    safe('기록 미리 채우기', () => { prefillFromQuotes(); updateHint(); });
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
  if (isOffline()) msgs.unshift('인터넷에 연결되어 있지 않아요. 마지막으로 가져온 값을 보여 줘요.');
  if (!isOffline() && (r.price.status === 'cached' || r.fx.status === 'cached')) msgs.push('호출 횟수를 아끼려고 10분 안에 가져온 값은 다시 써요. 바로 받으려면 새로고침을 누르세요.');
  $('quote-status').textContent = msgs.join(' ');
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
    const reason = st?.status === 'nokey' ? 'API 키 없음' : isOffline() ? '오프라인' : st?.error ?? '';
    const stale = st?.status === 'stale' || st?.status === 'nokey' || (isOffline() && st?.status === 'cached');
    setStaleBadge(`stale-${key}`, entry, !!entry && stale, reason);
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
    // 예전 값이면 숫자 옆 경고 표시로 알리고, 이유는 그 표시의 툴팁에 둡니다.
    srcEl.innerHTML = sourceLabel(entry);
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
safe('시나리오 입력', buildScenarioInputs);
safe('API 설정', renderApiForm);
safe('기록 입력칸', resetForm);
safe('매도 입력칸', resetSellForm);
render();
safe('시세 출처', renderQuoteLabels);
safe('참고 시세', renderReference);
loadQuotes(false).catch((e) => console.error('[시세] 가져오는 중 오류', e));

// 인터넷이 다시 연결되면 시세를 새로 가져옵니다.
window.addEventListener('online', () => loadQuotes(true));

// ---------- 앱 설치(PWA)와 새 버전 반영 ----------
if ('serviceWorker' in navigator) {
  // 이미 예전 버전 서비스 워커가 화면을 맡고 있었다면, 새 버전이 넘겨받는 순간 한 번 새로고침해
  // 설치한 앱도 바로 새 화면이 되게 합니다. (처음 설치할 때는 새로고침하지 않음)
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update().catch(() => {});
        // 설치한 앱을 오래 켜 둔 채 다시 볼 때도 새 버전이 있는지 확인
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch(() => {});
  });
}
let startTab = 'report';
try { startTab = sessionStorage.getItem('msty-tab') || 'report'; } catch {}
safe('탭', () => showTab(startTab));
