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
 * 처음 보유 상태에 분배·재매수 기록과 매도 기록을 날짜순으로 적용해 현재 보유 상태를 계산합니다.
 *
 * - 보유 주수 = 처음 주수 + 재매수한 주수의 합 − 판 주수의 합
 * - 총 매수원가(달러) = 처음 주수 × 처음 평균 단가 + Σ(재매수 주수 × 매수 가격) − Σ(판 주수 × 그때 평균 단가)
 * - 평균 단가 = 총 매수원가 ÷ 보유 주수  (팔아도 남은 주식의 평균 단가는 그대로)
 * - 남은 현금 = 받은 분배금 합계 − 재매수에 쓴 돈 합계 (1주 단위로 사면 자투리가 남음)
 *
 * 매도 (sells: [{ id, date, shares, price, feeUSD, fxRate }])
 * - 판 주수만큼 보유 주수가 줄고, 원금은 "판 주수 × 평균 원금"만큼 빠집니다.
 *   평균 원금 = 그때 남은 원금 ÷ 그때 보유 주수 (원화 원금, 넣은 달러, 증권사 기준 매수원금 모두 같은 비율로 줄어듦)
 * - 실현 손익(달러) = (판 주수 × 매도 가격 − 수수료) − 판 주수 × 평균 단가     ← 증권사와 같은 방식
 * - 실현 손익(원화) = (판 주수 × 매도 가격 − 수수료) × 환율 − 판 주수 × 평균 원금   ← 이 앱 총수익률과 같은 방식
 *   원화로 바꾼 기록이면 그때 환율, 아직 달러로 갖고 있으면 성적표에서 현재 환율을 씁니다.
 * - 판 돈은 보유 현금(남은 현금)에 넣지 않고 따로 모읍니다. 재매수에 쓰이지 않습니다.
 * - 같은 날짜에 분배 기록과 매도 기록이 있으면 분배 기록을 먼저 적용합니다.
 *
 * history 에는 분배 기록 하나를 적용한 직후의 상태, sellHistory 에는 매도 기록마다의 결과가 들어갑니다.
 * 매도 기록이 없으면 결과는 매도 기능을 넣기 전과 똑같습니다(tests/fixtures/no-sell-golden.json 으로 확인).
 */
