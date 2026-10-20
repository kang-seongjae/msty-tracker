// 외부 라이브러리 없이 SVG로 꺾은선 그래프를 그립니다.
// series: [{ key, label, color(CSS 변수), values: number[] }], 모든 values 길이는 같다고 가정합니다.

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

/** 축 눈금용 "보기 좋은" 숫자 간격 */
function niceStep(range, count) {
  const raw = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
}

// baseline: { value, label } — 원금처럼 기준이 되는 높이에 점선 가로줄 (target 의 목표선과 모양을 다르게 그림)
export function renderLineChart(container, { series, target = null, baseline = null, formatY, formatTooltip, xLabel }) {
  container.innerHTML = '';
  const width = Math.max(container.clientWidth, 280);
  const height = width < 500 ? 240 : 300;
  const m = { top: 12, right: 12, bottom: 28, left: width < 500 ? 52 : 64 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const len = series[0]?.values.length ?? 0;
  if (len < 2) return;

  let min = Infinity;
  let max = -Infinity;
  for (const s of series) for (const v of s.values) { if (v < min) min = v; if (v > max) max = v; }
  if (target != null && target > 0) { min = Math.min(min, target); max = Math.max(max, target); }
  const hasBase = baseline != null && baseline.value > 0;
  if (hasBase) { min = Math.min(min, baseline.value); max = Math.max(max, baseline.value); }
  if (min === max) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
  const step = niceStep(max - min, 4);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;

  const x = (i) => m.left + (i / (len - 1)) * w;
  const y = (v) => m.top + h - ((v - min) / (max - min)) * h;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img' });

  // 가로 격자 + y축 눈금
  for (let v = min; v <= max + step / 2; v += step) {
    el('line', { x1: m.left, x2: m.left + w, y1: y(v), y2: y(v), class: 'grid' }, svg);
    const t = el('text', { x: m.left - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg);
    t.textContent = formatY(v);
  }
  // x축 눈금 (주차)
  const xTicks = width < 500 ? [0, 13, 26, 39, 52] : [0, 4, 8, 13, 17, 21, 26, 30, 34, 39, 43, 47, 52];
  for (const i of xTicks) {
    if (i >= len) continue;
    const t = el('text', { x: x(i), y: m.top + h + 18, 'text-anchor': 'middle', class: 'tick' }, svg);
    t.textContent = `${i}${xLabel}`;
  }

  // 목표선
  if (target != null && target > 0) {
    el('line', { x1: m.left, x2: m.left + w, y1: y(target), y2: y(target), class: 'target-line' }, svg);
    const t = el('text', { x: m.left + w - 4, y: y(target) - 6, 'text-anchor': 'end', class: 'target-label' }, svg);
    t.textContent = '목표';
  }

  // 원금선 (점선, 이름은 왼쪽에 붙여 오른쪽 '목표' 이름과 겹치지 않게)
  if (hasBase) {
    el('line', { x1: m.left, x2: m.left + w, y1: y(baseline.value), y2: y(baseline.value), class: 'base-line' }, svg);
    const t = el('text', { x: m.left + 4, y: y(baseline.value) - 6, 'text-anchor': 'start', class: 'base-label' }, svg);
    t.textContent = baseline.label;
  }

  // 시리즈 선
  for (const s of series) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }

  // 마우스/터치 따라다니는 세로선과 점, 툴팁
  const hover = el('g', { class: 'hover', visibility: 'hidden' }, svg);
  const vline = el('line', { y1: m.top, y2: m.top + h, class: 'crosshair' }, hover);
  const dots = series.map((s) => el('circle', { r: 4, fill: s.color, class: 'dot' }, hover));
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;

  const overlay = el('rect', { x: m.left, y: m.top, width: w, height: h, fill: 'transparent' }, svg);
  const show = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - m.left) / w) * (len - 1));
    if (i < 0 || i >= len) return;
    hover.setAttribute('visibility', 'visible');
    vline.setAttribute('x1', x(i));
    vline.setAttribute('x2', x(i));
    series.forEach((s, k) => { dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(s.values[i])); });
    tip.innerHTML = formatTooltip(i, series);
    tip.hidden = false;
    const left = (x(i) / width) * rect.width;
    tip.style.left = `${left}px`;
    tip.style.transform = left > rect.width / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)';
  };
  const hide = () => { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  overlay.addEventListener('pointermove', (e) => show(e.clientX));
  overlay.addEventListener('pointerdown', (e) => show(e.clientX));
  overlay.addEventListener('pointerleave', hide);

  container.appendChild(svg);
  container.appendChild(tip);
}

/**
 * 회차별 분배금 그래프: 위 칸은 총액 막대, 아래 칸은 주당 분배금 선. 두 칸은 회차(가로 위치)가 똑같이 맞춰져 있습니다.
 * (단위가 다른 두 값을 한 축에 겹치면 축 두 개가 필요해 오해하기 쉬워서, 위아래로 나눠 그립니다.)
 *
 * items: [{ total, perShare }]  — total 은 지금 단위(원 또는 달러)의 총액, perShare 는 주당 분배금(달러, 없으면 null)
 * labels: 회차별 x축 글자(예: '10/2')
 */
