# MSTY 재투자 기록장

MSTY 주간 분배금을 전부 재매수할 때, 보유 주수·평균 단가·총수익률을 기록하고
52주 뒤를 낙관/보통/비관 시나리오로 시뮬레이션하는 웹 앱입니다.
서버·로그인 없이 브라우저(localStorage)에만 저장됩니다. 현재 주가·환율은 무료 API에서 자동으로 가져올 수 있습니다(직접 입력도 가능).

## 실행

ES 모듈을 쓰기 때문에 `index.html`을 더블클릭(file://)하면 동작하지 않을 수 있어요. 간단한 로컬 서버로 여세요.

```bash
python -m http.server 8000
# 브라우저에서 http://localhost:8000
```

## 테스트

```bash
npm test          # 또는 node tests/run.js  (Node.js 18 이상)
```

Node가 없으면 로컬 서버를 켠 뒤 `http://localhost:8000/tests/` 를 열어도 같은 테스트가 실행됩니다.

## GitHub Pages 배포

저장소 Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `/ (root)`.
빌드 과정이 없어서 파일 그대로 올라갑니다.

## 시세 자동 가져오기

| 항목 | 제공처 | 키 | 무료 한도 | 데이터 시점 |
|---|---|---|---|---|
| 주가 (기본) | [Finnhub](https://finnhub.io) | 필요 (무료) | 분당 60회 | 미국 주식 실시간 (`/quote`) |
| 주가 (대안) | [Twelve Data](https://twelvedata.com) | 필요 (무료) | 분당 8회, 하루 800회 | 미국 주식 실시간 |
| 환율 (기본) | [Frankfurter](https://frankfurter.dev) | 불필요 | 할당량 없음(남용 방지 제한만) | 중앙은행 고시 환율, **하루 1번** |
| 환율 (예비) | [ExchangeRate-API](https://www.exchangerate-api.com) | 불필요 | 초과 시 20분 차단 | **하루 1번** |

- API 키는 설정 화면에서 입력하며, 이 브라우저의 localStorage(`msty-tracker-api`)에만 저장됩니다. 코드·저장소·백업 JSON 파일에는 들어가지 않습니다.
- 가져온 값은 10분 동안 재사용합니다. "새로고침" 버튼은 바로 다시 가져옵니다.
- 가져오기에 실패하면 칸에 있던 값(마지막으로 가져온 값이나 직접 입력한 값)을 그대로 씁니다.

## 파일 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 뼈대 (성적표 / 분배 기록 / 시뮬레이션 / 설정 탭) |
| `css/style.css` | 모양. 폰 우선, 다크 모드 지원 |
| `js/calc.js` | **계산 로직만** (보유 주수, 평균 단가, 수익률, 시뮬레이션). 화면과 분리되어 테스트 가능 |
| `js/quotes.js` | 주가·환율 API 호출, 10분 재사용, 실패 처리, API 키 저장 |
| `js/storage.js` | localStorage 저장, JSON 백업 내보내기·불러오기 |
| `js/chart.js` | 외부 라이브러리 없이 SVG 꺾은선 그래프 그리기 |
| `js/app.js` | 입력을 읽고 계산 결과를 화면에 표시 |
| `tests/` | 계산 로직 테스트 (터미널·브라우저 둘 다 실행 가능) |
