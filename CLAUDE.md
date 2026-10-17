# CLAUDE.md

## 앱 파일을 고치면 커밋 전에 `npm run stamp`

- `sw.js`의 `SHELL_FILES`에 있는 파일(`index.html`, `manifest.webmanifest`, `css/`, `js/`, `icons/`)을 하나라도 고쳤다면, **커밋 전에 반드시 `npm run stamp`** 를 실행한다.
  - `sw.js`의 `BUILD` 지문을 지금 파일 내용에 맞게 다시 적는다. `BUILD`는 직접 고치지 않는다.
  - 이걸 빠뜨리면 배포해도 설치한 앱이 새 버전을 알아채지 못하거나, 서비스 워커가 지문 불일치로 설치를 거부한다.
- 새 앱 파일을 추가하면 `sw.js`의 `SHELL_FILES`에도 넣은 뒤 `npm run stamp`.
- 순서: 파일 수정 → `npm run stamp` → `npm test`(지문이 낡았으면 실패함) → 커밋.
- 이유: 옛 `index.html`과 새 `app.js`가 섞여 실행돼 화면이 멈춘 적이 있다. 지금은 파일 묶음 전체의 지문이 맞을 때만 새 버전을 설치해서 한꺼번에 바뀌게 한다. 자세한 내용은 `sw.js` 맨 위 주석과 README의 "앱으로 설치 (PWA)"를 본다.
