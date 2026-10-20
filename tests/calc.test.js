import { test, assertEqual, assertClose, assert } from './mini-test.js';
import { computePortfolio, computeReport, computeFxBreakdown, compareToPrincipal, projectedDistribution, distributionSeries, distributionTrend, simulate, findTargetWeek, addWeeks, sortRecords } from '../js/calc.js';
import { normalizeState, defaultState } from '../js/storage.js';

// 요청서의 예시: 처음 100주, 평균 단가 $15, 주당 $0.2씩 2주 분배
const settings = { initialShares: 100, initialAvgCost: 15, principalKRW: 2_000_000 };
const records = [
  { id: 'a', date: '2026-01-02', dividendUSD: 100 * 0.2, sharesBought: 1, price: 14, fxRate: 1400 }, // $20 받아 1주
  { id: 'b', date: '2026-01-09', dividendUSD: 101 * 0.2, sharesBought: 2, price: 13, fxRate: 1410 }, // $20.2 받아 2주
];

test('예시: 2주 재매수 후 보유 주수는 103주', () => {
  const p = computePortfolio(settings, records);
  assertEqual(p.shares, 103);
});

test('예시: 평균 단가는 (1500 + 14 + 26) / 103 ≈ $14.95', () => {
  const p = computePortfolio(settings, records);
  assertClose(p.avgCost, 1540 / 103, 1e-12);
  assertEqual(p.avgCost.toFixed(2), '14.95');
});

test('예시: 받은 분배금 합계와 남은 현금', () => {
  const p = computePortfolio(settings, records);
  assertClose(p.dividendsUSD, 40.2, 1e-9);
  assertClose(p.spentUSD, 40, 1e-9); // 14 + 26
  assertClose(p.cashUSD, 0.2, 1e-9);
  assertClose(p.dividendsKRW, 20 * 1400 + 20.2 * 1410, 1e-6);
});

test('기록 순서가 뒤섞여 입력돼도 날짜순으로 계산', () => {
  const p = computePortfolio(settings, [records[1], records[0]]);
  assertEqual(p.history[0].id, 'a');
  assertEqual(p.history[0].shares, 101);
  assertClose(p.history[0].avgCost, 1514 / 101, 1e-12);
  assertEqual(sortRecords([records[1], records[0]])[0].id, 'a');
});

test('기록이 없으면 처음 상태 그대로', () => {
  const p = computePortfolio(settings, []);
  assertEqual(p.shares, 100);
  assertEqual(p.avgCost, 15);
  assertEqual(p.cashUSD, 0);
});

test('성적표: 총수익률 = (평가금액 − 원금) ÷ 원금, 분배금을 이중으로 더하지 않음', () => {
  const r = computeReport(settings, records, { price: 13, fxRate: 1400 });
  const valueUSD = 103 * 13 + 0.2;
  assertClose(r.valueUSD, valueUSD, 1e-9);
  assertClose(r.valueKRW, valueUSD * 1400, 1e-6);
  assertClose(r.totalReturn, (valueUSD * 1400 - 2_000_000) / 2_000_000, 1e-12);
  assertEqual(r.addedShares, 3);
  assert(r.sharesUp, '주수는 늘었어야 함');
  assert(!r.moneyUp, '평가금액 1,875,020원 < 원금 2,000,000원이므로 돈은 줄었어야 함');
  assertEqual(r.verdict, '주수는 늘었지만, 돈은 아직 원금보다 적어요.');
});

test('성적표: 처음 주식 가치 + 재투자분 가치 = 평가금액', () => {
  const r = computeReport(settings, records, { price: 13, fxRate: 1400 });
  assertClose(r.originalValueKRW, 100 * 13 * 1400, 1e-6);
  assertClose(r.originalValueKRW + r.reinvestedValueKRW, r.valueKRW, 1e-6);
});

