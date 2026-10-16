// 앱 설치(PWA) 설정 점검. 파일을 직접 읽으므로 터미널(node tests/run.js)에서만 실행합니다.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test, assertEqual, assert } from './mini-test.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const manifest = JSON.parse(read('manifest.webmanifest'));
const sw = read('sw.js');
const html = read('index.html');
const shellFiles = JSON.parse(
  sw.match(/const SHELL_FILES = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']')
);

/** PNG 파일 머리에서 가로·세로 크기를 읽음 */
function pngSize(p) {
  const b = readFileSync(join(ROOT, p));
  assertEqual(b.toString('latin1', 1, 4), 'PNG', `${p} 는 PNG 가 아님`);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
}

test('매니페스트: 앱 이름, 독립 화면, 상대 경로 시작 주소', () => {
  assertEqual(manifest.name, 'MSTY 기록장');
  assertEqual(manifest.display, 'standalone');
  // GitHub Pages 는 /msty-tracker/ 아래에 올라가므로 '/' 가 아니라 './' 여야 함
  assertEqual(manifest.start_url, './');
  assertEqual(manifest.scope, './');
});

test('매니페스트: 192·512 아이콘과 마스크용 아이콘이 실제 크기대로 있음', () => {
  for (const icon of manifest.icons) {
    assert(existsSync(join(ROOT, icon.src)), `${icon.src} 파일 없음`);
    assertEqual(pngSize(icon.src), icon.sizes, icon.src);
  }
  const has = (size, purpose) => manifest.icons.some((i) => i.sizes === size && i.purpose === purpose);
  assert(has('192x192', 'any') && has('512x512', 'any'), '설치용 기본 아이콘 필요');
  assert(has('512x512', 'maskable'), '마스크용 아이콘 필요');
  assertEqual(pngSize('icons/apple-touch-icon.png'), '180x180');
});

test('index.html 이 매니페스트를 연결하고 서비스 워커를 쓰는 앱 코드를 불러옴', () => {
  assert(html.includes('<link rel="manifest" href="manifest.webmanifest">'), '매니페스트 링크 없음');
  assert(read('js/app.js').includes("register('./sw.js')"), '서비스 워커 등록 없음');
});

test('오프라인용 저장 목록에 화면을 여는 데 필요한 파일이 모두 있고, 모두 실제로 존재함', () => {
  for (const f of shellFiles) if (f !== './') assert(existsSync(join(ROOT, f)), `${f} 파일 없음`);
  // index.html 이 불러오는 같은 사이트 파일
  const refs = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  // JS 파일끼리 import 하는 파일
  for (const js of shellFiles.filter((f) => f.endsWith('.js'))) {
    for (const m of read(js).matchAll(/from '\.\/([^']+)'/g)) refs.push(`js/${m[1]}`);
  }
  for (const r of refs) assert(shellFiles.includes(r), `오프라인 저장 목록에 ${r} 가 빠짐`);
});

test('서비스 워커는 시세 API(다른 주소)를 가로채지 않음', () => {
  assert(/url\.origin !== self\.location\.origin\) return/.test(sw), '다른 주소 요청은 통과시켜야 함');
});
