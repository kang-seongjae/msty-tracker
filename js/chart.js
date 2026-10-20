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