test('증권사 기준 수익률: 재매수 금액(그날 환율)을 원금에 더하고, 남은 현금은 빼고 계산', () => {
  const r = computeReport(settings, records, { price: 13, fxRate: 1400 });
  const reinvestKRW = 1 * 14 * 1400 + 2 * 13 * 1410; // 19,600 + 36,660 = 56,260
  const cost = 2_000_000 + reinvestKRW;
  const stockValue = 103 * 13 * 1400; // 1,874,600
  assertClose(r.spentKRW, 56_260, 1e-6);
  assertClose(r.brokerCostKRW, cost, 1e-6);
  assertClose(r.stockValueKRW, stockValue, 1e-6);
  assertClose(r.brokerReturn, (stockValue - cost) / cost, 1e-12);
  assertEqual((r.brokerReturn * 100).toFixed(2), '-8.83');
});

test('증권사 기준 수익률은 분배금을 원금으로 보므로 이 앱의 총수익률보다 낮음', () => {
  for (const price of [10, 13, 20, 30]) {
    const r = computeReport(settings, records, { price, fxRate: 1400 });
    assert(r.brokerReturn < r.totalReturn, `주가 $${price}: 증권사 ${r.brokerReturn} < 앱 ${r.totalReturn}`);
  }
});

test('재매수 기록이 없으면 증권사 기준과 앱 총수익률이 같음', () => {
  const r = computeReport(settings, [], { price: 13, fxRate: 1400 });
  assertClose(r.brokerReturn, r.totalReturn, 1e-12);
});

test('성적표: 원금이 0이면 수익률은 계산하지 않음(null)', () => {
  const r = computeReport({ ...settings, principalKRW: 0 }, records, { price: 13, fxRate: 1400 });
  assertEqual(r.totalReturn, null);
  assertEqual(r.brokerReturn, null);
});

test('시뮬레이션: 분배금 0, 주가·환율 그대로면 52주 내내 주수와 평가금액이 변하지 않음', () => {
  const start = { shares: 103, cashUSD: 0.2, price: 13, fxRate: 1400 };
  for (const fractional of [false, true]) {
    const pts = simulate(start, { dps: 0, priceChangePct: 0, fxRate: '' }, { weeks: 52, fractional });
    assertEqual(pts.length, 53);
    for (const pt of pts) {
      assertClose(pt.shares, 103, 1e-12, `${pt.week}주차 주수`);
      assertClose(pt.valueKRW, (103 * 13 + 0.2) * 1400, 1e-6, `${pt.week}주차 평가금액`);
    }
  }
});

test('시뮬레이션: 1주 단위 매수는 자투리를 다음 주로 넘김', () => {
  // 100주 × $0.2 = 주당 $20, 주가 $15 고정 → 1주차 1주 사고 $5 남음, 2주차 $5 + 101×0.2 = $25.2 → 1주, $10.2 남음
  const pts = simulate({ shares: 100, cashUSD: 0, price: 15, fxRate: 1400 }, { dps: 0.2, priceChangePct: 0 }, { weeks: 2 });
  assertEqual(pts[1].shares, 101);
  assertClose(pts[1].cashUSD, 5, 1e-9);
  assertEqual(pts[2].shares, 102);
  assertClose(pts[2].cashUSD, 10.2, 1e-9);
});

test('시뮬레이션: 주가 변화율은 52주 뒤에 정확히 맞춰짐', () => {
  const pts = simulate({ shares: 10, cashUSD: 0, price: 20, fxRate: 1300 }, { dps: 0, priceChangePct: -50, fxRate: 1500 });
  assertClose(pts[52].price, 10, 1e-9);
  assertClose(pts[52].fxRate, 1500, 1e-9);
  assertClose(pts[26].fxRate, 1400, 1e-9);
});

test('시뮬레이션: 소수점 매수면 현금이 남지 않음', () => {
  const pts = simulate({ shares: 100, cashUSD: 0, price: 15, fxRate: 1400 }, { dps: 0.2, priceChangePct: 0 }, { weeks: 1, fractional: true });
  assertClose(pts[1].shares, 100 + 20 / 15, 1e-12);
  assertClose(pts[1].cashUSD, 0, 1e-12);
});

test('목표 도달 주차 찾기', () => {
  const pts = [0, 1, 2, 3].map((w) => ({ week: w, valueKRW: 100 + w * 10 }));
  assertEqual(findTargetWeek(pts, 115), 2);
  assertEqual(findTargetWeek(pts, 100), 0);
  assertEqual(findTargetWeek(pts, 999), null);
  assertEqual(findTargetWeek(pts, 0), null);
});

