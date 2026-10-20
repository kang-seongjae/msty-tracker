// 서브셋용 글자 목록 만들기: index.html + js/*.js + css 의 모든 글자 + ASCII 출력 가능 문자 + 자주 쓰는 기호
// 사용법(저장소 맨 위에서): node fonts/make-charset.mjs <글자목록.txt>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const files = ['index.html', 'css/style.css', ...readdirSync('js').map((f) => `js/${f}`)];
const set = new Set();
for (const f of files) for (const ch of readFileSync(f, 'utf8')) set.add(ch);
for (let c = 0x20; c <= 0x7e; c++) set.add(String.fromCharCode(c));
for (const ch of '−·→₩↗⚠₿×÷…–—※△▽~%+') set.add(ch);
const text = [...set].filter((ch) => ch.codePointAt(0) >= 0x20).sort().join('');
writeFileSync(process.argv[2], text, 'utf8');
console.log(`글자 ${[...text].length}개`);
