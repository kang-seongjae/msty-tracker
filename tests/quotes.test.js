import { test, assertEqual, assertClose, assert } from './mini-test.js';
import {
  parseFinnhub, parseTwelveData, parseFrankfurter, parseErApi,
  isFresh, fetchPrice, fetchFx, refreshQuotes, QUOTE_TTL_MS,
} from '../js/quotes.js';
import { normalizeState } from '../js/storage.js';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

/** 진짜 네트워크 대신 쓰는 가짜 fetch. routes: { '주소 일부': 응답 또는 (url, opts) => 응답 } */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new TypeError('Failed to fetch');
    let r = routes[key];
    if (typeof r === 'function') r = r(url, opts);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => r.body };
  };
  impl.calls = calls;
  return impl;
}

const finnhubOK = { body: { c: 14.25, d: 0.1, dp: 0.7, h: 14.5, l: 14, o: 14.1, pc: 14.15, t: 1792180800 } };
const frankfurterOK = { body: { amount: 1, base: 'USD', date: '2026-10-15', rates: { KRW: 1345.9 } } };
const erOK = { body: { result: 'success', time_last_update_unix: 1792108951, rates: { KRW: 1350.2 } } };

// ---------- 응답 해석 ----------

test('Finnhub 응답에서 현재가와 시세 시각을 읽음', () => {
  const r = parseFinnhub(finnhubOK.body);
  assertEqual(r.value, 14.25);
  assertEqual(r.asOf, 1792180800 * 1000);
});

test('Finnhub: 모르는 종목(c=0)이나 오류 응답은 실패로 처리', () => {
  let msg = '';
  try { parseFinnhub({ c: 0, t: 0 }); } catch (e) { msg = e.message; }
  assert(msg.includes('MSTY'), msg);
  msg = '';
  try { parseFinnhub({ error: 'Invalid API key.' }); } catch (e) { msg = e.message; }
  assertEqual(msg, 'Invalid API key.');
});

test('Twelve Data: 정상 응답과 HTTP 200 안의 오류 응답', () => {
  const r = parseTwelveData({ symbol: 'MSTY', close: '14.30', timestamp: 1792180800 });
  assertClose(r.value, 14.3);
  let msg = '';
  try { parseTwelveData({ status: 'error', code: 401, message: 'bad key' }); } catch (e) { msg = e.message; }
  assertEqual(msg, 'API 키가 올바르지 않아요.');
});

test('환율 응답 해석: Frankfurter(고시 날짜) / ExchangeRate-API', () => {
  const f = parseFrankfurter(frankfurterOK.body);
  assertEqual(f.value, 1345.9);
  assert(f.dateOnly, '날짜만 있는 환율이라고 표시해야 함');
  assertEqual(new Date(f.asOf).toISOString().slice(0, 10), '2026-10-15');
  assertEqual(parseErApi(erOK.body).value, 1350.2);
});

// ---------- 10분 재사용 ----------

test('10분 안에 가져온 값만 신선한 값으로 봄', () => {
  assert(isFresh({ value: 1, fetchedAt: NOW - (QUOTE_TTL_MS - 1) }, NOW), '9분 59초 전은 신선');
  assert(!isFresh({ value: 1, fetchedAt: NOW - QUOTE_TTL_MS }, NOW), '정확히 10분 전은 다시 가져옴');
  assert(!isFresh(undefined, NOW), '값이 없으면 신선하지 않음');
  assert(!isFresh({ value: 1, fetchedAt: NOW + 60_000 }, NOW), '미래 시각(시계 오류)은 믿지 않음');
});

test('10분 안의 캐시가 있으면 API를 호출하지 않음', async () => {
  const f = fakeFetch({});
  const cache = {
    price: { value: 14, fetchedAt: NOW - 5 * 60_000, source: 'Finnhub' },
    fx: { value: 1340, fetchedAt: NOW - 5 * 60_000, source: 'Frankfurter' },
  };
  const r = await refreshQuotes({ cache, provider: 'finnhub', apiKey: 'k', now: NOW, fetchImpl: f });
  assertEqual(f.calls.length, 0);
  assertEqual(r.price.status, 'cached');
  assertEqual(r.fx.status, 'cached');
  assertEqual(r.price.entry.value, 14);
});