test('날짜에 주 더하기', () => {
  assertEqual(addWeeks('2026-12-25', 1), '2027-01-01');
  assertEqual(addWeeks('2026-10-16', 52), '2027-10-15');
});

test('백업 불러오기: 빠진 값은 기본값으로 채우고 잘못된 파일은 거부', () => {
  const s = normalizeState({ settings: { initialShares: '100' }, records: [{ date: '2026-01-02', dividendUSD: '20' }] });
  assertEqual(s.settings.initialShares, 100);
  assertEqual(s.records[0].dividendUSD, 20);
  assertEqual(s.records[0].sharesBought, 0);
  assertEqual(s.sim.scenarios.base.dps, defaultState().sim.scenarios.base.dps);
  let threw = false;
  try { normalizeState([1, 2, 3]); } catch { threw = true; }
  assert(threw, '배열은 거부해야 함');
});

test('백업 내보내기 → 불러오기 하면 데이터가 그대로', () => {
  const s = defaultState();
  s.settings = { ...settings, initialUSD: 1600 };
  s.records = records.map((r) => ({ ...r }));
  s.market = { price: 13, fxRate: 1400 };
  const back = normalizeState(JSON.parse(JSON.stringify(s)));
  assertEqual(JSON.stringify(back), JSON.stringify(s));
});

test('예전 백업(넣은 달러 칸 없음)을 불러오면 넣은 달러는 0', () => {
  const s = normalizeState({ settings: { initialShares: 100, initialAvgCost: 15, principalKRW: 2_000_000 }, records: [] });
  assertEqual(s.settings.initialUSD, 0);
  assertEqual(s.settings.principalKRW, 2_000_000);
});

// ---------- 달러 기준 수익률과 환율 효과 ----------
// 원금 200만 원을 1,600달러로 환전 → 평균 환전 환율 1,250원
const usdSettings = { ...settings, initialUSD: 1600 };
const market1400 = { price: 13, fxRate: 1400 };

test('평균 환전 환율 = 원화 원금 ÷ 넣은 달러', () => {
  const b = computeFxBreakdown(usdSettings, records, market1400);
  assert(b.ready, '계산 가능해야 함');
  assertClose(b.avgFxRate, 1250, 1e-12);
});

test('달러 기준 수익률 = (현재 평가금액 달러 − 넣은 달러) ÷ 넣은 달러', () => {
  const b = computeFxBreakdown(usdSettings, records, market1400);
  const V = 103 * 13 + 0.2; // 1,339.2달러 (남은 현금 포함)
  assertClose(b.valueUSD, V, 1e-9);
  assertClose(b.usdProfit, V - 1600, 1e-9);
  assertClose(b.usdReturn, (V - 1600) / 1600, 1e-12);
  assertEqual((b.usdReturn * 100).toFixed(2), '-16.30');
});

test('예시: 달러 기준 손익 −365,120원 + 환율 효과 +240,000원 = 총손익 −125,120원', () => {
  const b = computeFxBreakdown(usdSettings, records, market1400);
  assertClose(b.usdProfitKRW, (1339.2 - 1600) * 1400, 1e-6); // −365,120
  assertClose(b.fxEffectKRW, 1600 * (1400 - 1250), 1e-6); // +240,000
  assertClose(b.profitKRW, -125_120, 1e-6);
  assertClose(b.usdProfitKRW + b.fxEffectKRW, b.profitKRW, 1e-6);
  assertEqual(b.display.usdProfitKRW, -365_120);
  assertEqual(b.display.fxEffectKRW, 240_000);
  assertEqual(b.display.totalKRW, -125_120);
});

test('총손익은 기존 성적표(computeReport)의 손익과 같고, 기존 수익률은 그대로', () => {
  const b = computeFxBreakdown(usdSettings, records, market1400);
  const r = computeReport(usdSettings, records, market1400);
  const old = computeReport(settings, records, market1400); // 넣은 달러 없이 계산한 기존 값
  assertEqual(b.profitKRW, r.profitKRW);
  assertEqual(r.totalReturn, old.totalReturn);
  assertEqual(r.brokerReturn, old.brokerReturn);
});

