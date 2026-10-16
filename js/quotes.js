// 현재 주가·환율을 외부 무료 API에서 가져옵니다. (계산 로직 calc.js 와는 무관)
//
// 주가: Finnhub 또는 Twelve Data  — 무료 API 키 필요. 키는 이 브라우저 localStorage 에만 저장되고
//       코드·저장소·백업 JSON 파일 어디에도 들어가지 않습니다.
// 환율: Frankfurter(중앙은행 고시 환율, 하루 1번) — 키 불필요. 실패하면 ExchangeRate-API 로 한 번 더 시도.
// 참고 시세(수익률 계산에는 쓰지 않음): MSTR 주가는 주가와 같은 제공처, 비트코인은 CoinGecko → Coinbase.
//
// 가져온 값은 10분 동안 재사용해서 호출 횟수를 아낍니다.

export const QUOTE_TTL_MS = 10 * 60 * 1000;
export const SYMBOL = 'MSTY';
const TIMEOUT_MS = 10_000;

const API_KEY_STORAGE = 'msty-tracker-api';
const QUOTE_CACHE_STORAGE = 'msty-tracker-quotes';

export const PRICE_PROVIDERS = {
  finnhub: { label: 'Finnhub', home: 'https://finnhub.io', keyPage: 'https://finnhub.io/register' },
  twelvedata: { label: 'Twelve Data', home: 'https://twelvedata.com', keyPage: 'https://twelvedata.com/register' },
};

export class QuoteError extends Error {}

// ---------- 응답 해석 (순수 함수, 테스트 대상) ----------

/** 숫자로 읽을 수 있으면 숫자, 아니면 null */
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Finnhub /quote 응답 → { value, asOf, changePct }. 모르는 종목이면 c 가 0으로 옵니다.
 * changePct 는 전일 종가 대비 등락률(%)입니다.
 */
export function parseFinnhub(json, symbol = SYMBOL) {
  if (json?.error) throw new QuoteError(json.error);
  const value = Number(json?.c);
  if (!(value > 0)) throw new QuoteError(`${symbol} 시세를 찾지 못했어요. 이 서비스가 ${symbol}를 지원하지 않을 수 있어요.`);
  const t = Number(json.t);
  const pc = Number(json.pc);
  const changePct = numOrNull(json.dp) ?? (pc > 0 ? (value / pc - 1) * 100 : null);
  return { value, asOf: t > 0 ? t * 1000 : null, changePct };
}

/** Twelve Data /quote 응답 → { value, asOf, changePct }. 오류도 HTTP 200 + status:"error" 로 올 수 있습니다. */
export function parseTwelveData(json, symbol = SYMBOL) {
  if (json?.status === 'error') throw new QuoteError(twelveDataMessage(json, symbol));
  const value = Number(json?.close);
  if (!(value > 0)) throw new QuoteError(`${symbol} 시세를 찾지 못했어요.`);
  const t = Number(json.last_quote_at ?? json.timestamp);
  return { value, asOf: t > 0 ? t * 1000 : null, changePct: numOrNull(json.percent_change) };
}

function twelveDataMessage(json, symbol) {
  if (json.code === 401) return 'API 키가 올바르지 않아요.';
  if (json.code === 429) return '호출 한도를 넘었어요. 잠시 후 다시 시도하세요.';
  if (json.code === 404 || json.code === 400) return `${symbol} 시세를 찾지 못했어요. 무료 요금제에서 지원하지 않을 수 있어요.`;
  return json.message || '시세를 가져오지 못했어요.';
}

/** CoinGecko /simple/price 응답 → { value, asOf, changePct(24시간) } */
export function parseCoinGecko(json) {
  const b = json?.bitcoin;
  const value = Number(b?.usd);
  if (!(value > 0)) throw new QuoteError('비트코인 가격을 찾지 못했어요.');
  const t = Number(b.last_updated_at);
  return { value, asOf: t > 0 ? t * 1000 : null, changePct: numOrNull(b.usd_24h_change) };
}

/** Coinbase Exchange /products/BTC-USD/stats 응답 → { value, asOf, changePct(24시간 시가 대비) } */
export function parseCoinbaseStats(json, now = Date.now()) {
  const value = Number(json?.last);
  if (!(value > 0)) throw new QuoteError('비트코인 가격을 찾지 못했어요.');
  const open = Number(json.open);
  return { value, asOf: now, changePct: open > 0 ? (value / open - 1) * 100 : null };
}

