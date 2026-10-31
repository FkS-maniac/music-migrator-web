// Spotify Web API — OAuth Authorization Code с PKCE (без client secret,
// безопасно для браузера) + обёртка эндпоинтов. Порт connectors/spotify.py.
//
// Пользователь создаёт СВОЁ приложение в Spotify Developer Dashboard
// (Development mode: 5 авторизованных пользователей, владелец — Premium),
// поэтому каждый работает в собственной квоте (~700 треков/сутки).

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

const SCOPES = [
  'user-library-read', 'user-library-modify',
  'playlist-read-private', 'playlist-modify-private', 'playlist-modify-public',
  'user-follow-read', 'user-follow-modify',
  'ugc-image-upload',
].join(' ');

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

export class SpotifyClient {
  constructor(clientId) {
    this.clientId = clientId;
    this.token = null;
    this.tokenExpires = 0;
  }

  get redirectUri() {
    return window.location.origin + window.location.pathname;
  }

  // ------------------------------------------------------------- OAuth PKCE

  async authorize() {
    // Возврат с кодом авторизации.
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      history.replaceState(null, '', window.location.pathname);
      await this._exchangeCode(code, sessionStorage.getItem('mm-pkce-verifier'));
      return true;
    }
    if (this._loadToken()) return true;
    return false;
  }

  async login() {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
    sessionStorage.setItem('mm-pkce-verifier', verifier);
    const challenge = base64url(await sha256(verifier));
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    window.location.href = `${AUTH_URL}?${params}`;
  }

  _loadToken() {
    try {
      const data = JSON.parse(localStorage.getItem('mm-spotify-token') || 'null');
      if (data && data.expiresAt > Date.now() + 60000) {
        this.token = data.token;
        this.tokenExpires = data.expiresAt;
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  async _exchangeCode(code, verifier) {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code, redirect_uri: this.redirectUri,
        client_id: this.clientId, code_verifier: verifier,
      }),
    });
    if (!resp.ok) throw new Error(`Spotify OAuth: ${resp.status}`);
    const payload = await resp.json();
    this.token = payload.access_token;
    this.tokenExpires = Date.now() + payload.expires_in * 1000;
    localStorage.setItem('mm-spotify-token', JSON.stringify({
      token: this.token, expiresAt: this.tokenExpires,
    }));
  }

  // ------------------------------------------------------------------- API

  async request(method, path, body) {
    if (Date.now() > this.tokenExpires - 60000) throw new Error('Spotify: токен истёк, переподключите аккаунт');
    const resp = await fetch(path.startsWith('http') ? path : API + path, {
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    // 429 — по правилам раздела 7: парсим Retry-After вручную.
    if (resp.status === 429) {
      const retryAfter = parseFloat(resp.headers.get('Retry-After'));
      throw new RateLimitError(isNaN(retryAfter) ? null : retryAfter, resp);
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError(`Spotify ${resp.status}: проблема доступа`);
    }
    if (resp.status === 400) {
      const text = await resp.text().catch(() => '');
      throw new BadRequestError(`Spotify 400: ${text.slice(0, 150)}`);
    }
    if (resp.status >= 500) throw new TransientError(`Spotify ${resp.status}`);
    if (resp.status === 204 || resp.headers.get('content-length') === '0') return null;
    return resp.json();
  }

  // -------------------------------------------------------------- источник

  static trackFromSpotify(item) {
    return {
      id: item.id,
      title: item.name || '',
      artists: (item.artists || []).map(a => a.name),
      album: (item.album || {}).name || '',
      durationMs: item.duration_ms || 0,
      isrc: (item.external_ids || {}).isrc || null,
      source: 'spotify',
    };
  }

  async *paginate(path, key, pageSize) {
    let url = `${API}${path}${path.includes('?') ? '&' : '?'}limit=${pageSize}`;
    while (url) {
      const payload = await this.request('GET', url);
      for (const item of payload[key] || []) yield item;
      url = payload.next;
    }
  }

  async fetchLibrary(categories) {
    const lib = { likes: [], playlists: [], albums: [], artists: [] };
    if (categories.has('likes')) {
      for await (const item of this.paginate('/me/tracks', 'items', 50)) {
        if (item.track) lib.likes.push(SpotifyClient.trackFromSpotify(item.track));
      }
    }
    if (categories.has('playlists')) {
      for await (const meta of this.paginate('/me/playlists', 'items', 50)) {
        if (!meta.id) continue;
        const tracks = [];
        for await (const t of this.paginate(`/playlists/${meta.id}/tracks`, 'items', 100)) {
          if (t.track && t.track.id) tracks.push(SpotifyClient.trackFromSpotify(t.track));
        }
        lib.playlists.push({
          id: meta.id, kind: meta.id,
          title: meta.name || '',
          description: meta.description || '',
          coverUrl: (meta.images || [{}])[0]?.url || null,
          tracks,
        });
      }
    }
    if (categories.has('albums')) {
      for await (const item of this.paginate('/me/albums', 'items', 20)) {
        if (!item.album) continue;
        lib.albums.push({
          id: item.album.id,
          title: item.album.name || '',
          artists: (item.album.artists || []).map(a => a.name),
          trackCount: item.album.total_tracks || 0,
        });
      }
    }
    if (categories.has('artists')) {
      let url = `${API}/me/following?type=artist&limit=50`;
      while (url) {
        const payload = await this.request('GET', url);
        for (const a of payload.artists.items || []) {
          lib.artists.push({ id: a.id, name: a.name });
        }
        const after = payload.artists.cursors?.after;
        url = after ? `${API}/me/following?type=artist&limit=50&after=${after}` : null;
      }
    }
    return lib;
  }

  // -------------------------------------------------------------- приёмник

  async searchTrack(query, limit = 10) {
    const payload = await this.request('GET',
      `/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`);
    return (payload.tracks.items || []).map(SpotifyClient.trackFromSpotify);
  }

  async me() { return this.request('GET', '/me'); }

  async createPlaylist(title, description) {
    const user = await this.me();
    const payload = await this.request('POST', `/users/${user.id}/playlists`, {
      name: title, description: description || '', public: false,
    });
    return payload.id;
  }

  async addTracksToPlaylist(playlistId, trackIds) {
    await this.request('POST', `/playlists/${playlistId}/tracks`,
      { uris: trackIds.map(id => `spotify:track:${id}`) }); // ≤ 100 за запрос
  }

  async saveTracksBatch(ids) { await this.request('PUT', '/me/tracks', { ids }); } // ≤ 50

  async saveAlbumsBatch(ids) { await this.request('PUT', '/me/albums', { ids }); } // ≤ 20

  async followArtistsBatch(ids) { await this.request('PUT', '/me/following?type=artist', { ids }); } // ≤ 50
}

export class RateLimitError extends Error {
  constructor(retryAfter, resp) {
    super(`429 rate limit (retry_after=${retryAfter})`);
    this.retryAfter = retryAfter;
  }
}
export class AuthError extends Error {}
export class BadRequestError extends Error {}
export class TransientError extends Error {}