test('여러 무작위 경우에도 달러 기준 손익 + 환율 효과 = 총손익 (원 단위 표시도 정확히 합이 맞음)', () => {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 500; i++) {
    const s = {
      initialShares: Math.floor(rand() * 2000),
      initialAvgCost: 5 + rand() * 30,
      principalKRW: Math.round(100_000 + rand() * 100_000_000),
      initialUSD: 0,
    };
    s.initialUSD = Math.round((s.principalKRW / (1100 + rand() * 400)) * 100) / 100;
    const recs = Array.from({ length: Math.floor(rand() * 10) }, (_, k) => ({
      id: `x${k}`, date: `2026-0${1 + (k % 9)}-1${k % 10}`,
      dividendUSD: rand() * 300, sharesBought: Math.floor(rand() * 20), price: 5 + rand() * 30, fxRate: 1200 + rand() * 300,
    }));
    const m = { price: 1 + rand() * 40, fxRate: 1000 + rand() * 600 };
    const b = computeFxBreakdown(s, recs, m);
    const tol = Math.max(1e-6, Math.abs(b.profitKRW) * 1e-12);
    assertClose(b.usdProfitKRW + b.fxEffectKRW, b.profitKRW, tol, `경우 ${i}`);
    assertEqual(b.display.usdProfitKRW + b.display.fxEffectKRW, b.display.totalKRW, `경우 ${i} 표시값 합`);
    assert(Math.abs(b.display.fxEffectKRW - b.fxEffectKRW) <= 1, `경우 ${i}: 표시용 환율 효과는 실제 값과 1원 이내`);
  }
});

test('환율이 평균 환전 환율과 같으면 환율 효과 0, 총손익은 모두 달러 기준 손익', () => {
  const b = computeFxBreakdown(usdSettings, records, { price: 13, fxRate: 1250 });
  assertClose(b.fxEffectKRW, 0, 1e-9);
  assertClose(b.usdProfitKRW, b.profitKRW, 1e-6);
});

test('넣은 달러나 원금이 없으면 달러 기준 계산은 하지 않음', () => {
  assertEqual(computeFxBreakdown(settings, records, market1400).ready, false);
  // 예전 데이터: initialUSD 항목 자체가 없거나, null·빈 값·숫자가 아닌 값
  for (const v of [undefined, null, '', 0, 'abc', -100]) {
    const b = computeFxBreakdown({ ...settings, initialUSD: v }, records, market1400);
    assertEqual(b.ready, false, `initialUSD=${String(v)}`);
    assertEqual(b.avgFxRate, null);
  }
  // 시세가 아직 없을 때(0)도 오류 없이 계산
  assert(computeFxBreakdown(usdSettings, records, { price: 0, fxRate: 0 }).ready, '시세 없어도 계산은 됨');
  assertEqual(computeFxBreakdown({ ...usdSettings, principalKRW: 0 }, records, market1400).ready, false);
});

// ---------- 매도 ----------
// 예시 103주(매수원가 $1,540, 남은 현금 $0.2)에서 2026-01-16 에 10주를 $16 에 팔고 수수료 $1, 1,450원에 원화로 바꿈
const sell10 = { id: 's1', date: '2026-01-16', shares: 10, price: 16, feeUSD: 1, fxRate: 1450 };

test('매도: 보유 주수가 줄고, 남은 주식의 평균 단가는 그대로', () => {
  const before = computePortfolio(settings, records);
  const p = computePortfolio(settings, records, [sell10]);
  assertEqual(p.shares, 93);
  assertClose(p.avgCost, before.avgCost, 1e-12);
  assertClose(p.costUSD, 1540 - 10 * (1540 / 103), 1e-9);
  assertClose(p.cashUSD, before.cashUSD, 1e-12); // 판 돈은 재매수용 현금에 섞지 않음
});

test('매도: 원금은 판 주수 × 평균 원금만큼 빠짐 (원화 원금·넣은 달러 모두)', () => {
  const p = computePortfolio(usdSettings, records, [sell10]);
  const h = p.sellHistory[0];
  assertClose(h.principalPerShareKRW, 2_000_000 / 103, 1e-9);
  assertClose(h.principalRemovedKRW, 10 * (2_000_000 / 103), 1e-6);
  assertClose(p.remainingPrincipalKRW, 2_000_000 * 93 / 103, 1e-6);
  assertClose(p.remainingInitialUSD, 1600 * 93 / 103, 1e-9);
});