/** Frankfurter 응답 → { value, asOf, dateOnly }. date 는 고시 날짜(YYYY-MM-DD)입니다. */
export function parseFrankfurter(json) {
  const value = Number(json?.rates?.KRW);
  if (!(value > 0)) throw new QuoteError('환율 응답에 원화(KRW)가 없어요.');
  return { value, asOf: json.date ? Date.parse(`${json.date}T00:00:00Z`) : null, dateOnly: true };
}

/** ExchangeRate-API(open.er-api.com) 응답 → { value, asOf } */
export function parseErApi(json) {
  if (json?.result !== 'success') throw new QuoteError('환율을 가져오지 못했어요.');
  const value = Number(json?.rates?.KRW);
  if (!(value > 0)) throw new QuoteError('환율 응답에 원화(KRW)가 없어요.');
  const t = Number(json.time_last_update_unix);
  return { value, asOf: t > 0 ? t * 1000 : null };
}

/** 가져온 지 ttl 이 안 지났으면 true */
export function isFresh(entry, now, ttl = QUOTE_TTL_MS) {
  return !!entry && entry.value > 0 && Number.isFinite(entry.fetchedAt) && now - entry.fetchedAt >= 0 && now - entry.fetchedAt < ttl;
}

// ---------- 네트워크 ----------

async function getJSON(url, { fetchImpl, headers } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: ctrl?.signal, cache: 'no-store' });
  } catch (e) {
    // 서버가 CORS 헤더 없이 오류(503 등)를 보내도 브라우저에서는 네트워크 오류로만 보입니다.
    throw new QuoteError(e?.name === 'AbortError' ? '응답이 너무 늦어요.' : '서버에 연결하지 못했어요. 인터넷 연결이나 서비스 상태를 확인해 주세요.');
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (res.status === 401 || res.status === 403) throw new QuoteError('API 키가 올바르지 않거나 이 데이터에 접근할 권한이 없어요.');
  if (res.status === 429) throw new QuoteError('호출 한도를 넘었어요. 잠시 후 다시 시도하세요.');
  if (!res.ok) throw new QuoteError(`서버 오류 (${res.status})`);
  try {
    return await res.json();
  } catch {
    throw new QuoteError('응답을 읽을 수 없어요.');
  }
}

/** 미국 주식 하나(기본 MSTY)의 주가를 가져와 캐시용 항목으로 돌려줍니다. */
export async function fetchPrice({ provider, apiKey, symbol = SYMBOL, now = Date.now(), fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new QuoteError('API 키가 없어요.');
  const p = PRICE_PROVIDERS[provider];
  if (!p) throw new QuoteError('알 수 없는 시세 제공처예요.');
  let parsed;
  if (provider === 'finnhub') {
    // Finnhub 는 브라우저에서 키를 헤더로 보내는 것을 허용하지 않아(CORS) 주소에 붙여 보냅니다.
    const json = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${encodeURIComponent(apiKey)}`, { fetchImpl });
    parsed = parseFinnhub(json, symbol);
  } else {
    const json = await getJSON(`https://api.twelvedata.com/quote?symbol=${symbol}`, {
      fetchImpl,
      headers: { Authorization: `apikey ${apiKey}` },
    });
    parsed = parseTwelveData(json, symbol);
  }
  return { ...parsed, fetchedAt: now, source: p.label, sourceUrl: p.home };
}

// 비트코인: Finnhub 무료 요금제의 /quote 는 미국 주식 전용이라 키 없는 공개 API 를 씁니다.
const BTC_SOURCES = [
  {
    label: 'CoinGecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true',
    home: 'https://www.coingecko.com',
    parse: (json) => parseCoinGecko(json),
  },
  {
    label: 'Coinbase',
    url: 'https://api.exchange.coinbase.com/products/BTC-USD/stats',
    home: 'https://www.coinbase.com',
    parse: (json, now) => parseCoinbaseStats(json, now),
  },
];