export function renderDistributionChart(container, { items, labels, formatTotalTick, formatPerShareTick, formatTooltip }) {
  container.innerHTML = '';
  const n = items.length;
  if (n === 0) return;
  const width = Math.max(container.clientWidth, 280);
  const narrow = width < 500;
  const m = { top: 22, right: 12, bottom: 24, left: narrow ? 52 : 64 };
  const barH = narrow ? 150 : 190;
  const gapH = 34; // 두 칸 사이 (아래 칸 이름이 들어감)
  const lineH = narrow ? 76 : 96;
  const height = m.top + barH + gapH + lineH + m.bottom;
  const w = width - m.left - m.right;
  const band = w / n;
  const cx = (i) => m.left + band * (i + 0.5);

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img' });

  // ----- 위 칸: 총액 막대 (0부터) -----
  const totals = items.map((d) => d.total);
  let tMax = Math.max(...totals, 0);
  if (tMax <= 0) tMax = 1;
  const tStep = niceStep(tMax, 3);
  tMax = Math.ceil(tMax / tStep) * tStep;
  const barTop = m.top;
  const barBase = m.top + barH;
  const yBar = (v) => barBase - (v / tMax) * barH;
  for (let v = 0; v <= tMax + tStep / 2; v += tStep) {
    el('line', { x1: m.left, x2: m.left + w, y1: yBar(v), y2: yBar(v), class: 'grid' }, svg);
    el('text', { x: m.left - 6, y: yBar(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = formatTotalTick(v);
  }
  el('text', { x: m.left, y: barTop - 10, class: 'panel-label' }, svg).textContent = '회차별 총액';

  const bw = Math.max(2, Math.min(28, band * 0.62));
  items.forEach((d, i) => {
    const hgt = Math.max(0, barBase - yBar(d.total));
    if (hgt <= 0) return;
    const x0 = cx(i) - bw / 2;
    const r = Math.min(1, bw / 2, hgt); // 통장 인쇄처럼 각진 막대
    const top = barBase - hgt;
    // 위쪽 모서리만 아주 살짝 다듬고, 아래는 바닥선에 붙임
    const dPath = `M${x0},${barBase}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${barBase}Z`;
    el('path', { d: dPath, class: 'dist-bar' }, svg);
  });

  // ----- 아래 칸: 주당 분배금 선 -----
  const lineTop = barBase + gapH;
  const lineBase = lineTop + lineH;
  const ps = items.map((d) => d.perShare).filter((v) => v != null && Number.isFinite(v));
  if (ps.length) {
    let lo = Math.min(...ps);
    let hi = Math.max(...ps);
    if (lo === hi) { const pad = Math.abs(lo) * 0.1 || 0.01; lo -= pad; hi += pad; }
    const step = niceStep(hi - lo, 2);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const yLine = (v) => lineBase - ((v - lo) / (hi - lo)) * lineH;
    for (let v = lo; v <= hi + step / 2; v += step) {
      el('line', { x1: m.left, x2: m.left + w, y1: yLine(v), y2: yLine(v), class: 'grid' }, svg);
      el('text', { x: m.left - 6, y: yLine(v) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = formatPerShareTick(v);
    }
    el('text', { x: m.left, y: lineTop - 10, class: 'panel-label' }, svg).textContent = '주당 분배금';
    let dLine = '';
    let pen = false;
    items.forEach((d, i) => {
      if (d.perShare == null || !Number.isFinite(d.perShare)) { pen = false; return; }
      dLine += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)},${yLine(d.perShare).toFixed(1)}`;
      pen = true;
    });
    el('path', { d: dLine, class: 'dist-line' }, svg);
    if (n <= 40) items.forEach((d, i) => { if (d.perShare != null) el('circle', { cx: cx(i), cy: yLine(d.perShare), r: 3, class: 'dist-dot' }, svg); });
  }

  // x축 글자: 너무 많으면 건너뛰고, 마지막 회차는 꼭 표시
  const every = Math.max(1, Math.ceil(n / (narrow ? 5 : 10)));
  for (let i = 0; i < n; i++) {
    if (i % every !== 0 && i !== n - 1) continue;
    if (i !== n - 1 && n - 1 - i < every / 2) continue; // 마지막 글자와 겹치지 않게
    el('text', { x: cx(i), y: lineBase + 18, 'text-anchor': 'middle', class: 'tick' }, svg).textContent = labels[i];
  }

  // 마우스/터치: 회차 한 칸 전체가 반응 영역
  const hover = el('g', { visibility: 'hidden' }, svg);
  const hl = el('rect', { y: barTop, height: lineBase - barTop, class: 'dist-hover' }, hover);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  const overlay = el('rect', { x: m.left, y: barTop, width: w, height: lineBase - barTop, fill: 'transparent' }, svg);
  const show = (clientX) => {
    const rect = svg.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * width;
    const i = Math.floor((px - m.left) / band);
    if (i < 0 || i >= n) return;
    hover.setAttribute('visibility', 'visible');
    hl.setAttribute('x', m.left + band * i);
    hl.setAttribute('width', band);
    tip.innerHTML = formatTooltip(i);
    tip.hidden = false;
    const left = (cx(i) / width) * rect.width;
    tip.style.left = `${left}px`;
    tip.style.transform = left > rect.width / 2 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)';
  };
  overlay.addEventListener('pointermove', (e) => show(e.clientX));
  overlay.addEventListener('pointerdown', (e) => show(e.clientX));
  overlay.addEventListener('pointerleave', () => { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; });

  container.appendChild(svg);
  container.appendChild(tip);
}
