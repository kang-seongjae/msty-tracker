// "매도 기록이 없으면 지금 숫자가 하나도 바뀌지 않는다" 확인.
// tests/fixtures/no-sell-golden.json 은 매도 기능을 넣기 전 calc.js 로 계산해 둔 결과입니다(다시 만들지 말 것).
// 파일을 직접 읽으므로 터미널(node tests/run.js)에서만 실행합니다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, assertEqual, assert } from './mini-test.js';
import { computePortfolio, computeReport, computeFxBreakdown, simulate } from '../js/calc.js';

const golden = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/no-sell-golden.json'), 'utf8'));

/** 예전 결과에 있던 항목은 모두 같은 값이어야 함 (새로 생긴 항목은 상관없음). JSON 문자열로 비교해 마지막 자리까지 같아야 통과 */
function sameAsBefore(actual, expected, where) {
  for (const key of Object.keys(expected)) {
    assertEqual(JSON.stringify(actual[key]), JSON.stringify(expected[key]), `${where} → ${key}`);
  }
}

test(`매도 기록이 없으면 예전 결과와 똑같음: 보유·평균 단가·기록별 상태 (${golden.cases.length}가지)`, () => {
  for (const c of golden.cases) {
    sameAsBefore(computePortfolio(c.settings, c.records), c.expected.portfolio, `${c.name} / 인자 없음`);
    sameAsBefore(computePortfolio(c.settings, c.records, []), c.expected.portfolio, `${c.name} / 빈 매도`);
  }
});

test('매도 기록이 없으면 예전 결과와 똑같음: 성적표 전체 (총수익률·증권사 기준·쪼개 보기 등)', () => {
  let keys = 0;
  for (const c of golden.cases) {
    sameAsBefore(computeReport(c.settings, c.records, c.market), c.expected.report, `${c.name} / 인자 없음`);
    sameAsBefore(computeReport(c.settings, c.records, c.market, []), c.expected.report, `${c.name} / 빈 매도`);
    keys += Object.keys(c.expected.report).length;
  }
  assert(keys > 1000, `비교한 항목이 너무 적음: ${keys}`);
});

test('매도 기록이 없으면 남은 주식 기준 = 전체 기준 = 예전 총수익률, 판 돈·실현 손익은 0', () => {
  for (const c of golden.cases) {
    const r = computeReport(c.settings, c.records, c.market, []);
    assertEqual(r.remainingReturn, c.expected.report.totalReturn, c.name);
    assertEqual(r.overallReturn, c.expected.report.totalReturn, c.name);
    assertEqual(r.remainingPrincipalKRW, c.expected.report.principalKRW, c.name);
    assertEqual(r.soldShares, 0);
    assertEqual(r.soldProceedsKRW, 0);
    assertEqual(r.realizedKRW, 0);
    assertEqual(r.hasSells, false);
  }
});

test('매도 기록이 없으면 예전 결과와 똑같음: 달러 기준 수익률·환율 효과', () => {
  for (const c of golden.cases) {
    sameAsBefore(computeFxBreakdown(c.settings, c.records, c.market), c.expected.fx, `${c.name} / 인자 없음`);
    sameAsBefore(computeFxBreakdown(c.settings, c.records, c.market, []), c.expected.fx, `${c.name} / 빈 매도`);
  }
});

test('매도 기록이 없으면 예전 결과와 똑같음: 52주 시뮬레이션 (1주 단위·소수점 매수)', () => {
  for (const c of golden.cases) {
    const p = computePortfolio(c.settings, c.records, []);
    const start = { shares: p.shares, cashUSD: p.cashUSD, price: c.market.price, fxRate: c.market.fxRate };
    [false, true].forEach((fractional, k) => {
      sameAsBefore(simulate(start, golden.scenario, { weeks: 52, fractional }).at(-1), c.expected.sim[k], `${c.name} / 시뮬레이션 ${k}`);
    });
  }
});
