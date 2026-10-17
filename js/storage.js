// 데이터 저장/불러오기 담당. localStorage 와 JSON 파일 내보내기·불러오기를 처리합니다.

export const STORAGE_KEY = 'msty-tracker-v1';
export const SCENARIO_KEYS = ['optimistic', 'base', 'pessimistic'];

export function defaultState() {
  return {
    version: 1,
    settings: { initialShares: 0, initialAvgCost: 0, principalKRW: 0, initialUSD: 0 },
    records: [],
    market: { price: 0, fxRate: 0 },
    sim: {
      targetKRW: 0,
      fractional: false,
      scenarios: {
        optimistic: { dps: 0.3, priceChangePct: 10, fxRate: '' },
        base: { dps: 0.2, priceChangePct: -20, fxRate: '' },
        pessimistic: { dps: 0.1, priceChangePct: -50, fxRate: '' },
      },
    },
  };
}

const n = (v, fallback = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
};

/**
 * 불러온 데이터(예전 버전이거나 일부가 빠진 파일 포함)를 안전한 모양으로 맞춥니다.
 * 형식이 전혀 맞지 않으면 에러를 던집니다.
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('MSTY 기록 파일 형식이 아니에요.');
  }
  const d = defaultState();
  const s = raw.settings ?? {};
  const m = raw.market ?? {};
  const sim = raw.sim ?? {};
  const records = Array.isArray(raw.records) ? raw.records : [];

  return {
    version: 1,
    settings: {
      initialShares: n(s.initialShares),
      initialAvgCost: n(s.initialAvgCost),
      principalKRW: n(s.principalKRW),
      initialUSD: n(s.initialUSD), // 처음 환전해서 넣은 달러 (예전 데이터에는 없어서 0)
    },
    records: records
      .filter((r) => r && typeof r.date === 'string')
      .map((r, i) => ({
        id: typeof r.id === 'string' && r.id ? r.id : `r${Date.now().toString(36)}${i}`,
        date: r.date,
        dividendUSD: n(r.dividendUSD),
        sharesBought: n(r.sharesBought),
        price: n(r.price),
        fxRate: n(r.fxRate),
      })),
    market: { price: n(m.price), fxRate: n(m.fxRate) },
    sim: {
      targetKRW: n(sim.targetKRW),
      fractional: !!sim.fractional,
      scenarios: Object.fromEntries(
        SCENARIO_KEYS.map((k) => {
          const src = sim.scenarios?.[k] ?? {};
          const def = d.sim.scenarios[k];
          return [
            k,
            {
              dps: n(src.dps, def.dps),
              priceChangePct: n(src.priceChangePct, def.priceChangePct),
              fxRate: src.fxRate === '' || src.fxRate == null ? '' : n(src.fxRate),
            },
          ];
        })
      ),
    },
  };
}

export function loadState() {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? normalizeState(JSON.parse(text)) : defaultState();
  } catch {
    return defaultState();
  }
}

/** 저장에 성공하면 true. 사생활 보호 모드 등에서 실패하면 false. */
export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** 현재 데이터를 JSON 파일로 내려받게 합니다. */
export function exportState(state) {
  const blob = new Blob([JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `msty-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** 선택한 JSON 파일을 읽어 정리된 상태로 돌려줍니다. */
export async function importStateFile(file) {
  const text = await file.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('JSON 파일을 읽을 수 없어요.');
  }
  return normalizeState(raw);
}