/** 비트코인 달러 가격과 24시간 등락률. 첫 번째 출처가 실패하면 다음 출처를 시도합니다. */
export async function fetchBtc({ now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  let lastErr;
  for (const s of BTC_SOURCES) {
    try {
      const json = await getJSON(s.url, { fetchImpl });
      return { ...s.parse(json, now), fetchedAt: now, source: s.label, sourceUrl: s.home };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const FX_SOURCES = [
  { label: 'Frankfurter', url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW', home: 'https://frankfurter.dev', parse: parseFrankfurter },
  { label: 'ExchangeRate-API', url: 'https://open.er-api.com/v6/latest/USD', home: 'https://www.exchangerate-api.com', parse: parseErApi },
];

/** 원/달러 환율. 첫 번째 출처가 실패하면 다음 출처를 시도합니다. */
export async function fetchFx({ now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  let lastErr;
  for (const s of FX_SOURCES) {
    try {
      const json = await getJSON(s.url, { fetchImpl });
      return { ...s.parse(json), fetchedAt: now, source: s.label, sourceUrl: s.home };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * MSTY 주가·환율과 참고 시세(MSTR 주가, 비트코인 가격)를 함께 준비합니다.
 * - force 가 아니고 10분 안에 가져온 값이 있으면 다시 호출하지 않고 그 값을 씁니다.
 * - 가져오기에 실패하면 마지막으로 가져온 값(오래됐어도)을 돌려주고 error 에 이유를 담습니다.
 * - 항목마다 따로 처리하므로 하나가 실패해도 나머지는 영향을 받지 않습니다.
 *
 * 반환: { cache, price, fx, mstr, btc } — 각 항목은 { entry, status, error }
 *   status: 'fetched'(방금 가져옴) | 'cached'(10분 안 값 재사용) | 'stale'(실패, 예전 값) | 'failed'(실패, 값 없음) | 'nokey'
 */
export async function refreshQuotes({ cache = {}, provider, apiKey, force = false, now = Date.now(), fetchImpl = globalThis.fetch }) {
  const one = async (key, fetcher) => {
    const prev = cache[key];
    if (!force && isFresh(prev, now)) return { entry: prev, status: 'cached', error: null };
    try {
      return { entry: await fetcher(), status: 'fetched', error: null };
    } catch (e) {
      const error = e instanceof QuoteError ? e.message : '알 수 없는 오류가 났어요.';
      return { entry: prev?.value > 0 ? prev : null, status: prev?.value > 0 ? 'stale' : 'failed', error };
    }
  };

  const needsKey = (key, fetcher) =>
    apiKey ? one(key, fetcher) : Promise.resolve({ entry: cache[key]?.value > 0 ? cache[key] : null, status: 'nokey', error: null });

  const [price, fx, mstr, btc] = await Promise.all([
    needsKey('price', () => fetchPrice({ provider, apiKey, now, fetchImpl })),
    one('fx', () => fetchFx({ now, fetchImpl })),
    needsKey('mstr', () => fetchPrice({ provider, apiKey, symbol: 'MSTR', now, fetchImpl })),
    one('btc', () => fetchBtc({ now, fetchImpl })),
  ]);
  const results = { price, fx, mstr, btc };
  const newCache = {};
  for (const [k, r] of Object.entries(results)) if (r.entry) newCache[k] = r.entry;
  return { cache: newCache, ...results };
}

// ---------- 브라우저 저장 ----------

/** API 설정은 기록 데이터와 다른 칸에 저장해서 백업 JSON 파일에 섞이지 않게 합니다. */
export function loadApiConfig() {
  try {
    const v = JSON.parse(localStorage.getItem(API_KEY_STORAGE) || '{}');
    return { provider: PRICE_PROVIDERS[v.provider] ? v.provider : 'finnhub', apiKey: typeof v.apiKey === 'string' ? v.apiKey : '' };
  } catch {
    return { provider: 'finnhub', apiKey: '' };
  }
}

export function saveApiConfig(cfg) {
  try {
    localStorage.setItem(API_KEY_STORAGE, JSON.stringify({ provider: cfg.provider, apiKey: cfg.apiKey }));
    return true;
  } catch {
    return false;
  }
}

export function loadQuoteCache() {
  try {
    return JSON.parse(localStorage.getItem(QUOTE_CACHE_STORAGE) || '{}') || {};
  } catch {
    return {};
  }
}

export function saveQuoteCache(cache) {
  try {
    localStorage.setItem(QUOTE_CACHE_STORAGE, JSON.stringify(cache));
  } catch {}
}

export function clearQuoteCache() {
  try { localStorage.removeItem(QUOTE_CACHE_STORAGE); } catch {}
}