export function computePortfolio(settings, records, sells = []) {
  const initialShares = num(settings.initialShares);
  const initialAvgCost = num(settings.initialAvgCost);
  const principalKRW = num(settings.principalKRW);
  const initialUSD = num(settings.initialUSD);

  let shares = initialShares;
  let costUSD = initialShares * initialAvgCost;
  let cashUSD = 0;
  let dividendsUSD = 0;
  let dividendsKRW = 0;
  let spentUSD = 0;
  let spentKRW = 0;
  const history = [];

  // 매도로 빠진 몫 (매도가 없으면 모두 0으로 남음)
  let principalRemovedKRW = 0;
  let initialUSDRemoved = 0;
  let brokerCostRemovedKRW = 0;
  let originalSharesRemoved = 0;
  const sellHistory = [];
  const sold = {
    shares: 0,
    netUSD: 0, // 수수료 뺀 판 돈 (달러)
    feeUSD: 0,
    realizedUSD: 0,
    convertedKRW: 0, // 원화로 바꾼 판 돈 (그때 환율)
    convertedRealizedKRW: 0,
    unconvertedNetUSD: 0, // 아직 달러로 갖고 있는 판 돈
    unconvertedPrincipalKRW: 0, // 그 매도로 빠진 원금 (현재 환율로 실현 손익을 계산할 때 씀)
  };

  const applyRecord = (rec) => {
    const div = num(rec.dividendUSD);
    const bought = num(rec.sharesBought);
    const price = num(rec.price);
    const fx = num(rec.fxRate);
    const spent = bought * price;

    dividendsUSD += div;
    dividendsKRW += div * fx;
    spentUSD += spent;
    spentKRW += spent * fx;
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
  };

  const applySell = (s) => {
    const held = shares;
    const requested = num(s.shares);
    const n = Math.max(0, Math.min(requested, held));
    const frac = held > 0 ? n / held : 0;
    const avgBefore = held > 0 ? costUSD / held : 0;
    const principalPerShareKRW = held > 0 ? (principalKRW - principalRemovedKRW) / held : 0;

    const costRemovedUSD = n * avgBefore;
    const principalOut = (principalKRW - principalRemovedKRW) * frac;
    costUSD -= costRemovedUSD;
    principalRemovedKRW += principalOut;
    initialUSDRemoved += (initialUSD - initialUSDRemoved) * frac;
    brokerCostRemovedKRW += (principalKRW + spentKRW - brokerCostRemovedKRW) * frac;
    originalSharesRemoved += (initialShares - originalSharesRemoved) * frac;
    shares = held - n;

    const price = num(s.price);
    const feeUSD = num(s.feeUSD);
    const grossUSD = n * price;
    const netUSD = grossUSD - feeUSD;
    const realizedUSD = netUSD - costRemovedUSD;
    const fx = num(s.fxRate) > 0 ? num(s.fxRate) : null;
    const proceedsKRW = fx ? netUSD * fx : null;
    const realizedKRW = fx ? proceedsKRW - principalOut : null;

    sold.shares += n;
    sold.netUSD += netUSD;
    sold.feeUSD += feeUSD;
    sold.realizedUSD += realizedUSD;
    if (fx) {
      sold.convertedKRW += proceedsKRW;
      sold.convertedRealizedKRW += realizedKRW;
    } else {
      sold.unconvertedNetUSD += netUSD;
      sold.unconvertedPrincipalKRW += principalOut;
    }

    sellHistory.push({
      id: s.id,
      date: s.date,
      sharesRequested: requested,
      sharesSold: n,
      oversold: requested > held + 1e-9, // 그때 보유 주수보다 많이 판 기록 (계산은 보유 주수까지만)
      sharesBefore: held,
      sharesAfter: shares,
      price,
      feeUSD,
      grossUSD,
      netUSD,
      avgCost: avgBefore,
      avgCostAfter: shares > 0 ? costUSD / shares : 0, // 팔고 난 뒤 남은 주식의 평균 단가 (= avgCost)
      costRemovedUSD,
      principalPerShareKRW,
      principalRemovedKRW: principalOut,
      realizedUSD,
      fxRate: fx,
      proceedsKRW,
      realizedKRW,
    });
  };

  // 분배 기록과 매도 기록을 날짜순으로 섞어 적용 (같은 날은 분배 먼저)
  const recs = sortRecords(records);
  const sls = sortRecords(sells);
  let i = 0;
  let j = 0;
  while (i < recs.length || j < sls.length) {
    if (j >= sls.length || (i < recs.length && recs[i].date <= sls[j].date)) applyRecord(recs[i++]);
    else applySell(sls[j++]);
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
    spentKRW,
    history,
    hasSells: sellHistory.length > 0,
    sellHistory,
    sold,
    remainingPrincipalKRW: principalKRW - principalRemovedKRW,
    remainingInitialUSD: initialUSD - initialUSDRemoved,
    brokerCostRemovedKRW,
    originalShares: initialShares - originalSharesRemoved,
  };
}

/**
 * 성적표 계산. "주수가 늘었는지"와 "돈이 늘었는지"를 따로 계산합니다.
 *
 * 총수익률(분배금 포함, 판 돈 포함 = 전체 기준) = (현재 평가금액 + 판 돈 − 원금) ÷ 원금
 *   현재 평가금액 = (보유 주수 × 현재 주가 + 남은 현금) × 현재 환율
 *   판 돈 = 수수료를 뺀 매도 금액 (원화로 바꿨으면 그때 환율, 아니면 현재 환율)
 * 남은 주식 기준 수익률 = (현재 평가금액 − 남은 원금) ÷ 남은 원금
 * 매도 기록이 없으면 판 돈은 0, 남은 원금은 원금이라 두 수익률이 같고 예전 총수익률과 똑같습니다.
 *
 * 분배금은 전부 주식으로 다시 샀기 때문에 이미 "보유 주수" 안에 들어 있습니다.
 * 그래서 분배금 합계를 평가금액에 한 번 더 더하지 않습니다(이중 계산 방지).
 */
