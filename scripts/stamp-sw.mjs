// 앱 파일을 고친 뒤 실행: npm run stamp
// sw.js 의 BUILD 지문을 지금 파일 내용에 맞게 다시 적습니다. 그래야 배포했을 때 설치한 앱이 새 버전을 알아챕니다.
// (잊고 커밋하면 npm test 가 실패해서 알려 줍니다.)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readShellFiles, readBuild, computeBuildHash } from './build-hash.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(ROOT, 'sw.js');
const sw = readFileSync(swPath, 'utf8');
const before = readBuild(sw);
const after = computeBuildHash(ROOT, readShellFiles(sw));

if (before === after) {
  console.log(`sw.js BUILD 그대로: ${after}`);
} else {
  writeFileSync(swPath, sw.replace(`const BUILD = '${before}';`, `const BUILD = '${after}';`));
  console.log(`sw.js BUILD 갱신: ${before} → ${after}`);
}
