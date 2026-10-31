// Пайплайн переноса — порт musictransfer/pipeline.py (разделы 4, 6, 7 промта).
// Батчи, отметка выполнения только ПОСЛЕ подтверждения приёмником,
// обработка 429 по правилам раздела 7.1, отчёт.

import { bestMatch, searchQuery, normalizeTitle, artistsIntersect } from './matcher.js';

const MAX_INLINE_WAIT_SECONDS = 300;

// Раздельные лимиты пачек (раздел 7.2): один общий --chunk ломает альбомы.
export const CHUNKS = {
  like: 50,       // сохранение лайков
  pl: 100,        // добавление в плейлист
  album: 20,      // операции с альбомами
  artist: 50,     // подписки на артисты
};

export class RateLimitStop extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

async function handleRateLimit(err, state) {
  const retryAfter = err.retryAfter;
  if (retryAfter == null) {
    throw new RateLimitStop('429 без Retry-After: остановка, не ждём вслепую. Прогресс сохранён — продолжите позже.', null);
  }
  if (retryAfter > MAX_INLINE_WAIT_SECONDS) {
    const at = new Date(Date.now() + retryAfter * 1000).toLocaleTimeString();
    throw new RateLimitStop(`Суточная квота/долгое ожидание (${Math.round(retryAfter / 3600)} ч). Прогресс сохранён. Возвращайтесь после ${at}.`, retryAfter);
  }
  // ≤ 300 c: ждём с обратным отсчётом и продолжаем.
  await state.wait(retryAfter + 1, '429 rate limit');
}

export async function transferLibrary({ source, target, journal, options, state, report }) {
  const lib = await source.fetchLibrary(new Set(options.categories));
  const cats = new Set(options.categories);

  if (cats.has('likes')) {
    await transferChunked({
      items: lib.likes.map(t => [`like:${t.id}`, t]),
      chunkSize: CHUNKS.like,
      save: ids => target.saveTracksBatch(ids),
      target, journal, options, state, report, keyPrefix: 'like',
    });
  }
  if (cats.has('playlists')) {
    for (const playlist of lib.playlists) {
      await transferPlaylist({ playlist, target, journal, options, state, report });
    }
  }
  if (cats.has('albums')) await transferAlbums({ lib, target, journal, options, state, report });
  if (cats.has('artists')) await transferArtists({ lib, target, journal, options, state, report });
}

// --------------------------------------------------------------- лайки/треки

async function transferChunked({ items, chunkSize, save, target = null, journal, options, state, report, keyPrefix, skipMatch = false }) {
  let buffer = [], bufferKeys = [];

  const flush = async () => {
    if (!buffer.length || options.dryRun) { buffer = []; bufferKeys = []; return; }
    try {
      await save(buffer.map(t => t.id));
      // Отметка только ПОСЛЕ подтверждения приёмником (раздел 6.3).
      for (const k of bufferKeys) journal.markDone(k);
    } catch (err) {
      if (err.retryAfter !== undefined) await handleRateLimit(err, state);
      throw err;
    } finally {
      // Сброс пачки целиком при падении — без отметки (раздел 7.2).
      buffer = []; bufferKeys = [];
    }
  };

  for (const [key, track] of items) {
    if (state.aborted) throw new Error('Прервано пользователем');
    if (journal.isDone(key)) continue;

    if (!skipMatch) {
      state.tick(`Поиск: ${track.title}`);
      let candidates = [];
      try {
        candidates = await searchWithDelay(target, track, options, state);
      } catch (err) {
        if (err.retryAfter !== undefined) { await handleRateLimit(err, state); }
        else report.errors.push({ title: track.title, reason: String(err.message || err) });
        continue;
      }

      const match = bestMatch(track, candidates);
      if (!match.best) {
        report.notFound.push({ title: `${track.title} — ${track.artists.join(', ')}`, reason: match.reason });
        journal.markDone(key); // не возвращаемся к нему
        state.tick(`Не найдено: ${track.title}`);
        continue;
      }
      report.transferred.push(track.title);
      buffer.push(match.best);
    } else {
      // Внутри одного сервиса: трек уже есть, добавляем напрямую без поиска.
      report.transferred.push(track.title);
      buffer.push(track);
    }
    bufferKeys.push(key);
    if (buffer.length >= chunkSize) await flush();
  }
  await flush();
}

async function searchWithDelay(target, track, options, state) {
  const queries = [searchQuery(track)];
  if (options.strictSearch && track.artists[0]) queries.push(`${track.title} ${track.artists[0]}`);
  for (const q of queries) {
    await state.delay(options.searchDelayMs);
    const candidates = await target.searchTrack(q, 10);
    if (candidates.length) return candidates;
  }
  return [];
}