export function computeReport(settings, records, market, sells = []) {
  const p = computePortfolio(settings, records, sells);
  const price = num(market.price);
  const fx = num(market.fxRate);
  const principalKRW = num(settings.principalKRW);
  const hasSells = p.hasSells;

  const stockValueUSD = p.shares * price;
  const valueUSD = stockValueUSD + p.cashUSD;
  const valueKRW = valueUSD * fx;

  // 판 돈과 실현 손익 (매도가 없으면 모두 0)
  const soldProceedsUSD = p.sold.netUSD;
  const soldProceedsKRW = p.sold.convertedKRW + p.sold.unconvertedNetUSD * fx;
  const realizedUSD = p.sold.realizedUSD;
  const realizedKRW = p.sold.convertedRealizedKRW + (p.sold.unconvertedNetUSD * fx - p.sold.unconvertedPrincipalKRW);

  const profitKRW = hasSells ? valueKRW + soldProceedsKRW - principalKRW : valueKRW - principalKRW;
  const totalReturn = principalKRW > 0 ? profitKRW / principalKRW : null;

  const remainingPrincipalKRW = p.remainingPrincipalKRW;
  const remainingProfitKRW = valueKRW - remainingPrincipalKRW;
  const remainingReturn = remainingPrincipalKRW > 0 ? remainingProfitKRW / remainingPrincipalKRW : null;

  const addedShares = p.shares - p.initialShares;
  const shareGrowth = p.initialShares > 0 ? addedShares / p.initialShares : null;

  // 처음 갖고 있던 주식만의 지금 가치 vs 분배금으로 늘어난 부분의 지금 가치
  // (팔았으면 처음 주식도 판 비율만큼 줄어든 것으로 봄)
  const originalValueKRW = hasSells ? p.originalShares * price * fx : p.initialShares * price * fx;
  const reinvestedValueKRW = valueKRW - originalValueKRW;
  // 분배금을 전혀 받지 않았다고 가정했을 때의 수익률 (= 주가·환율 변화만의 효과, 남은 주식 기준)
  const basePrincipal = hasSells ? remainingPrincipalKRW : principalKRW;
  const priceOnlyReturn = basePrincipal > 0 ? (originalValueKRW - basePrincipal) / basePrincipal : null;
  // 평균 단가 대비 현재 주가 (달러 기준)
  const priceVsAvg = p.avgCost > 0 ? price / p.avgCost - 1 : null;

  // 증권사 기준 수익률: 분배금으로 산 주식의 매수 금액(그날 환율로 원화 환산)도 원금으로 봅니다.
  //   매수원금 = 내가 넣은 원금 + Σ(재매수 주수 × 매수 가격 × 그날 환율) − 판 주식의 매수원금
  //   수익률   = (보유 주식 평가금액 − 매수원금) ÷ 매수원금   (증권사 앱처럼 남은 주식 기준)
  // 증권사 앱처럼 주식만 평가하므로 재매수 후 남은 현금은 넣지 않습니다.
  const brokerCostKRW = hasSells ? principalKRW + p.spentKRW - p.brokerCostRemovedKRW : principalKRW + p.spentKRW;
  const stockValueKRW = stockValueUSD * fx;
  const brokerProfitKRW = stockValueKRW - brokerCostKRW;
  const brokerReturn = principalKRW > 0 ? brokerProfitKRW / brokerCostKRW : null;

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
    stockValueKRW,
    brokerCostKRW,
    brokerProfitKRW,
    brokerReturn,
    verdict: verdictText(addedShares, profitKRW, principalKRW),
    // 매도 관련 (매도가 없으면 남은 주식 기준 = 전체 기준)
    overallReturn: totalReturn,
    remainingPrincipalKRW,
    remainingProfitKRW,
    remainingReturn,
    soldShares: p.sold.shares,
    soldProceedsUSD,
    soldProceedsKRW,
    realizedUSD,
    realizedKRW,
  };
}

function verdictText(addedShares, profitKRW, principalKRW) {
  if (principalKRW <= 0) return '설정에서 원금을 입력하면 돈이 늘었는지 알려드려요.';
  const s = addedShares > 0;
  const m = profitKRW > 0;
  if (addedShares < 0) {
    // 매도로 처음보다 주수가 줄어든 경우 (매도 기록이 없으면 생기지 않음)
    return m ? '판 주식이 있어 주수는 줄었지만, 판 돈까지 합치면 돈은 늘었어요.' : '판 주식이 있어 주수는 줄었고, 판 돈까지 합쳐도 돈은 원금보다 적어요.';
  }
  if (s && m) return '주수도 늘었고, 돈도 늘었어요.';
  if (s && !m) return '주수는 늘었지만, 돈은 아직 원금보다 적어요.';
  if (!s && m) return '주수는 그대로지만, 돈은 늘었어요.';
  return '주수도 그대로이고, 돈도 원금보다 적어요.';
}