test('매도: 실현 손익 달러 = 순매도금액 − 판 주수 × 평균 단가, 원화 = 순매도금액 × 환율 − 빠진 원금', () => {
  const h = computePortfolio(settings, records, [sell10]).sellHistory[0];
  assertClose(h.netUSD, 159, 1e-12); // 10 × 16 − 1
  assertClose(h.realizedUSD, 159 - 10 * (1540 / 103), 1e-9); // +$9.49
  assertClose(h.proceedsKRW, 159 * 1450, 1e-6); // 230,550원
  assertClose(h.realizedKRW, 159 * 1450 - 10 * (2_000_000 / 103), 1e-6); // +36,375원
  assertEqual(h.oversold, false);
});

test('성적표: 남은 주식 기준과 전체 기준(판 돈 포함) 수익률, 판 돈 합계', () => {
  const r = computeReport(settings, records, market1400, [sell10]);
  const valueKRW = (93 * 13 + 0.2) * 1400; // 1,692,880원
  const remaining = 2_000_000 * 93 / 103;
  assertClose(r.valueKRW, valueKRW, 1e-6);
  assertClose(r.soldProceedsKRW, 230_550, 1e-6);
  assertClose(r.soldProceedsUSD, 159, 1e-12);
  assertEqual(r.soldShares, 10);
  assertClose(r.profitKRW, valueKRW + 230_550 - 2_000_000, 1e-6); // −76,570원
  assertClose(r.overallReturn, (valueKRW + 230_550 - 2_000_000) / 2_000_000, 1e-12);
  assertEqual(r.totalReturn, r.overallReturn);
  assertClose(r.remainingReturn, (valueKRW - remaining) / remaining, 1e-12);
  // 전체 손익 = 남은 주식 손익 + 실현 손익(원화)
  assertClose(r.profitKRW, r.remainingProfitKRW + r.realizedKRW, 1e-6);
  // 증권사 기준 매수원금도 판 비율만큼 줄어듦
  assertClose(r.brokerCostKRW, (2_000_000 + 56_260) * 93 / 103, 1e-6);
});

test('원화로 바꾸지 않은 매도(환율 비움)는 판 돈과 실현 손익을 현재 환율로 계산', () => {
  const r = computeReport(settings, records, market1400, [{ ...sell10, fxRate: '' }]);
  const out = 10 * (2_000_000 / 103);
  assertClose(r.soldProceedsKRW, 159 * 1400, 1e-6);
  assertClose(r.realizedKRW, 159 * 1400 - out, 1e-6);
  assertEqual(r.sellHistory[0].fxRate, null);
  assertEqual(r.sellHistory[0].realizedKRW, null);
  assertClose(r.profitKRW, r.remainingProfitKRW + r.realizedKRW, 1e-6);
});

test('매도 뒤 분배·재매수는 줄어든 주수에서 이어지고, 같은 날짜면 분배를 먼저 적용', () => {
  const later = { id: 'c', date: '2026-01-23', dividendUSD: 93 * 0.2, sharesBought: 1, price: 13.5, fxRate: 1400 };
  const p = computePortfolio(settings, [...records, later], [sell10]);
  assertEqual(p.shares, 94);
  assertClose(p.costUSD, 1540 - 10 * (1540 / 103) + 13.5, 1e-9);
  // 2026-01-09 분배(2주 재매수)와 같은 날 판 경우: 103주에서 판 것으로 계산
  const same = computePortfolio(settings, records, [{ ...sell10, date: '2026-01-09' }]);
  assertEqual(same.sellHistory[0].sharesBefore, 103);
});

test('보유 주수보다 많이 판 기록은 보유 주수까지만 계산하고 표시해 둠', () => {
  const p = computePortfolio(settings, records, [{ ...sell10, shares: 200 }]);
  const h = p.sellHistory[0];
  assertEqual(h.sharesSold, 103);
  assertEqual(h.oversold, true);
  assertEqual(p.shares, 0);
  assertEqual(p.remainingPrincipalKRW, 0);
  const r = computeReport(settings, records, market1400, [{ ...sell10, shares: 200 }]);
  assertEqual(r.remainingReturn, null); // 남은 원금이 없으면 남은 주식 기준은 계산하지 않음
  assert(Number.isFinite(r.overallReturn), '전체 기준은 계산됨');
});

