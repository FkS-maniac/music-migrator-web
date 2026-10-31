import { SpotifyClient } from './spotify.js';
import { YandexPublicClient, parsePlaylistRef } from './yandex.js';
import { transferLibrary, RateLimitStop } from './transfer.js';
import { Journal } from './journal.js';

const $ = id => document.getElementById(id);

const state = {
  spotify: null,
  playlist: null,
  tracks: [],
  report: { transferred: [], notFound: [], errors: [] },
};

function setStatus(msg, ok = false) {
  $('#progress-status').textContent = msg;
  $('#progress-fill').style.width = ok ? '100%' : '0%';
}

function renderTrackList() {
  const lines = state.tracks.map(t => `${t.title} — ${t.artists.join(', ')}`);
  $('#track-list').value = lines.join('\n');
}

function renderMeta(ref) {
  const meta = $('#playlist-meta');
  if (!ref) {
    meta.classList.add('hidden');
    meta.textContent = '';
    return;
  }
  meta.classList.remove('hidden');
  meta.textContent = `Распознан: ${ref.owner} / ${ref.kind}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderReport() {
  const card = $('#report-card');
  const list = $('#report-list');
  const summary = $('#report-summary');

  card.classList.remove('hidden');
  summary.innerHTML = `
    <div class="stat"><b>${state.report.transferred.length}</b> перенесено</div>
    <div class="stat"><b>${state.report.notFound.length}</b> не найдено</div>
    <div class="stat"><b>${state.report.errors.length}</b> ошибки</div>
  `;

  list.innerHTML = [
    ...state.report.transferred.map(x => `<li>${escapeHtml(x)}</li>`),
    ...state.report.notFound.map(x => `<li class="warn">${escapeHtml(x.title)} — ${escapeHtml(x.reason)}</li>`),
    ...state.report.errors.map(x => `<li class="danger">${escapeHtml(x.title)} — ${escapeHtml(x.reason)}</li>`),
  ].join('');
}

async function ensureSpotify() {
  const clientId = $('#spotify-client-id').value.trim();
  if (!clientId) throw new Error('Введите Spotify Client ID');

  if (!state.spotify) {
    state.spotify = new SpotifyClient(clientId);
    if (!(await state.spotify.authorize())) {
      await state.spotify.login();
      return false;
    }
  }

  $('#spotify-status').textContent = 'подключён';
  $('#spotify-status').classList.add('ok');
  return true;
}

function initSpotifyRedirectHint() {
  $('#spotify-redirect-hint').textContent = `Redirect URI: ${window.location.origin + window.location.pathname}`;
}

async function parsePlaylist() {
  const raw = $('#yandex-link').value.trim();
  const proxy = $('#yandex-proxy').value.trim();
  if (!raw) throw new Error('Вставьте ссылку или iframe Яндекс Музыки');
  if (!proxy) throw new Error('Нужен proxy URL для чтения публичного плейлиста Яндекс Музыки');

  const ref = parsePlaylistRef(raw);
  if (!ref) throw new Error('Не удалось распознать ссылку/iframe. Используйте формат music.yandex.ru/users/.../playlists/3 или iframe src=.../playlist/...');

  const client = new YandexPublicClient(proxy);
  client.owner = ref.owner;
  client.kind = ref.kind;
  client.asPlaylist = $('#import-mode').checked;
  const lib = await client.fetchPlaylist(ref.owner, ref.kind, { asPlaylist: client.asPlaylist });
  const tracks = (lib.likes.length ? lib.likes : lib.playlists.flatMap(p => p.tracks || [])) || [];

  state.playlist = client;
  state.tracks = tracks.map(t => ({
    title: t.title || 'Без названия',
    artists: Array.isArray(t.artists) && t.artists.length ? t.artists : ['Неизвестно'],
  }));

  renderMeta(ref);
  renderTrackList();
  setStatus('Плейлист распознан и готов к импорту', true);
}

$('#spotify-connect').addEventListener('click', async () => {
  try {
    const ok = await ensureSpotify();
    if (!ok) return;
  } catch (err) {
    alert(err.message || err);
  }
});

$('#parse-btn').addEventListener('click', async () => {
  try {
    $('#progress-wrap').classList.remove('hidden');
    await parsePlaylist();
  } catch (err) {
    setStatus(err.message || String(err), false);
    alert(err.message || err);
  }
});

$('#download-txt').addEventListener('click', () => {
  if (!state.tracks.length) {
    alert('Сначала распознайте плейлист');
    return;
  }
  const text = state.tracks.map(t => `${t.title} — ${t.artists.join(', ')}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'yandex-playlist.txt';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import-spotify').addEventListener('click', async () => {
  try {
    $('#progress-wrap').classList.remove('hidden');
    if (!state.playlist) throw new Error('Сперва распознайте ссылку и соберите список');
    const ok = await ensureSpotify();
    if (!ok) return;

    const options = {
      categories: $('#import-mode').checked ? ['playlists'] : ['likes'],
      dryRun: false,
      strictSearch: false,
      searchDelayMs: 1000,
    };

    const progress = {
      aborted: false,
      processed: 0,
      total: 0,
      tick(msg) { setStatus(msg); },
      async delay(ms) { return new Promise(r => setTimeout(r, ms)); },
      async wait(seconds, reason) {
        const end = Date.now() + seconds * 1000;
        while (Date.now() < end) {
          setStatus(`${reason}: ждём ${Math.ceil((end - Date.now()) / 1000)}c…`);
          await new Promise(r => setTimeout(r, 1000));
        }
      },
    };

    const report = { transferred: [], notFound: [], errors: [] };
    const journal = new Journal('yandex-public-import');

    await transferLibrary({ source: state.playlist, target: state.spotify, journal, options, state: progress, report });
    state.report = report;
    renderReport();
    setStatus('Готово: импорт завершён', true);
  } catch (err) {
    if (err instanceof RateLimitStop) {
      setStatus('Остановлено: ' + err.message, false);
    } else {
      setStatus(err.message || String(err), false);
    }
    alert(err.message || err);
  }
});

initSpotifyRedirectHint();
setStatus('Готово', true);
