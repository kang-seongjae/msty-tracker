// 계산 로직만 모아둔 파일입니다. 화면(DOM)이나 localStorage를 전혀 건드리지 않으므로
// 브라우저와 Node 양쪽에서 그대로 불러와 테스트할 수 있습니다.

/** 숫자로 바꿀 수 없으면 0으로 취급합니다. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 기록을 날짜순(같은 날짜면 입력순)으로 정렬한 새 배열을 돌려줍니다. */
export function sortRecords(records) {
  return records
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.i - b.i))
    .map((x) => x.r);
}

/**
 * 처음 보유 상태에 분배·재매수 기록을 차례로 적용해 현재 보유 상태를 계산합니다.
 *
 * - 보유 주수 = 처음 주수 + 재매수한 주수의 합
 * - 총 매수원가(달러) = 처음 주수 × 처음 평균 단가 + Σ(재매수 주수 × 매수 가격)
 * - 평균 단가 = 총 매수원가 ÷ 보유 주수
 * - 남은 현금 = 받은 분배금 합계 − 재매수에 쓴 돈 합계 (1주 단위로 사면 자투리가 남음)
 *
 * history 에는 기록 하나를 적용한 직후의 상태가 순서대로 들어갑니다.
 */
export function computePortfolio(settings, records) {
  const initialShares = num(settings.initialShares);
  const initialAvgCost = num(settings.initialAvgCost);

  let shares = initialShares;
  let costUSD = initialShares * initialAvgCost;
  let cashUSD = 0;
  let dividendsUSD = 0;
  let dividendsKRW = 0;
  let spentUSD = 0;
  const history = [];

  for (const rec of sortRecords(records)) {
    const div = num(rec.dividendUSD);
    const bought = num(rec.sharesBought);
    const price = num(rec.price);
    const fx = num(rec.fxRate);
    const spent = bought * price;

    dividendsUSD += div;
    dividendsKRW += div * fx;
    spentUSD += spent;
    cashUSD += div - spent;
    shares += bought;
    costUSD += spent;

    history.push({
      id: rec.id,
      date: rec.date,
      shares,
      avgCost: shares > 0 ? costUSD / shares : 0,
      cashUSD,
      dividendsUSD,
    });
  }

  return {
    initialShares,
    initialAvgCost,
    shares,
    costUSD,
    avgCost: shares > 0 ? costUSD / shares : 0,
    cashUSD,
    dividendsUSD,
    dividendsKRW,
    spentUSD,
    history,
  };
}

/**
 * 성적표 계산. "주수가 늘었는지"와 "돈이 늘었는지"를 따로 계산합니다.
 *
 * 총수익률(분배금 포함) = (현재 평가금액 − 원금) ÷ 원금
 *   현재 평가금액 = (보유 주수 × 현재 주가 + 남은 현금) × 현재 환율
 * 분배금은 전부 주식으로 다시 샀기 때문에 이미 "보유 주수" 안에 들어 있습니다.
 * 그래서 분배금 합계를 평가금액에 한 번 더 더하지 않습니다(이중 계산 방지).
 */
export function computeReport(settings, records, market) {
  const p = computePortfolio(settings, records);
  const price = num(market.price);
  const fx = num(market.fxRate);
  const principalKRW = num(settings.principalKRW);

  const stockValueUSD = p.shares * price;
  const valueUSD = stockValueUSD + p.cashUSD;
  const valueKRW = valueUSD * fx;
  const profitKRW = valueKRW - principalKRW;
  const totalReturn = principalKRW > 0 ? profitKRW / principalKRW : null;

  const addedShares = p.shares - p.initialShares;
  const shareGrowth = p.initialShares > 0 ? addedShares / p.initialShares : null;

  // 처음 갖고 있던 주식만의 지금 가치 vs 분배금으로 늘어난 부분의 지금 가치
  const originalValueKRW = p.initialShares * price * fx;
  const reinvestedValueKRW = valueKRW - originalValueKRW;
  // 분배금을 전혀 받지 않았다고 가정했을 때의 수익률 (= 주가·환율 변화만의 효과)
  const priceOnlyReturn = principalKRW > 0 ? (originalValueKRW - principalKRW) / principalKRW : null;
  // 평균 단가 대비 현재 주가 (달러 기준)
  const priceVsAvg = p.avgCost > 0 ? price / p.avgCost - 1 : null;

  return {
    ...p,
    price,
    fxRate: fx,
    principalKRW,
    stockValueUSD,
    valueUSD,
    valueKRW,
    profitKRW,
    totalReturn,
    addedShares,
    shareGrowth,
    sharesUp: addedShares > 0,
    moneyUp: profitKRW > 0,
    originalValueKRW,
    reinvestedValueKRW,
    priceOnlyReturn,
    priceVsAvg,
    verdict: verdictText(addedShares, profitKRW, principalKRW),
  };
}