test('달러 기준·환율 효과는 남은 주식 기준으로 계산하고, 평균 환전 환율은 그대로', () => {
  const b = computeFxBreakdown(usdSettings, records, market1400, [sell10]);
  const r = computeReport(usdSettings, records, market1400, [sell10]);
  assert(b.ready && b.hasSells, '계산 가능');
  assertClose(b.avgFxRate, 1250, 1e-9);
  assertClose(b.initialUSD, 1600 * 93 / 103, 1e-9);
  assertClose(b.profitKRW, r.remainingProfitKRW, 1e-9);
  assertClose(b.usdProfitKRW + b.fxEffectKRW, b.profitKRW, 1e-6);
  assertEqual(b.display.usdProfitKRW + b.display.fxEffectKRW, b.display.totalKRW);
});

test('여러 무작위 매도에서도 평균 단가 유지, 전체 손익 = 남은 주식 손익 + 실현 손익', () => {
  let seed = 777;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 300; i++) {
    const s = { initialShares: 50 + Math.floor(rand() * 2000), initialAvgCost: 5 + rand() * 30, principalKRW: Math.round(1e6 + rand() * 9e7), initialUSD: 0 };
    s.initialUSD = s.principalKRW / (1150 + rand() * 350);
    const recs = Array.from({ length: Math.floor(rand() * 12) }, (_, k) => ({
      id: `x${k}`, date: `2026-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-10`,
      dividendUSD: rand() * 300, sharesBought: Math.floor(rand() * 20), price: 5 + rand() * 30, fxRate: 1200 + rand() * 300,
    }));
    const sls = Array.from({ length: 1 + Math.floor(rand() * 4) }, (_, k) => ({
      id: `s${k}`, date: `2026-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')}-15`,
      shares: Math.floor(rand() * 300), price: 3 + rand() * 40, feeUSD: rand() * 5, fxRate: rand() < 0.5 ? '' : 1200 + rand() * 300,
    }));
    const m = { price: 1 + rand() * 40, fxRate: 1000 + rand() * 600 };
    const r = computeReport(s, recs, m, sls);
    const tol = Math.max(1e-6, Math.abs(s.principalKRW) * 1e-12);
    assertClose(r.profitKRW, r.remainingProfitKRW + r.realizedKRW, tol, `경우 ${i}: 손익 합`);
    assert(r.shares >= 0 && r.remainingPrincipalKRW >= -1e-6, `경우 ${i}: 음수 없음`);
    for (const h of r.sellHistory) {
      // 매도 직후 남은 주식의 평균 단가 = 매도 직전 평균 단가
      if (h.sharesAfter > 0) assertClose(h.avgCostAfter, h.avgCost, Math.max(1e-9, h.avgCost * 1e-9), `경우 ${i}: 평균 단가`);
    }
    const b = computeFxBreakdown(s, recs, m, sls);
    if (b.ready) assertEqual(b.display.usdProfitKRW + b.display.fxEffectKRW, b.display.totalKRW, `경우 ${i}: 표시 합`);
  }
});

test('백업: 매도 기록도 내보내고 불러오며, 예전 백업(매도 없음)은 빈 목록으로 읽음', () => {
  const s = defaultState();
  s.settings = { ...usdSettings };
  s.records = records.map((r) => ({ ...r }));
  s.sells = [{ ...sell10 }, { id: 's2', date: '2026-02-01', shares: 3, price: 15.5, feeUSD: 0, fxRate: '' }];
  const back = normalizeState(JSON.parse(JSON.stringify(s)));
  assertEqual(JSON.stringify(back.sells), JSON.stringify(s.sells));
  assertEqual(JSON.stringify(back), JSON.stringify(s));
  assertEqual(JSON.stringify(normalizeState({ settings: {}, records: [] }).sells), '[]');
  // 잘못된 값은 안전하게 정리
  const odd = normalizeState({ sells: [{ date: '2026-03-01', shares: '5', price: 'x', fxRate: 0 }, { shares: 1 }, null] }).sells;
  assertEqual(odd.length, 1);
  assertEqual(odd[0].shares, 5);
  assertEqual(odd[0].price, 0);
  assertEqual(odd[0].fxRate, '');
  assert(odd[0].id.startsWith('s'), 'id 자동 생성');
});

