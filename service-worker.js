// デプロイのたびに、このバージョンを必ず更新すること。
// ブラウザはこのファイル自体のバイト列が変わったかどうかで
// 「新しいService Workerがあるか」を判定するため、index.html側の
// meta tagだけを変えても更新は検知されない。
const CACHE_VERSION = '20260926030000';
const CACHE_NAME = 'nagilog-' + CACHE_VERSION;
const CACHEABLE_ORIGINS = [
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com'
];
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js'
];

// インストール：新しいキャッシュを作って待機
// ここで skipWaiting() を呼ばないのが重要。呼んでしまうと、ユーザーが
// 「今すぐ反映」を押す前に新しいSWが勝手に有効化されてしまい、押した時点で
// reg.waiting が空になっていて何も起きない（＝ボタンが反応しないように見える）。
// 有効化は message イベントで SKIP_WAITING を受け取った時だけ行う。
self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] addAll 部分失敗:', err);
      });
    })()
  );
});

// アクティベート：旧キャッシュ削除・全クライアントを掌握
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k.startsWith('nagilog-') && k !== CACHE_NAME)
          .map(k => caches.delete(k))
      );
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(c => c.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }));
    })()
  );
});

// フェッチ：
// - ページ本体（index.html／ナビゲーション）は Stale While Revalidate。
//   キャッシュがあればまずそれを即座に返して起動を速くし、裏側で最新を
//   取りに行ってキャッシュを更新しておく（次回開いた時に反映される）。
//   「今すぐ反映」の更新モーダルは service-worker.js 自体のバイト列の
//   変化（CACHE_VERSION）で検知しているので、このキャッシュ戦略とは無関係に
//   毎回のデプロイで確実に届く。以前の Network First（毎回ネットワークを
//   待つ）は確実だが起動が遅くなるため、この方式に変更した。
// - それ以外の静的アセット（フォント読み込み用CDN等）は Cache First の
//   ままで、起動速度を優先する。
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (!url.protocol.startsWith('http')) return;
  // GET以外（アクセス解析のビーコンPOSTなど）と、自サイト・許可したCDN以外
  // （Googleアナリティクス、AdSense、天気API等）はService Workerを通さず、
  // ブラウザにそのまま任せる。キャッシュすると計測が二重・欠落したり広告が壊れる。
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin && !CACHEABLE_ORIGINS.includes(url.origin)) return;

  const isAppShell = req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname === '/';
  event.respondWith(isAppShell ? staleWhileRevalidate(req) : cacheFirst(req));
});

// Stale While Revalidate: キャッシュがあれば即返し、裏でネットワークから
// 取り直してキャッシュを更新する。キャッシュが無い時（初回訪問等）だけ
// ネットワークの応答を待つ。
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkFetch = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  if (cached) return cached;
  const response = await networkFetch;
  if (response) return response;
  return new Response('オフラインです', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

// Cache First: キャッシュを即返し、バックグラウンドで更新
async function cacheFirst(request) {
  const cached = await caches.match(request);
  // バックグラウンドで更新（待たない）
  fetch(request).then(response => {
    if (response && response.ok) {
      caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    }
  }).catch(() => {});
  // キャッシュがあれば即返す、なければネットから取得
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('オフラインです', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0]?.postMessage({ version: CACHE_VERSION });
  }
});
