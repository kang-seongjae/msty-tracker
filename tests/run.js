// 터미널에서 실행: node tests/run.js  (또는 npm test)
import { runAll } from './mini-test.js';
import './calc.test.js';
import './quotes.test.js';
import './pwa.test.js'; // 파일을 직접 읽는 점검이라 터미널에서만 실행

console.log('MSTY 계산·시세 로직 테스트\n');
const { failed } = await runAll();
process.exit(failed ? 1 : 0);
