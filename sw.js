// 서비스 워커: 인터넷이 없어도 앱 화면이 열리게 하고, 다시 배포하면 새 버전으로 바뀌게 합니다.
//
// 전략: "네트워크 먼저, 안 되면 저장해 둔 파일"
// - 인터넷이 되면 항상 서버에서 최신 파일을 받아 화면에 쓰고, 받은 파일로 저장본도 갱신합니다.
//   그래서 코드를 고쳐 다시 배포하면 다음에 앱을 열 때 바로 새 버전이 나옵니다.
// - 인터넷이 없으면 마지막으로 저장해 둔 파일로 화면을 엽니다.
// - 시세 API(다른 주소) 요청은 건드리지 않습니다. 오프라인이면 실패하고,
//   앱이 마지막으로 가져온 값을 경고 표시와 함께 보여 줍니다.
// - 기록 데이터는 localStorage 에 있으므로 이 파일과 상관없이 그대로 남습니다.

// 이 파일이나 미리 저장할 파일 목록을 바꿀 때 숫자를 올리면 예전 저장본을 지웁니다.
const CACHE = 'msty-shell-v1';

// 앱 화면을 여는 데 필요한 파일 (sw.js 위치 기준 상대 경로)
const SHELL_FILES = [
  './',
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
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' 로 브라우저 HTTP 캐시를 거치지 않고 서버의 최신 파일을 받습니다.
      .then((cache) => cache.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' }))))
      // 새 버전이 오면 기다리지 않고 바로 교체
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('msty-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // 같은 사이트의 GET 요청만 처리 (시세 API 등 다른 주소는 그대로 통과)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    // no-cache: HTTP 캐시가 있어도 서버에 바뀌었는지 물어봄 (GitHub Pages 의 10분 캐시 때문에 옛 파일을 받지 않게)
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // 처음 보는 주소로 화면을 열면 앱 첫 화면을 대신 보여 줌
    if (req.mode === 'navigate') {
      const shell = (await cache.match('index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return new Response('오프라인이에요.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
