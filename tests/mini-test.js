// 아주 작은 테스트 도구. Node(터미널)와 브라우저(tests/index.html) 양쪽에서 똑같이 동작합니다.

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} 기대값 ${expected}, 실제값 ${actual}`.trim());
  }
}

export function assertClose(actual, expected, tolerance = 1e-9, msg = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${msg} 기대값 ${expected} (±${tolerance}), 실제값 ${actual}`.trim());
  }
}

export function assert(cond, msg = '조건이 거짓입니다') {
  if (!cond) throw new Error(msg);
}

/** 등록된 테스트를 모두 실행하고 { passed, failed, results } 를 돌려줍니다. */
export async function runAll(log = console.log) {
  const results = [];
  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
      log(`  ✔ ${t.name}`);
    } catch (e) {
      results.push({ name: t.name, ok: false, error: e.message });
      log(`  ✘ ${t.name}\n      → ${e.message}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  const passed = results.length - failed;
  log(`\n통과 ${passed}개, 실패 ${failed}개`);
  return { passed, failed, results };
}
