import { test, assertEqual, assertClose, assert } from './mini-test.js';
import { computePortfolio, computeReport, computeFxBreakdown, simulate, findTargetWeek, addWeeks, sortRecords } from '../js/calc.js';
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
