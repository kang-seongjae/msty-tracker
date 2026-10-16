// 터미널에서 실행: node tests/run.js  (또는 npm test)
import { runAll } from './mini-test.js';
import './calc.test.js';

console.log('MSTY 계산 로직 테스트\n');
const { failed } = await runAll();
process.exit(failed ? 1 : 0);
