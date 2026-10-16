# MSTY 재투자 기록장

MSTY 주간 분배금을 전부 재매수할 때, 보유 주수·평균 단가·총수익률을 기록하고
52주 뒤를 낙관/보통/비관 시나리오로 시뮬레이션하는 웹 앱입니다.
서버·로그인·외부 API 없이 브라우저(localStorage)에만 저장됩니다.

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

## 파일 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 화면 뼈대 (성적표 / 분배 기록 / 시뮬레이션 / 설정 탭) |
| `css/style.css` | 모양. 폰 우선, 다크 모드 지원 |
| `js/calc.js` | **계산 로직만** (보유 주수, 평균 단가, 수익률, 시뮬레이션). 화면과 분리되어 테스트 가능 |
| `js/storage.js` | localStorage 저장, JSON 백업 내보내기·불러오기 |
| `js/chart.js` | 외부 라이브러리 없이 SVG 꺾은선 그래프 그리기 |
| `js/app.js` | 입력을 읽고 계산 결과를 화면에 표시 |
| `tests/` | 계산 로직 테스트 (터미널·브라우저 둘 다 실행 가능) |
