// Яндекс Музыка — неофициальный API (api.music.yandex.net).
// Порт connectors/yandex.py. Браузер напрямую обращаться не может (нет CORS),
// поэтому запросы идут через прокси пользователя (Cloudflare Worker из
// worker/worker.js — токен проходит только через ВАШ собственный прокси).
//
// Токен получается самостоятельно (см. README):
//  oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d

import { RateLimitError, AuthError, BadRequestError, TransientError } from './spotify.js';

const API = 'https://api.music.yandex.net';

export class YandexClient {
  constructor(token, proxyUrl) {
    this.token = token;
    this.proxyUrl = (proxyUrl || '').replace(/\/+$/, '');
    this._uid = null;
  }

  async request(method, path, body) {
    if (!this.proxyUrl) {
      throw new Error('Не задан адрес прокси для Яндекс Музыки (CORS). Инструкция — в README.');
    }
    const url = `${this.proxyUrl}${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': `OAuth ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (resp.status === 429) {
      const raw = resp.headers.get('Retry-After');
      const retryAfter = raw ? parseFloat(raw) : null;
      throw new RateLimitError(retryAfter);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError('Яндекс: токен недействителен или отозван');
    }
    if (resp.status === 400) {
      const text = await resp.text().catch(() => '');
      throw new BadRequestError(`Яндекс 400: ${text.slice(0, 150)}`);
    }
    if (resp.status >= 500) throw new TransientError(`Яндекс ${resp.status}`);
    return resp.json();
  }

  async uid() {
    if (!this._uid) {
      const status = await this.request('GET', '/account/status');
      this._uid = String(status?.account?.uid || '');
      if (!this._uid) throw new AuthError('Яндекс: не удалось получить uid аккаунта');
    }
    return this._uid;
  }

  // -------------------------------------------------------------- источник

  static trackFromYandex(item) {
    const albums = item.albums || [];
    return {
      id: String(item.id),
      title: item.title || '',
      artists: (item.artists || []).map(a => a.name),
      album: (albums[0] || {}).title || '',
      durationMs: item.durationMs || 0,
      isrc: null, // неофициальный API не отдаёт ISRC
      source: 'yandex',
    };
  }

  async fetchLibrary(categories) {
    const lib = { likes: [], playlists: [], albums: [], artists: [] };
    const uid = await this.uid();
    if (categories.has('likes')) {
      let page = 0;
      while (true) {
        const payload = await this.request('GET',
          `/users/${uid}/likes/tracks?page=${page}&page-size=100`);
        const library = payload.library || {};
        for (const t of library.tracks || []) lib.likes.push(YandexClient.trackFromYandex(t));
        const total = library.trackCount || 0;
        if ((page + 1) * 100 >= total) break;
        page++;
      }
    }
    if (categories.has('playlists')) {
      const payload = await this.request('GET', `/users/${uid}/playlists/list`);
      for (const pl of payload.result || []) {
        if (!pl.kind) continue;
        const detail = await this.request('GET', `/users/${uid}/playlists/${pl.kind}`);
        const tracks = (detail.result?.tracks || []).map(t =>
          t && t.track ? YandexClient.trackFromYandex(t.track) : YandexClient.trackFromYandex(t));
        lib.playlists.push({
          id: String(pl.kind), kind: String(pl.kind),
          title: pl.title || '',
          description: pl.description || '',
          coverUrl: pl.cover?.items?.[0]?.url || null,
          tracks: tracks.filter(t => t.id),
        });
      }
    }
    if (categories.has('albums')) {
      const payload = await this.request('GET', `/users/${uid}/likes/albums`);
      for (const a of payload.result || []) {
        lib.albums.push({
          id: String(a.id),
          title: a.title || '',
          artists: (a.artists || []).map(x => x.name),
          trackCount: a.trackCount || 0,
        });
      }
    }
    if (categories.has('artists')) {
      const payload = await this.request('GET', `/users/${uid}/likes/artists`);
      for (const a of payload.result || []) {
        lib.artists.push({ id: String(a.artist.id), name: a.artist.name || '' });
      }
    }
    return lib;
  }

  // -------------------------------------------------------------- приёмник

  async searchTrack(query, limit = 10) {
    const payload = await this.request('GET',
      `/search?type=track&page=0&text=${encodeURIComponent(query)}`);
    const items = payload.result?.tracks?.items || [];
    return items.slice(0, limit).map(YandexClient.trackFromYandex);
  }

  async createPlaylist(title, description) {
    const uid = await this.uid();
    const payload = await this.request('POST', `/users/${uid}/playlists/create`, {
      title, description: description || '', visibility: 'private',
    });
    return String(payload.result?.kind ?? payload.result?.id ?? '');
  }

  async addTracksToPlaylist(playlistId, trackIds) {
    const uid = await this.uid();
    const detail = await this.request('GET', `/users/${uid}/playlists/${playlistId}`);
    const revision = detail.result?.revision || 0;
    const diff = trackIds.map((tid, i) => ({ op: 'insert', at: i, tid: parseInt(tid, 10) }));
    await this.request('POST', `/users/${uid}/playlists/${playlistId}/change`,
      { revision, diff });
  }

  async saveTracksBatch(ids) {
    const uid = await this.uid();
    await this.request('POST', `/users/${uid}/likes/tracks/add`,
      { 'track-ids': ids.map(id => parseInt(id, 10)) });
  }

  async saveAlbumsBatch(ids) {
    const uid = await this.uid();
    await this.request('POST', `/users/${uid}/likes/albums/add`,
      { 'album-ids': ids.map(id => parseInt(id, 10)) });
  }

  async followArtistsBatch(ids) {
    const uid = await this.uid();
    await this.request('POST', `/users/${uid}/likes/artists/add`,
      { 'artist-ids': ids.map(id => parseInt(id, 10)) });
  }
}
