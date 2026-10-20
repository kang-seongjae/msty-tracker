# 글꼴

이 폴더의 `.woff2` 는 아래 원본 글꼴에서 앱에 쓰이는 글자만 남긴 **수정본(서브셋)** 입니다.
SIL Open Font License 1.1 의 예약 글꼴 이름(Reserved Font Name) 조항에 따라, 수정본에는 원래 이름(Nanum…)을 쓰지 않고
새 이름으로 바꿨습니다. 저작권·라이선스 표기(name 0, 13, 14)는 그대로 두었습니다. 원본 글꼴이 아닙니다.

| 앱에서 쓰는 파일 / 이름 | 원본 글꼴 | 저작권자 | 출처 | 라이선스 원문 |
|---|---|---|---|---|
| `passbook-title-extrabold.woff2` — "Passbook Title" ExtraBold (제목용) | NanumMyeongjo ExtraBold | Copyright (c) 2010, NHN Corporation | https://github.com/google/fonts/tree/main/ofl/nanummyeongjo | `LICENSE-NanumMyeongjo.txt` |
| `passbook-print-regular.woff2`, `passbook-print-bold.woff2` — "Passbook Print" Regular/Bold (통장 줄 숫자용) | NanumGothicCoding Regular/Bold | Copyright (c) 2010, NHN Corporation | https://github.com/google/fonts/tree/main/ofl/nanumgothiccoding | `LICENSE-NanumGothicCoding.txt` |

## 다시 만드는 법

1. 글자 목록: 저장소 맨 위에서 `node fonts/make-charset.mjs 글자목록.txt`
   (index.html, css, js/*.js 의 모든 글자 + ASCII 출력 가능 문자 + 기호)
2. 서브셋: `python -m fontTools.subset 원본.ttf --text-file=글자목록.txt --flavor=woff2 --output-file=fonts/<파일>.woff2 --layout-features='*'`
3. 이름 바꾸기: 글꼴 안의 이름(name 1–6)을 위 표의 새 이름으로 바꿉니다(fontTools).

앱 화면 글자를 새로 추가하면 1–3을 다시 하고 `npm run stamp` 를 실행하세요.
