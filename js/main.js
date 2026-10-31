// main.js — UI: вкладки направлений, подключение аккаунтов, запуск переноса.
// Порт логики musictransfer/cli.py в браузер.

import { SpotifyClient } from './spotify.js';
import { YandexClient, YandexPublicClient, parsePlaylistRef, formatPlaylistRef, normalizeTrackArtistLine } from './yandex.js';
import { Journal } from './journal.js';
import { transferLibrary, likesToPlaylist, RateLimitStop } from './transfer.js';
import { exportJson, exportCsv, parseImportFile, download } from './files.js';

const $ = id => document.getElementById(id);

// ------------------------------------------------------------------ state

const state = {
  aborted: false,
  processed: 0, total: 0,
  async tick(msg) {
    $('progress-status').textContent = msg;
    $('progress-counters').textContent =
      `перенесено: ${report.transferred.length} · не найдено: ${report.notFound.length} · ошибки: ${report.errors.length}`;
    const pct = this.total ? Math.round((this.processed / this.total) * 100) : 0;
    $('progress-fill').style.width = pct + '%';
  },
  delay(ms) {
    if (state.aborted) throw new Error('Прервано пользователем');
    return new Promise(resolve => setTimeout(resolve, ms));
  },
  async wait(seconds, reason) {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      if (state.aborted) throw new Error('Прервано пользователем');
      const left = Math.ceil((until - Date.now()) / 1000);
      $('progress-status').textContent = `${reason}: ждём ${left} с…`;
      await new Promise(r => setTimeout(r, 1000));
    }
  },
};

const report = { transferred: [], notFound: [], errors: [] };

let direction = 'yandex-to-spotify';
let spotify = null, yandex = null;
let importFileData = null;

const NEEDS = {
  'yandex-to-spotify': { source: 'yandex', target: 'spotify' },
  'spotify-to-yandex': { source: 'spotify', target: 'yandex' },
  'likes-to-playlist': { connector: 'both' },
  'export': { source: 'both' },
  'import': { source: 'file', target: 'both' },
};

// ------------------------------------------------------------ persistence

const store = {
  get spotifyClientId() { return localStorage.getItem('mm-spotify-client-id') || ''; },
  set spotifyClientId(v) { localStorage.setItem('mm-spotify-client-id', v); },
  get yandexToken() { return localStorage.getItem('mm-yandex-token') || ''; },
  set yandexToken(v) { localStorage.setItem('mm-yandex-token', v); },
  get yandexProxy() { return localStorage.getItem('mm-yandex-proxy') || ''; },
  set yandexProxy(v) { localStorage.setItem('mm-yandex-proxy', v); },
  get yandexPublicLink() { return localStorage.getItem('mm-yandex-public-link') || ''; },
  set yandexPublicLink(v) { localStorage.setItem('mm-yandex-public-link', v); },
};

function renderPublicPlaylistPreview() {
  const preview = $('yandex-public-link-preview');
  const raw = store.yandexPublicLink.trim();
  if (!raw) {
    preview.classList.add('hidden');
    preview.innerHTML = '';
    return;
  }
  const ref = parsePlaylistRef(raw);
  if (!ref) {
    preview.classList.remove('hidden');
    preview.innerHTML = '<span class="preview-warning">Не удалось распознать публичный плейлист. Вставьте ссылку или iframe Яндекс Музыки.</span>';
    return;
  }

  const formatted = formatPlaylistRef(ref);
  const demo = normalizeTrackArtistLine('На заре — Мельница');
  preview.classList.remove('hidden');
  preview.innerHTML = `
    <strong>Распознан:</strong> ${escapeHtml(ref.owner)} / ${escapeHtml(ref.kind)}
    <span class="preview-muted">Формат: ${escapeHtml(formatted)}</span>
    <span class="preview-muted">Подготовка к дальнейшей нормализации: ${escapeHtml(demo ? `${demo.title} — ${demo.artist}` : 'Трек — Исполнитель')}</span>
  `;
}

// ------------------------------------------------------------------- init

$('spotify-client-id').value = store.spotifyClientId;
$('yandex-token').value = store.yandexToken;
$('yandex-proxy').value = store.yandexProxy;
$('yandex-public-link').value = store.yandexPublicLink;
renderPublicPlaylistPreview();
$('spotify-redirect-hint').textContent =
  `Redirect URI для Dashboard: ${window.location.origin + window.location.pathname}`;

$('spotify-client-id').addEventListener('input', e => { store.spotifyClientId = e.target.value.trim(); });
$('yandex-token').addEventListener('input', e => { store.yandexToken = e.target.value.trim(); });
$('yandex-proxy').addEventListener('input', e => { store.yandexProxy = e.target.value.trim(); });
$('yandex-public-link').addEventListener('input', e => {
  store.yandexPublicLink = e.target.value.trim();
  renderPublicPlaylistPreview();
});

(async () => {
  const clientId = store.spotifyClientId;
  if (clientId) {
    spotify = new SpotifyClient(clientId);
    if (await spotify.authorize()) {
      $('spotify-status').textContent = 'подключён';
      $('spotify-status').classList.add('ok');
    }
  }
})();

