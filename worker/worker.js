// Cloudflare Worker — персональный CORS-прокси для неофициального API
// Яндекс Музыки (api.music.yandex.net не отдаёт CORS-заголовки).
//
// Развертывание (бесплатный тариф, ~30 секунд):
//   1. Зарегистрируйтесь на dash.cloudflare.com → Workers & Pages → Create worker
//   2. Вставьте этот код → Deploy
//   3. Скопируйте адрес вида https://music-proxy.username.workers.dev
//      и укажите его в настройках сайта («Адрес вашего прокси»)
//
// Безопасность: ваш OAuth-токен проходит ТОЛЬКО через ваш собственный
// Worker и никуда больше не сохраняется (раздел 8 промта).

const TARGET = 'https://api.music.yandex.net';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const incoming = new URL(request.url);
    const target = TARGET + incoming.pathname + incoming.search;

    const headers = { 'User-Agent': 'MusicTransfer/1.0 (browser)' };
    const auth = request.headers.get('Authorization');
    if (auth) headers['Authorization'] = auth;

    let body;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.text();
      if (request.headers.get('Content-Type')) {
        headers['Content-Type'] = request.headers.get('Content-Type');
      }
    }

    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
    });

    const respHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) respHeaders.set(k, v);
    // Retry-After должен быть виден браузеру (обработка 429, раздел 7.1).
    const retryAfter = upstream.headers.get('Retry-After');
    if (retryAfter) respHeaders.set('Retry-After', retryAfter);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    });
  },
};