function verdictText(addedShares, profitKRW, principalKRW) {
  if (principalKRW <= 0) return '설정에서 원금을 입력하면 돈이 늘었는지 알려드려요.';
  const s = addedShares > 0;
  const m = profitKRW > 0;
  if (s && m) return '주수도 늘었고, 돈도 늘었어요.';
  if (s && !m) return '주수는 늘었지만, 돈은 아직 원금보다 적어요.';
  if (!s && m) return '주수는 그대로지만, 돈은 늘었어요.';
  return '주수도 그대로이고, 돈도 원금보다 적어요.';
}

/**
 * 한 시나리오를 weeks주 동안 매주 시뮬레이션합니다.
 *
 * start:    { shares, cashUSD, price, fxRate }  — 지금 상태
 * scenario: { dps, priceChangePct, fxRate }
 *   dps            주당 주간 세후 분배금(달러)
 *   priceChangePct weeks주 뒤 주가 변화율(%). 매주 같은 비율로 복리 변화한다고 가정
 *   fxRate         weeks주 뒤 환율. 지금 환율에서 매주 일정하게 움직인다고 가정
 * options:  { weeks = 52, fractional = false }
 *   fractional 이 false면 1주 단위로만 사고 자투리는 현금으로 다음 주에 넘깁니다.
 *
 * 매주 순서: 그 주 주가 결정 → 보유 주수 × dps 만큼 분배 → (분배가 있으면) 현금으로 재매수 → 평가
 * 반환값 points[0]은 지금(0주차), points[w]는 w주 뒤 상태입니다.
 */
export function simulate(start, scenario, options = {}) {
  const weeks = options.weeks ?? 52;
  const fractional = !!options.fractional;
  const p0 = num(start.price);
  const fx0 = num(start.fxRate);
  const fx1 = scenario.fxRate === '' || scenario.fxRate == null ? fx0 : num(scenario.fxRate);
  const dps = num(scenario.dps);
  const totalChange = num(scenario.priceChangePct) / 100;
  // 52주 뒤 −100% 이하는 의미가 없으므로 −99.99%로 막습니다.
  const weeklyGrowth = Math.pow(Math.max(1 + totalChange, 0.0001), 1 / weeks);

  let shares = num(start.shares);
  let cash = num(start.cashUSD);
  const points = [snapshot(0, shares, cash, p0, fx0)];

  for (let w = 1; w <= weeks; w++) {
    const price = p0 * Math.pow(weeklyGrowth, w);
    const fx = fx0 + ((fx1 - fx0) * w) / weeks;
    const dividend = shares * dps;
    cash += dividend;
    // 분배금이 들어온 주에만 재매수합니다(분배금이 0이면 아무것도 사지 않음).
    if (dividend > 0 && price > 0 && cash > 0) {
      const buy = fractional ? cash / price : Math.floor(cash / price + 1e-9);
      shares += buy;
      cash -= buy * price;
      if (Math.abs(cash) < 1e-9) cash = 0;
    }
    points.push(snapshot(w, shares, cash, price, fx));
  }
  return points;
}

function snapshot(week, shares, cashUSD, price, fxRate) {
  const valueUSD = shares * price + cashUSD;
  return { week, shares, cashUSD, price, fxRate, valueUSD, valueKRW: valueUSD * fxRate };
}

/** 평가금액(원화)이 처음으로 목표 이상이 되는 주차. 기간 안에 못 닿으면 null. */
export function findTargetWeek(points, targetKRW) {
  const t = num(targetKRW);
  if (t <= 0) return null;
  const hit = points.find((pt) => pt.valueKRW >= t);
  return hit ? hit.week : null;
}

/** 'YYYY-MM-DD' 에 weeks주를 더한 날짜 문자열 */
export function addWeeks(dateStr, weeks) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + weeks * 7));
  return dt.toISOString().slice(0, 10);
}