// ------------------------------------------------------------------- tabs

document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    direction = btn.dataset.direction;
    updateUiForDirection();
  });
});

function updateUiForDirection() {
  $('playlist-title-row').classList.toggle('hidden', direction !== 'likes-to-playlist');
  $('file-input-row').classList.toggle('hidden', direction !== 'import');
  $('journal-info').textContent = `Журнал «${direction}»: ${new Journal(direction).doneCount()} выполнено`;
}

// ---------------------------------------------------------- connect buttons

$('spotify-connect').addEventListener('click', async () => {
  const clientId = store.spotifyClientId;
  if (!clientId) {
    alert('Вставьте Client ID из Spotify Developer Dashboard (инструкция в README).');
    return;
  }
  spotify = new SpotifyClient(clientId);
  if (!(await spotify.authorize())) await spotify.login();
  else {
    $('spotify-status').textContent = 'подключён';
    $('spotify-status').classList.add('ok');
  }
});

$('yandex-connect').addEventListener('click', async () => {
  const token = store.yandexToken, proxy = store.yandexProxy;
  if (!token || !proxy) {
    alert('Нужны токен Яндекса и адрес прокси (Cloudflare Worker). Инструкция — в README.');
    return;
  }
  yandex = new YandexClient(token, proxy);
  try {
    await yandex.uid();
    $('yandex-status').textContent = 'подключён';
    $('yandex-status').classList.add('ok');
  } catch (err) {
    $('yandex-status').textContent = 'ошибка подключения';
    alert('Яндекс: ' + (err.message || err));
  }
});

// ------------------------------------------------------------------- run

$('run-btn').addEventListener('click', runTransfer);
$('abort-btn').addEventListener('click', () => { state.aborted = true; });
$('reset-journal-btn').addEventListener('click', () => {
  if (!confirm('Сбросить прогресс этой вкладки? Повторный запуск начнёт с нуля.')) return;
  new Journal(direction).reset();
  updateUiForDirection();
});

$('import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) { importFileData = null; return; }
  importFileData = parseImportFile(await file.text(), file.name);
  $('progress-status').textContent =
    `Файл загружен: ${importFileData.likes.length} треков, ${importFileData.playlists.length} плейлистов`;
});

