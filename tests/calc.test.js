import { test, assertEqual, assertClose, assert } from './mini-test.js';
import { computePortfolio, computeReport, simulate, findTargetWeek, addWeeks, sortRecords } from '../js/calc.js';
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

test('성적표: 원금이 0이면 수익률은 계산하지 않음(null)', () => {
  const r = computeReport({ ...settings, principalKRW: 0 }, records, { price: 13, fxRate: 1400 });
  assertEqual(r.totalReturn, null);
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
  s.settings = { ...settings };
  s.records = records.map((r) => ({ ...r }));
  s.market = { price: 13, fxRate: 1400 };
  const back = normalizeState(JSON.parse(JSON.stringify(s)));
  assertEqual(JSON.stringify(back), JSON.stringify(s));
});