test('새로고침(force)은 캐시가 있어도 다시 가져옴', async () => {
  const f = fakeFetch({ 'finnhub.io': finnhubOK, frankfurter: frankfurterOK });
  const cache = { price: { value: 14, fetchedAt: NOW - 60_000 }, fx: { value: 1340, fetchedAt: NOW - 60_000 } };
  const r = await refreshQuotes({ cache, provider: 'finnhub', apiKey: 'k', force: true, now: NOW, fetchImpl: f });
  assertEqual(f.calls.length, 2);
  assertEqual(r.price.status, 'fetched');
  assertEqual(r.cache.price.value, 14.25);
  assertEqual(r.cache.price.fetchedAt, NOW);
  assertEqual(r.cache.fx.value, 1345.9);
});

// ---------- 실패 처리 ----------

test('가져오기 실패 시 마지막으로 가져온 값을 남기고 이유를 알려줌', async () => {
  const f = fakeFetch({ 'finnhub.io': { status: 429, body: {} } }); // 환율 주소는 없음 → 네트워크 오류
  const old = { price: { value: 13.9, fetchedAt: NOW - 3 * 3600_000 }, fx: { value: 1338, fetchedAt: NOW - 3 * 3600_000 } };
  const r = await refreshQuotes({ cache: old, provider: 'finnhub', apiKey: 'k', now: NOW, fetchImpl: f });
  assertEqual(r.price.status, 'stale');
  assertEqual(r.price.entry.value, 13.9);
  assert(r.price.error.includes('한도'), r.price.error);
  assertEqual(r.fx.status, 'stale');
  assertEqual(r.cache.fx.value, 1338);
});

test('예전 값도 없이 실패하면 failed (직접 입력 안내)', async () => {
  const r = await refreshQuotes({ cache: {}, provider: 'finnhub', apiKey: 'k', now: NOW, fetchImpl: fakeFetch({}) });
  assertEqual(r.price.status, 'failed');
  assertEqual(r.price.entry, null);
  assertEqual(r.fx.status, 'failed');
});

test('환율: Frankfurter가 실패하면 ExchangeRate-API로 한 번 더 시도', async () => {
  const f = fakeFetch({ frankfurter: { status: 503, body: {} }, 'open.er-api.com': erOK });
  const fx = await fetchFx({ now: NOW, fetchImpl: f });
  assertEqual(fx.value, 1350.2);
  assertEqual(fx.source, 'ExchangeRate-API');
  assertEqual(f.calls.length, 2);
});

test('API 키가 없으면 주가는 호출하지 않고 환율만 가져옴', async () => {
  const f = fakeFetch({ frankfurter: frankfurterOK });
  const r = await refreshQuotes({ cache: {}, provider: 'finnhub', apiKey: '', now: NOW, fetchImpl: f });
  assertEqual(r.price.status, 'nokey');
  assertEqual(r.fx.status, 'fetched');
  assertEqual(f.calls.length, 1);
  assert(f.calls[0].url.includes('frankfurter'), '환율만 호출');
});

// ---------- API 키 취급 ----------

test('API 키는 응답 캐시에 저장되지 않음', async () => {
  const f = fakeFetch({ 'finnhub.io': finnhubOK, frankfurter: frankfurterOK });
  const r = await refreshQuotes({ cache: {}, provider: 'finnhub', apiKey: 'SECRET123', now: NOW, fetchImpl: f });
  assert(!JSON.stringify(r.cache).includes('SECRET123'), '캐시에 키가 들어가면 안 됨');
});

test('Twelve Data는 키를 주소가 아니라 Authorization 헤더로 보냄', async () => {
  const f = fakeFetch({ 'api.twelvedata.com': { body: { close: '14.3', timestamp: 1792180800 } } });
  const p = await fetchPrice({ provider: 'twelvedata', apiKey: 'SECRET123', now: NOW, fetchImpl: f });
  assertClose(p.value, 14.3);
  assert(!f.calls[0].url.includes('SECRET123'), '주소에 키가 들어가면 안 됨');
  assertEqual(f.calls[0].opts.headers.Authorization, 'apikey SECRET123');
});

test('백업 파일 형식에는 API 키가 끼어들 수 없음', () => {
  const s = normalizeState({ settings: {}, records: [], apiKey: 'SECRET123', api: { apiKey: 'SECRET123' } });
  assert(!JSON.stringify(s).includes('SECRET123'), '백업 데이터에 키가 남으면 안 됨');
});