$('download-report').addEventListener('click', () => {
  download(`music-migrator-report-${direction}.json`, JSON.stringify({
    direction, date: new Date().toISOString(), ...report,
  }, null, 2), 'application/json');
});
$('download-notfound').addEventListener('click', () => {
  const rows = [['artist', 'track', 'reason']];
  for (const nf of report.notFound) {
    const [title, artist] = nf.title.split(' — ');
    rows.push([artist || '', title || '', nf.reason]);
  }
  download('not-found.csv', rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n'), 'text/csv');
});

async function runTransfer() {
  state.aborted = false;
  report.transferred = []; report.notFound = []; report.errors = [];
  state.processed = 0; state.total = 0;
  $('report-card').classList.add('hidden');
  $('abort-btn').classList.remove('hidden');
  $('run-btn').disabled = true;

  const options = {
    categories: [...document.querySelectorAll('#categories input:checked')].map(c => c.value),
    dryRun: $('dry-run').checked,
    strictSearch: $('strict-search').checked,
    searchDelayMs: parseFloat($('search-delay').value) * 1000,
  };

  const journal = new Journal(direction);
  const showProgress = () => $('progress-wrap').classList.remove('hidden');
  showProgress();
  state.tick('Подготовка…');

  try {
    if (direction === 'export') {
      await runExport(options);
    } else if (direction === 'import') {
      await runImport(options, journal);
    } else if (direction === 'likes-to-playlist') {
      const svc = confirm('OK = Spotify, Отмена = Яндекс Музыка. Где создаём плейлист?');
      const connector = svc ? spotify : yandex;
      if (!connector) throw new Error('Сначала подключите аккаунт (шаг 1).');
      if (svc) await ensureSpotify();
      await likesToPlaylist({
        connector, journal, options, state, report,
        title: $('playlist-title').value || 'My Liked Songs',
      });
    } else {
      const { source: srcKey, target: tgtKey } = NEEDS[direction];
      if (srcKey === 'yandex') {
        const link = parsePlaylistRef(store.yandexPublicLink);
        if (link) {
          if (!store.yandexProxy) {
            throw new Error('Публичный плейлист распознан, но для чтения треков нужен ваш Cloudflare Worker или аналогичный proxy.');
          }
          if (!spotify && !store.spotifyClientId) throw new Error('Подключите Spotify (шаг 1).');
          await ensureSpotify();
          const pub = new YandexPublicClient(store.yandexProxy);
          pub.owner = link.owner; pub.kind = link.kind;
          pub.asPlaylist = confirm('OK = перенести как отдельный плейлист в Spotify,\nОтмена = добавить в «Любимые треки» Spotify');
          options.categories = pub.asPlaylist ? ['playlists'] : ['likes'];
          await transferLibrary({ source: pub, target: spotify, journal, options, state, report });
        } else {
          if (!yandex) throw new Error('Вставьте ссылку/iframe публичного плейлиста или подключите Яндекс токеном (шаг 1).');
          if (!spotify) throw new Error('Подключите Spotify (шаг 1).');
          await ensureSpotify();
          await transferLibrary({ source: yandex, target: spotify, journal, options, state, report });
        }
      } else {
        if (!yandex) throw new Error('Подключите Яндекс токеном (шаг 1) — приёмник требует записи.');
        if (!spotify) throw new Error('Подключите Spotify (шаг 1).');
        await ensureSpotify();
        await transferLibrary({ source: spotify, target: yandex, journal, options, state, report });
      }
    }
    finishRun('Готово');
  } catch (err) {
    if (err instanceof RateLimitStop) {
      finishRun('Остановлено: ' + err.message, true);
    } else if (state.aborted || /Прервано/.test(String(err.message))) {
      finishRun('Остановлено пользователем — прогресс сохранён, можно продолжить позже.', true);
    } else {
      finishRun('Ошибка: ' + (err.message || err), true);
    }
  }
}

async function ensureSpotify() {
  if (spotify && spotify.token) return;
  const clientId = store.spotifyClientId;
  if (!clientId) throw new Error('Вставьте Spotify Client ID (шаг 1).');
  spotify = new SpotifyClient(clientId);
  if (!(await spotify.authorize())) await spotify.login();
}

async function runExport(options) {
  const useSpotify = confirm('OK = экспорт из Spotify, Отмена = из Яндекс Музыки');
  let lib;
  if (useSpotify) {
    await ensureSpotify();
    state.tick('Чтение библиотеки Spotify…');
    lib = await spotify.fetchLibrary(new Set(options.categories));
  } else {
    const link = parsePlaylistRef(store.yandexPublicLink);
    if (link) {
      if (!store.yandexProxy) throw new Error('Для чтения публичного плейлиста нужен Cloudflare Worker или аналогичный proxy.');
      const pub = new YandexPublicClient(store.yandexProxy);
      pub.owner = link.owner; pub.kind = link.kind;
      state.tick('Чтение публичного плейлиста…');
      lib = await pub.fetchPlaylist(link.owner, link.kind, { asPlaylist: true });
    } else {
      if (!yandex) throw new Error('Вставьте ссылку/iframe публичного плейлиста или подключите Яндекс токеном (шаг 1).');
      state.tick('Чтение библиотеки Яндекса…');
      lib = await yandex.fetchLibrary(new Set(options.categories));
    }
  }
  const allTracks = lib.likes.length ? lib.likes : lib.playlists.flatMap(p => p.tracks);
  state.tick(`Экспорт: ${allTracks.length} треков, ${lib.playlists.length} плейлистов…`);
  const json = confirm('OK = JSON (полный), Отмена = CSV (только треки)');
  if (json) download('library-export.json', exportJson(lib), 'application/json');
  else download('library-export.csv', exportCsv(allTracks), 'text/csv');
}

async function runImport(options, journal) {
  if (!importFileData) throw new Error('Выберите файл библиотеки (шаг 2).');
  const useSpotify = confirm('OK = импорт в Spotify, Отмена = в Яндекс Музыку');
  const target = useSpotify ? spotify : yandex;
  if (!target) throw new Error('Сначала подключите аккаунт-приёмник (шаг 1).');
  if (useSpotify) await ensureSpotify();
  state.total = importFileData.likes.length;
  await transferLibrary({
    source: new FileSource(importFileData), target, journal, options, state, report,
  });
}

class FileSource {
  constructor(lib) { this.lib = lib; }
  async fetchLibrary() { return this.lib; }
}

function finishRun(message, warn = false) {
  state.tick(message);
  $('progress-status').style.color = warn ? '#e74c3c' : '';
  $('abort-btn').classList.add('hidden');
  $('run-btn').disabled = false;
  $('journal-info').textContent =
    `Журнал «${direction}»: ${new Journal(direction).doneCount()} выполнено`;
  renderReport();
}

function renderReport() {
  $('report-card').classList.remove('hidden');
  $('report-summary').innerHTML = `
    <div class="stat"><b style="color:var(--accent)">${report.transferred.length}</b>перенесено</div>
    <div class="stat"><b style="color:var(--accent-2)">${report.notFound.length}</b>не найдено</div>
    <div class="stat"><b style="color:var(--danger)">${report.errors.length}</b>ошибочные</div>`;
  $('notfound-count').textContent = report.notFound.length;
  $('errors-count').textContent = report.errors.length;
  $('notfound-list').innerHTML = report.notFound
    .map(nf => `<li>${escapeHtml(nf.title)} <i>(${escapeHtml(nf.reason)})</i></li>`).join('');
  $('errors-list').innerHTML = report.errors
    .map(e => `<li>${escapeHtml(e.title)} → ${escapeHtml(e.reason)}</li>`).join('');
}

const HTML_ESCAPES = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: '#39' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch =>
    '&' + HTML_ESCAPES[ch.charCodeAt(0)] + ';');
}

updateUiForDirection();