// ---------- 시뮬레이션 결과를 원금과 비교 ----------

test('원금 대비: 남은 원금 기준 수익률과 손익, 매도가 없으면 전체 기준은 없음', () => {
  const r = computeReport(settings, records, market1400);
  const c = compareToPrincipal(2_500_000, r);
  assertEqual(c.remaining.principalKRW, 2_000_000);
  assertEqual(c.remaining.profitKRW, 500_000);
  assertEqual(c.remaining.rate, 0.25);
  assertEqual(c.overall, null);
  const loss = compareToPrincipal(1_500_000, r);
  assertEqual(loss.remaining.profitKRW, -500_000);
  assertEqual(loss.remaining.rate, -0.25);
});

test('원금 대비: 지금 평가금액을 넣으면 성적표의 남은 주식 기준·전체 기준과 똑같음', () => {
  for (const sells of [[], [sell10], [{ ...sell10, fxRate: '' }]]) {
    const r = computeReport(settings, records, market1400, sells);
    const c = compareToPrincipal(r.valueKRW, r);
    assertEqual(c.remaining.rate, r.remainingReturn);
    assertEqual(c.remaining.profitKRW, r.remainingProfitKRW);
    if (sells.length) {
      assertEqual(c.overall.rate, r.overallReturn);
      assertEqual(c.overall.profitKRW, r.profitKRW);
    }
  }
});

test('원금 대비(매도 있음): 전체 기준 = (52주 뒤 평가금액 + 지금까지 판 돈 − 처음 원금) ÷ 처음 원금', () => {
  const r = computeReport(settings, records, market1400, [sell10]);
  const c = compareToPrincipal(2_100_000, r);
  assertClose(c.remaining.principalKRW, 2_000_000 * 93 / 103, 1e-6);
  assertClose(c.remaining.rate, (2_100_000 - 2_000_000 * 93 / 103) / (2_000_000 * 93 / 103), 1e-12);
  assertEqual(c.overall.principalKRW, 2_000_000);
  assertClose(c.overall.profitKRW, 2_100_000 + 230_550 - 2_000_000, 1e-6);
  assertClose(c.overall.rate, (2_100_000 + 230_550 - 2_000_000) / 2_000_000, 1e-12);
});

test('원금 대비: 분배금 0, 주가·환율 그대로인 시나리오는 52주 뒤에도 성적표 수익률과 같음', () => {
  const r = computeReport(settings, records, market1400, [sell10]);
  const pts = simulate({ shares: r.shares, cashUSD: r.cashUSD, price: 13, fxRate: 1400 }, { dps: 0, priceChangePct: 0, fxRate: '' });
  const c = compareToPrincipal(pts.at(-1).valueKRW, r);
  assertClose(c.remaining.rate, r.remainingReturn, 1e-12);
  assertClose(c.overall.rate, r.overallReturn, 1e-12);
});

test('원금 대비: 남은 원금이 0이면(전부 팔았거나 원금 미입력) 수익률은 계산하지 않음', () => {
  const allSold = computeReport(settings, records, market1400, [{ ...sell10, shares: 103 }]);
  assertEqual(compareToPrincipal(0, allSold).remaining.rate, null);
  assert(Number.isFinite(compareToPrincipal(0, allSold).overall.rate), '전체 기준은 계산됨');
  assertEqual(compareToPrincipal(1000, computeReport({ ...settings, principalKRW: 0 }, records, market1400)).remaining.rate, null);
});

// ---------- 시뮬레이션: 예상 분배금 ----------

