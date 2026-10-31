import { SpotifyClient } from './spotify.js';
import { parsePlaylistRef } from './yandex.js';
import { download, parseImportFile } from './files.js';
import { Journal } from './journal.js';
import { transferLibrary, RateLimitStop } from './transfer.js';

const $ = id => document.getElementById(id);

let activeMode = 'yandex-import';
let importedTracks = [];
let loadedFile = null;
let spotify = null;

const reportState = { transferred: [], notFound: [], errors: [] };

function setActiveMode(mode) {
  activeMode = mode;
  document.querySelectorAll('.panel').forEach(panel => panel.classList.add('hidden'));
  if (mode === 'yandex-import') $('#yandex-import-panel').classList.remove('hidden');
  if (mode === 'file-import') $('#file-import-panel').classList.remove('hidden');
}

document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setActiveMode(btn.dataset.direction);
  });
});

function renderYandexMeta(text) {
  const meta = $('#yandex-meta');
  const ref = parsePlaylistRef(text);
  if (!ref) {
    meta.classList.add('hidden');
    meta.textContent = '';
    return;
  }
  meta.classList.remove('hidden');
  meta.textContent = `Распознан: ${ref.owner} / ${ref.kind}`;
}

function safeDownload(filename, content, type) {
  download(filename, content, type);
}

$('#make-file-btn').addEventListener('click', () => {
  const raw = $('#yandex-iframe').value.trim();
  if (!raw) {
    alert('Вставьте ссылку или iframe Яндекс Музыки');
    return;
  }

  const ref = parsePlaylistRef(raw);
  if (!ref) {
    alert('Не удалось распознать ссылку. Используйте формат music.yandex.ru/users/.../playlists/3 либо iframe src=.../playlist/...');
    return;
  }

  const payload = {
    source: 'yandex-public-playlist',
    owner: ref.owner,
    kind: ref.kind,
    raw,
    createdAt: new Date().toISOString(),
    tracks: [],
    notes: 'Список треков можно собрать вручную или через proxy/backend. Этот JSON нужен как файл-источник для дальнейшего импорта в Spotify.'
  };

  safeDownload('yandex-playlist-template.json', JSON.stringify(payload, null, 2), 'application/json');
  renderYandexMeta(raw);
});

$('#download-template-btn').addEventListener('click', () => {
  const sample = {
    source: 'yandex-public-playlist',
    owner: 'example_owner',
    kind: '12345',
    raw: 'https://music.yandex.ru/users/example_owner/playlists/12345',
    tracks: [
      { title: 'Трек 1', artist: 'Исполнитель 1' },
      { title: 'Трек 2', artist: 'Исполнитель 2' }
    ]
  };
  safeDownload('yandex-playlist-template.json', JSON.stringify(sample, null, 2), 'application/json');
});

$('#preview-file-btn').addEventListener('click', async () => {
  const file = $('#playlist-file').files[0];
  if (!file) {
    alert('Выберите файл');
    return;
  }

  const text = await file.text();
  loadedFile = file;
  $('#file-preview').value = text.slice(0, 4000);
});

$('#spotify-client-id').value = localStorage.getItem('mm-spotify-client-id') || '';
$('#spotify-redirect-hint').textContent = `Redirect URI: ${window.location.origin + window.location.pathname}`;

$('#spotify-client-id').addEventListener('input', e => localStorage.setItem('mm-spotify-client-id', e.target.value.trim()));

$('#spotify-connect').addEventListener('click', async () => {
  const clientId = $('#spotify-client-id').value.trim();
  if (!clientId) {
    alert('Введите Spotify Client ID');
    return;
  }

  spotify = new SpotifyClient(clientId);
  if (!(await spotify.authorize())) {
    await spotify.login();
    return;
  }

  $('#spotify-status').textContent = 'подключён';
  $('#spotify-status').classList.add('ok');
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

displayReport = () => {
  const reportCard = $('#report-card');
  reportCard.classList.remove('hidden');
  const summary = $('#report-summary');
  const list = $('#report-list');
  summary.innerHTML = `
    <div class="stat"><b>${reportState.transferred.length}</b> перенесено</div>
    <div class="stat"><b>${reportState.notFound.length}</b> не найдено</div>
    <div class="stat"><b>${reportState.errors.length}</b> ошибки</div>
  `;
  list.innerHTML = [
    ...reportState.transferred.map(x => `<li>${escapeHtml(x)}</li>`),
    ...reportState.notFound.map(x => `<li class="warn">${escapeHtml(x.title)} — ${escapeHtml(x.reason)}</li>`),
    ...reportState.errors.map(x => `<li class="danger">${escapeHtml(x.title)} — ${escapeHtml(x.reason)}</li>`),
  ].join('');
};

$('#import-spotify').addEventListener('click', async () => {
  try {
    if (!loadedFile) {
      alert('Сначала загрузите файл с плеером Яндекс Музыки');
      return;
    }

    const clientId = $('#spotify-client-id').value.trim();
    if (!clientId) {
      alert('Введите Client ID Spotify');
      return;
    }

    if (!spotify) {
      spotify = new SpotifyClient(clientId);
      if (!(await spotify.authorize())) {
        await spotify.login();
        return;
      }
    }

    const fileText = await loadedFile.text();
    const parsed = parseImportFile(fileText, loadedFile.name);

    const journal = new Journal('file-import');
    const progress = {
      aborted: false,
      processed: 0,
      total: parsed.likes.length,
      tick(msg) { $('#progress-status').textContent = msg; },
      async delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); },
      async wait(seconds, reason) {
        $('#progress-status').textContent = `${reason}: ждём ${seconds}s`;
        await new Promise(r => setTimeout(r, seconds * 1000));
      },
    };

    const target = spotify;
    const options = {
      categories: ['likes'],
      dryRun: false,
      strictSearch: false,
      searchDelayMs: 1000,
    };

    reportState.transferred = [];
    reportState.notFound = [];
    reportState.errors = [];

    $('#progress-wrap').classList.remove('hidden');
    $('#progress-status').textContent = 'Импорт...';
    $('#progress-fill').style.width = '10%';

    await transferLibrary({
      source: { fetchLibrary: async () => parsed },
      target,
      journal,
      options,
      state: progress,
      report: reportState,
    });

    $('#progress-fill').style.width = '100%';
    $('#progress-status').textContent = 'Готово';
    displayReport();
  } catch (err) {
    if (err instanceof RateLimitStop) {
      $('#progress-status').textContent = err.message;
    } else {
      $('#progress-status').textContent = err.message || String(err);
    }
    alert(err.message || err);
  }
});

setActiveMode('yandex-import');
