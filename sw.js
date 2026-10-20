// 서비스 워커: 인터넷이 없어도 앱이 열리게 하고, 다시 배포하면 파일 전체가 "한꺼번에" 새 버전으로 바뀌게 합니다.
//
// 왜 이렇게 하나요?
//   파일마다 따로 네트워크에서 받으면, 배포 직후 CDN(GitHub Pages 캐시 최대 10분)이나 일시적인 실패 때문에
//   새 app.js + 옛 index.html 처럼 버전이 섞여 실행될 수 있습니다. (실제로 그렇게 화면이 멈춘 적이 있음)
//
// 방식
// - BUILD 는 아래 SHELL_FILES 전체 내용으로 만든 지문(해시)입니다. `npm run stamp` 가 자동으로 적어 넣습니다.
//   파일을 고치면 지문이 바뀌고 → sw.js 내용이 바뀌므로 → 브라우저가 새 서비스 워커를 설치합니다.
// - 설치할 때 모든 파일을 `파일?v=BUILD` 주소로 새로 받아(CDN 의 옛 사본을 피함) 지문을 다시 계산하고,
//   BUILD 와 같을 때만 설치를 마칩니다. 다르면 설치를 취소하고, 그동안은 예전 버전 묶음을 그대로 씁니다.
// - 앱 파일은 항상 "지금 활성화된 버전의 저장본"에서만 꺼내 줍니다. 그래서 한 화면 안에서 버전이 섞이지 않습니다.
// - 새 버전이 활성화되면 앱(js/app.js)이 화면을 한 번 새로고침해 새 묶음으로 다시 엽니다.
// - 시세 API(다른 주소) 요청은 건드리지 않습니다. 오프라인이면 실패하고 앱이 마지막 값을 경고 표시와 함께 보여 줍니다.
// - 기록 데이터는 localStorage 에 있으므로 이 파일과 상관없이 그대로 남습니다.

const BUILD = '068261f72b32bb5a'; // npm run stamp 가 적어 넣는 값입니다. 직접 고치지 마세요.
const CACHE = `msty-shell-${BUILD}`;

// 앱 화면을 여는 데 필요한 파일 (sw.js 위치 기준 상대 경로). 파일을 추가하면 여기에도 넣고 npm run stamp.
const SHELL_FILES = [
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/calc.js',
  'js/storage.js',
  'js/chart.js',
  'js/quotes.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'fonts/passbook-title-extrabold.woff2',
  'fonts/passbook-print-regular.woff2',
  'fonts/passbook-print-bold.woff2',
];

// ---------- 지문 계산 (scripts/build-hash.mjs 와 똑같은 규칙) ----------
// 글자 파일은 줄바꿈을 LF 로 맞춘 뒤 계산합니다(윈도우에서 CRLF 로 받아도 같은 지문이 나오게).
const TEXT_EXT = /\.(html|css|js|mjs|webmanifest|svg|json|txt|md)$/i;

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildHash(files, buffers) {
  const lines = [];
  for (let i = 0; i < files.length; i++) {
    let bytes = new Uint8Array(buffers[i]);
    if (TEXT_EXT.test(files[i])) {
      bytes = new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/\r\n/g, '\n'));
    }
    lines.push(`${files[i]} ${await sha256Hex(bytes)}`);
  }
  return (await sha256Hex(new TextEncoder().encode(lines.join('\n')))).slice(0, 16);
}

// ---------- 설치: 전부 받아서 지문이 맞을 때만 ----------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const responses = await Promise.all(SHELL_FILES.map(async (f) => {
      // ?v=BUILD 를 붙이면 CDN 에 저장된 옛 사본 대신 서버의 현재 파일을 받습니다.
      const res = await fetch(`${f}?v=${BUILD}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${f} 받기 실패 (${res.status})`);
      return res;
    }));
    const buffers = await Promise.all(responses.map((r) => r.clone().arrayBuffer()));
    const got = await buildHash(SHELL_FILES, buffers);
    if (got !== BUILD) {
      // 서버에 아직 옛 파일과 새 파일이 섞여 있음 → 이번에는 설치하지 않고 다음 확인 때 다시 시도
      throw new Error(`파일 지문이 맞지 않아 업데이트를 미룹니다 (기대 ${BUILD}, 받은 ${got})`);
    }
    const cache = await caches.open(CACHE);
    const indexRes = responses[SHELL_FILES.indexOf('index.html')].clone();
    await Promise.all(responses.map((r, i) => cache.put(SHELL_FILES[i], r)));
    await cache.put('./', indexRes);
    await self.skipWaiting();
  })());
});

// ---------- 활성화: 예전 버전 저장본 정리 ----------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('msty-shell-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---------- 요청 처리 ----------
const scopePath = new URL(self.registration.scope).pathname; // 예: /msty-tracker/
const SHELL_SET = new Set(SHELL_FILES);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 같은 사이트의 GET 요청만 처리 (시세 API 등 다른 주소는 그대로 통과)
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(scopePath)) return;

  let key = url.pathname.slice(scopePath.length);
  if (key === '' && req.mode === 'navigate') key = 'index.html';
  if (SHELL_SET.has(key)) {
    event.respondWith(fromShell(key, req));
  } else if (req.mode === 'navigate') {
    // 앱 안의 다른 주소로 화면을 열면 앱 첫 화면을 보여 줌 (예: 테스트 페이지는 아래에서 네트워크로)
    event.respondWith(fetch(req).catch(() => fromShell('index.html', req)));
  }
  // 그 밖의 파일(tests/ 등)은 서비스 워커가 관여하지 않고 브라우저가 평소대로 받습니다.
});

/** 지금 활성화된 버전의 저장본에서만 꺼냅니다. 없으면(설치 전 등) 네트워크로. */
async function fromShell(key, req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    return new Response('오프라인이에요.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
