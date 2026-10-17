// 서비스 워커(sw.js)의 BUILD 지문을 계산합니다. sw.js 안의 buildHash 와 똑같은 규칙이어야 합니다.
// - 파일마다 SHA-256 을 구하고(글자 파일은 줄바꿈을 LF 로 맞춘 뒤), "경로 해시" 줄들을 이어 붙여 다시 SHA-256, 앞 16글자.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEXT_EXT = /\.(html|css|js|mjs|webmanifest|svg|json|txt|md)$/i;
const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** sw.js 글에서 SHELL_FILES 목록을 읽음 */
export function readShellFiles(swText) {
  const m = swText.match(/const SHELL_FILES = \[([\s\S]*?)\];/);
  if (!m) throw new Error('sw.js 에서 SHELL_FILES 를 찾지 못했어요.');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** sw.js 글에서 지금 적혀 있는 BUILD 값을 읽음 */
export function readBuild(swText) {
  const m = swText.match(/const BUILD = '([0-9a-f]+)';/);
  if (!m) throw new Error('sw.js 에서 BUILD 를 찾지 못했어요.');
  return m[1];
}

/** 실제 파일들로 계산한 지문 */
export function computeBuildHash(root, files) {
  const lines = files.map((f) => {
    let buf = readFileSync(join(root, f));
    if (TEXT_EXT.test(f)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    return `${f} ${sha256Hex(buf)}`;
  });
  return sha256Hex(Buffer.from(lines.join('\n'), 'utf8')).slice(0, 16);
}
