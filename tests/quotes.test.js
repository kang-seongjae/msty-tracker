import { test, assertEqual, assertClose, assert } from './mini-test.js';
import {
  parseFinnhub, parseTwelveData, parseFrankfurter, parseErApi, parseCoinGecko, parseCoinbaseStats,
  isFresh, fetchPrice, fetchFx, fetchBtc, refreshQuotes, QUOTE_TTL_MS,
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
const mstrOK = { body: { c: 312.5, d: -6.25, dp: -1.9608, pc: 318.75, t: 1792180800 } };
const geckoOK = { body: { bitcoin: { usd: 81829, usd_24h_change: 1.9108, last_updated_at: 1792157665 } } };
const coinbaseOK = { body: { open: '80000', last: '82000', high: '82831', low: '80007' } };
/** Finnhub 주소의 symbol 에 따라 MSTY / MSTR 응답을 나눠 줌 */
const finnhubBySymbol = (url) => (url.includes('symbol=MSTR') ? mstrOK : finnhubOK);
const fresh = (value) => ({ value, fetchedAt: NOW - 5 * 60_000, source: 'x' });

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
  const cache = { price: fresh(14), fx: fresh(1340), mstr: fresh(310), btc: fresh(80000) };
  const r = await refreshQuotes({ cache, provider: 'finnhub', apiKey: 'k', now: NOW, fetchImpl: f });
  assertEqual(f.calls.length, 0);
  for (const k of ['price', 'fx', 'mstr', 'btc']) assertEqual(r[k].status, 'cached', k);
  assertEqual(r.price.entry.value, 14);
  assertEqual(r.btc.entry.value, 80000);
});

test('새로고침(force)은 캐시가 있어도 다시 가져옴', async () => {
  const f = fakeFetch({ 'finnhub.io': finnhubBySymbol, frankfurter: frankfurterOK, coingecko: geckoOK });
  const cache = { price: fresh(14), fx: fresh(1340), mstr: fresh(310), btc: fresh(80000) };
  const r = await refreshQuotes({ cache, provider: 'finnhub', apiKey: 'k', force: true, now: NOW, fetchImpl: f });
  assertEqual(f.calls.length, 4); // MSTY, 환율, MSTR, 비트코인 — 새로고침 한 번에 함께 갱신
  for (const k of ['price', 'fx', 'mstr', 'btc']) assertEqual(r[k].status, 'fetched', k);
  assertEqual(r.cache.mstr.value, 312.5);
  assertEqual(r.cache.btc.value, 81829);
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

test('API 키가 없으면 MSTY·MSTR은 호출하지 않고 환율·비트코인만 가져옴', async () => {
  const f = fakeFetch({ frankfurter: frankfurterOK, coingecko: geckoOK });
  const r = await refreshQuotes({ cache: {}, provider: 'finnhub', apiKey: '', now: NOW, fetchImpl: f });
  assertEqual(r.price.status, 'nokey');
  assertEqual(r.mstr.status, 'nokey');
  assertEqual(r.fx.status, 'fetched');
  assertEqual(r.btc.status, 'fetched');
  assertEqual(f.calls.length, 2);
  assert(!f.calls.some((c) => c.url.includes('finnhub')), 'Finnhub 는 호출하지 않아야 함');
});

// ---------- 참고 시세 (MSTR, 비트코인) ----------

test('MSTR: Finnhub 응답에서 가격과 전일 대비 등락률(dp)을 읽음', async () => {
  const f = fakeFetch({ 'finnhub.io': finnhubBySymbol });
  const p = await fetchPrice({ provider: 'finnhub', apiKey: 'k', symbol: 'MSTR', now: NOW, fetchImpl: f });
  assert(f.calls[0].url.includes('symbol=MSTR'), f.calls[0].url);
  assertEqual(p.value, 312.5);
  assertClose(p.changePct, -1.9608, 1e-9);
  assertEqual(p.source, 'Finnhub');
});

test('등락률이 없으면 전일 종가(pc)로 계산하고, 그것도 없으면 null', () => {
  assertClose(parseFinnhub({ c: 110, pc: 100, t: 1 }, 'MSTR').changePct, 10, 1e-9);
  assertEqual(parseFinnhub({ c: 110, t: 1 }, 'MSTR').changePct, null);
  let msg = '';
  try { parseFinnhub({ c: 0, t: 0 }, 'MSTR'); } catch (e) { msg = e.message; }
  assert(msg.includes('MSTR'), '오류 메시지에 종목 이름이 나와야 함: ' + msg);
});

test('Twelve Data: percent_change 를 등락률로 읽음', () => {
  assertClose(parseTwelveData({ close: '312.5', percent_change: '-1.96', timestamp: 1 }, 'MSTR').changePct, -1.96, 1e-9);
});

test('비트코인: CoinGecko 응답에서 가격·24시간 등락률·갱신 시각을 읽음', () => {
  const b = parseCoinGecko(geckoOK.body);
  assertEqual(b.value, 81829);
  assertClose(b.changePct, 1.9108, 1e-9);
  assertEqual(b.asOf, 1792157665 * 1000);
});

test('비트코인: CoinGecko가 실패하면 Coinbase로 다시 시도하고 24시간 시가 대비로 등락률 계산', async () => {
  const f = fakeFetch({ coingecko: { status: 429, body: {} }, 'exchange.coinbase.com': coinbaseOK });
  const b = await fetchBtc({ now: NOW, fetchImpl: f });
  assertEqual(b.source, 'Coinbase');
  assertEqual(b.value, 82000);
  assertClose(b.changePct, 2.5, 1e-9); // 82000 / 80000 − 1
  assertEqual(parseCoinbaseStats({ last: '82000' }, NOW).changePct, null); // 시가가 없으면 등락률 없음
});

test('참고 시세가 실패해도 MSTY 주가·환율은 정상으로 가져옴', async () => {
  const f = fakeFetch({
    'finnhub.io': (url) => (url.includes('symbol=MSTR') ? { status: 500, body: {} } : finnhubOK),
    frankfurter: frankfurterOK,
    // 비트코인 주소는 하나도 없음 → 네트워크 오류
  });
  const r = await refreshQuotes({ cache: {}, provider: 'finnhub', apiKey: 'k', now: NOW, fetchImpl: f });
  assertEqual(r.price.status, 'fetched');
  assertEqual(r.fx.status, 'fetched');
  assertEqual(r.mstr.status, 'failed');
  assertEqual(r.btc.status, 'failed');
  assert(r.mstr.error.length > 0 && r.btc.error.length > 0, '실패 이유가 있어야 함');
  assertEqual(r.cache.mstr, undefined);
});

test('참고 시세도 실패하면 마지막으로 가져온 값을 남김', async () => {
  const old = { mstr: { value: 300, fetchedAt: NOW - 3600_000 }, btc: { value: 79000, fetchedAt: NOW - 3600_000 } };
  const r = await refreshQuotes({ cache: old, provider: 'finnhub', apiKey: 'k', now: NOW, fetchImpl: fakeFetch({}) });
  assertEqual(r.mstr.status, 'stale');
  assertEqual(r.btc.status, 'stale');
  assertEqual(r.cache.mstr.value, 300);
  assertEqual(r.cache.btc.value, 79000);
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