// ---------------------------------------------------------------- плейлисты

async function transferPlaylist({ playlist, target, journal, options, state, report }) {
  // kind → target id через журнал: повторный запуск без дублей (раздел 6.4).
  let targetId = journal.playlistFor(playlist.kind);
  if (!targetId) {
    if (options.dryRun) {
      targetId = 'dry-run';
    } else {
      state.tick(`Создание плейлиста: ${playlist.title}`);
      try { targetId = await target.createPlaylist(playlist.title, playlist.description); }
      catch (err) { if (err.retryAfter !== undefined) await handleRateLimit(err, state); throw err; }
    }
    journal.recordPlaylistMap(playlist.kind, targetId);
  }

  await transferChunked({
    items: playlist.tracks.map(t => [`pl:${playlist.kind}:${t.id}`, t]),
    chunkSize: CHUNKS.pl,
    save: ids => target.addTracksToPlaylist(targetId, ids),
    target, journal, options, state, report, keyPrefix: 'pl',
  });
}

// ------------------------------------------------------------------- альбомы

async function transferAlbums({ lib, target, journal, options, state, report }) {
  for (const album of lib.albums) {
    if (state.aborted) throw new Error('Прервано пользователем');
    const key = `album:${album.id}`;
    if (journal.isDone(key)) continue;
    state.tick(`Альбом: ${album.title}`);
    const query = `${album.title} ${album.artists.join(' ')}`.trim();
    let candidates = [];
    try {
      await state.delay(options.searchDelayMs);
      candidates = await target.searchTrack(query, 10);
    } catch (err) {
      if (err.retryAfter !== undefined) await handleRateLimit(err, state); else continue;
    }
    // Матчинг альбома: кандидат из того же альбома + те же артисты
    // (количество треков total_tracks ↔ track_count — сигнал против deluxe).
    const matched = candidates.find(c =>
      normalizeTitle(c.album) === normalizeTitle(album.title) &&
      artistsIntersect(album.artists, c.artists));
    if (!matched) {
      report.notFound.push({ title: `Альбом: ${album.title}`, reason: 'альбом не найден' });
      journal.markDone(key);
      continue;
    }
    if (!options.dryRun) {
      try { await target.saveAlbumsBatch([matched.albumId || matched.id]); }
      catch (err) { if (err.retryAfter !== undefined) await handleRateLimit(err, state); else continue; }
    }
    journal.markDone(key);
    report.transferred.push(`Альбом: ${album.title}`);
  }
}

// ------------------------------------------------------------------- артисты

async function transferArtists({ lib, target, journal, options, state, report }) {
  for (const artist of lib.artists) {
    if (state.aborted) throw new Error('Прервано пользователем');
    const key = `artist:${artist.id}`;
    if (journal.isDone(key)) continue;
    state.tick(`Артист: ${artist.name}`);
    let candidates = [];
    try {
      await state.delay(options.searchDelayMs);
      candidates = await target.searchTrack(artist.name, 1);
    } catch (err) {
      if (err.retryAfter !== undefined) await handleRateLimit(err, state); else continue;
    }
    if (!candidates.length) {
      report.notFound.push({ title: `Артист: ${artist.name}`, reason: 'не найден' });
      journal.markDone(key);
      continue;
    }
    if (!options.dryRun) {
      try { await target.followArtistsBatch([candidates[0].artists[0] ? candidates[0].id : candidates[0].id]); }
      catch (err) { if (err.retryAfter !== undefined) await handleRateLimit(err, state); else continue; }
    }
    journal.markDone(key);
    report.transferred.push(`Артист: ${artist.name}`);
  }
}

// --------------------------------------------- лайки → отдельный плейлист

export async function likesToPlaylist({ connector, journal, options, state, report, title }) {
  const lib = await connector.fetchLibrary(new Set(['likes']));
  let targetId = journal.playlistFor('likes');
  if (!targetId) {
    if (options.dryRun) targetId = 'dry-run';
    else {
      state.tick(`Создание плейлиста: ${title}`);
      targetId = await connector.createPlaylist(title, 'Перенесено из «Мне нравится» (music-migrator)');
    }
    journal.recordPlaylistMap('likes', targetId);
  }
  await transferChunked({
    items: lib.likes.map(t => [`like-pl:${t.id}`, t]),
    chunkSize: CHUNKS.pl,
    save: ids => connector.addTracksToPlaylist(targetId, ids),
    journal, options, state, report, keyPrefix: 'pl',
    skipMatch: true, // треки уже в этом сервисе — без поиска, экономия квоты
  });
}