test('예상 분배금(1회): 보유 주수 × 주당 분배금, 원화는 그때 환율, 주가 대비 = 주당 분배금 ÷ 주가', () => {
  const d = projectedDistribution({ shares: 200, price: 10, fxRate: 1400 }, 0.2);
  assertClose(d.totalUSD, 40, 1e-12);
  assertClose(d.totalKRW, 56_000, 1e-9);
  assertClose(d.yieldOnPrice, 0.02, 1e-15);
  assertEqual(projectedDistribution({ shares: 10, price: 0, fxRate: 1400 }, 0.2).yieldOnPrice, null);
});

test('예상 분배금은 시뮬레이션이 다음 주에 실제로 주는 분배금과 같음', () => {
  const sc = { dps: 0.2, priceChangePct: 0, fxRate: '' };
  const pts = simulate({ shares: 100, cashUSD: 0, price: 15, fxRate: 1400 }, sc, { weeks: 3, fractional: true });
  for (let w = 0; w < 3; w++) {
    // 소수점 매수면 받은 분배금은 전부 주식이 됨 → 늘어난 주수 × 주가 = 그 주 분배금
    const paid = (pts[w + 1].shares - pts[w].shares) * 15;
    assertClose(projectedDistribution(pts[w], sc.dps).totalUSD, paid, 1e-9, `${w}주차`);
  }
});

// ---------- 성적표: 회차별 분배금 ----------

test('회차별 분배금: 총액(달러·원화), 받은 시점 보유 주수, 주당 분배금', () => {
  const s = distributionSeries(settings, records);
  assertEqual(s.length, 2);
  assertEqual(s[0].sharesHeld, 100); // 1회차는 재매수 전 100주
  assertEqual(s[1].sharesHeld, 101); // 2회차는 1회차에 1주 산 뒤
  assertClose(s[0].perShareUSD, 0.2, 1e-15);
  assertClose(s[1].perShareUSD, 0.2, 1e-15);
  assertClose(s[0].totalKRW, 20 * 1400, 1e-9);
  assertClose(s[1].totalKRW, 20.2 * 1410, 1e-9);
  assertEqual(s[1].date, '2026-01-09');
});

test('회차별 분배금: 날짜순으로 정렬되고, 그 사이 매도는 보유 주수에 반영', () => {
  const s = distributionSeries(settings, [records[1], records[0]], [{ id: 's', date: '2026-01-05', shares: 10, price: 15, feeUSD: 0, fxRate: '' }]);
  assertEqual(s[0].date, '2026-01-02');
  assertEqual(s[1].sharesHeld, 91); // 101주에서 10주 판 뒤
  assertClose(s[1].perShareUSD, 20.2 / 91, 1e-15);
  assertEqual(distributionSeries(settings, []).length, 0);
});

test('받는 돈 추세: 8회 이상이면 처음 4회 vs 최근 4회 평균', () => {
  const series = Array.from({ length: 10 }, (_, i) => ({ totalKRW: (i + 1) * 1000, totalUSD: i + 1, sharesHeld: 100 + i, perShareUSD: (i + 1) / (100 + i) }));
  const t = distributionTrend(series);
  assertEqual(t.k, 4);
  assertEqual(t.first.totalKRW, 2500); // 1~4회 평균
  assertEqual(t.last.totalKRW, 8500); // 7~10회 평균
  assertClose(t.changeKRW, 8500 / 2500 - 1, 1e-12);
  assertClose(t.changeUSD, 8.5 / 2.5 - 1, 1e-12);
  assertClose(t.changeShares, 107.5 / 101.5 - 1, 1e-12);
});

test('받는 돈 추세: 8회보다 적으면 반씩(홀수면 가운데 빼고), 2회 미만이면 비교 안 함', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ totalKRW: (i + 1) * 100, totalUSD: i + 1, sharesHeld: 10, perShareUSD: (i + 1) / 10 }));
  const t5 = distributionTrend(mk(5));
  assertEqual(t5.k, 2);
  assertEqual(t5.first.totalKRW, 150); // 1·2회
  assertEqual(t5.last.totalKRW, 450); // 4·5회
  assertEqual(distributionTrend(mk(7)).k, 3);
  assertEqual(distributionTrend(mk(2)).k, 1);
  assertEqual(distributionTrend(mk(1)), null);
  assertEqual(distributionTrend([]), null);
  // 줄어드는 경우
  const down = distributionTrend(mk(6).reverse());
  assert(down.changeKRW < 0, '줄면 음수');
});