/**
 * 달러 기준 수익률과 환율 효과. (computeReport 의 기존 수익률 계산은 그대로 두고 따로 계산합니다.)
 *
 * U  = 처음 환전해서 넣은 달러 (settings.initialUSD)
 * P  = 내가 넣은 원화 원금 (settings.principalKRW)
 * F0 = 평균 환전 환율 = P ÷ U   ← 그래서 P = U × F0
 * V  = 현재 평가금액(달러) = 보유 주수 × 현재 주가 + 남은 현금
 * F  = 현재 환율
 *
 * 달러 기준 수익률       = (V − U) ÷ U
 * 총손익(원화)           = V × F − P                (computeReport 의 profitKRW 와 같은 값)
 *   = 달러 기준 손익(원화) = (V − U) × F            달러로 번 돈을 지금 환율로 환산
 *   + 환율 효과            = U × (F − F0)           처음 바꾼 달러가 환율 변동으로 얻거나 잃은 원화
 * 두 값을 더하면 (V − U)F + UF − UF0 = VF − P 로 총손익과 정확히 같습니다.
 *
 * 매도 기록이 있으면 U 와 P 를 판 비율만큼 줄인 "남은 주식 기준"으로 계산합니다(평균 환전 환율 F0 는 그대로).
 * 이때 총손익은 computeReport 의 remainingProfitKRW 와 같습니다.
 *
 * 화면에는 원 단위로 반올림해 보여 주므로, 반올림해도 합이 맞도록 display 값도 함께 돌려줍니다.
 */
export function computeFxBreakdown(settings, records, market, sells = []) {
  const r = computeReport(settings, records, market, sells);
  const U = r.hasSells ? r.remainingInitialUSD : num(settings.initialUSD);
  const P = r.hasSells ? r.remainingPrincipalKRW : r.principalKRW;
  const profitKRW = r.hasSells ? r.remainingProfitKRW : r.profitKRW;
  const F = r.fxRate;
  const V = r.valueUSD;
  if (!(U > 0) || !(P > 0)) {
    return { ready: false, initialUSD: U, avgFxRate: null, profitKRW, hasSells: r.hasSells };
  }
  const F0 = P / U;
  const usdProfit = V - U;
  const usdReturn = usdProfit / U;
  const usdProfitKRW = usdProfit * F;
  const fxEffectKRW = U * (F - F0);
  const fxReturn = F0 > 0 ? F / F0 - 1 : null;

  // 원 단위 표시: 총손익과 달러 기준 손익을 반올림하고, 환율 효과는 그 차이로 정해 합이 꼭 맞게 함
  const totalWon = Math.round(profitKRW);
  const usdWon = Math.round(usdProfitKRW);

  return {
    ready: true,
    initialUSD: U,
    avgFxRate: F0,
    fxRate: F,
    valueUSD: V,
    usdProfit,
    usdReturn,
    usdProfitKRW,
    fxEffectKRW,
    fxReturn,
    profitKRW,
    hasSells: r.hasSells,
    display: { totalKRW: totalWon, usdProfitKRW: usdWon, fxEffectKRW: totalWon - usdWon },
  };
}

/**
 * 시뮬레이션 결과(예: 52주 뒤 평가금액)를 원금과 비교합니다. 다른 계산은 바꾸지 않고 따로 계산합니다.
 *
 * report 는 computeReport 결과(지금 기준)입니다.
 * - 남은 주식 기준: (평가금액 − 남은 원금) ÷ 남은 원금      ← 성적표 "남은 주식 기준"과 같은 원금
 * - 전체 기준(매도 기록이 있을 때만): (평가금액 + 지금까지 판 돈 − 처음 원금) ÷ 처음 원금
 *   판 돈은 성적표와 같은 값(원화로 안 바꾼 판 돈은 현재 환율)을 씁니다.
 * 지금 평가금액을 넣으면 성적표의 두 수익률과 똑같이 나옵니다.
 */
export function compareToPrincipal(valueKRW, report) {
  const V = num(valueKRW);
  const base = report.remainingPrincipalKRW;
  const profitKRW = V - base;
  const remaining = { principalKRW: base, profitKRW, rate: base > 0 ? profitKRW / base : null };
  let overall = null;
  if (report.hasSells) {
    const P = report.principalKRW;
    const overallProfit = V + report.soldProceedsKRW - P;
    overall = { principalKRW: P, profitKRW: overallProfit, rate: P > 0 ? overallProfit / P : null };
  }
  return { remaining, overall };
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
