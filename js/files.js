// Экспорт/импорт библиотеки в JSON/CSV — порт connectors/file.py.
// Импорт: простой формат [{artist, track}] или полный экспорт.

export function exportJson(lib) {
  return JSON.stringify({
    likes: (lib.likes || []).map(t => ({
      id: t.id, title: t.title, artists: t.artists,
      album: t.album, durationMs: t.durationMs, isrc: t.isrc,
    })),
    playlists: (lib.playlists || []).map(p => ({
      id: p.id, kind: p.kind, title: p.title, description: p.description,
      tracks: (p.tracks || []).map(t => ({ id: t.id, title: t.title, artists: t.artists })),
    })),
    albums: (lib.albums || []).map(a => ({
      id: a.id, title: a.title, artists: a.artists, trackCount: a.trackCount,
    })),
    artists: (lib.artists || []).map(a => ({ id: a.id, name: a.name })),
  }, null, 2);
}

export function exportCsv(tracks) {
  const rows = [['artist', 'track', 'album', 'year', 'duration_ms']];
  for (const t of tracks) {
    rows.push([t.artists.join(', '), t.title, t.album || '', t.year || '', t.durationMs || '']);
  }
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function parseImportFile(text, filename) {
  if (filename.endsWith('.csv')) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const likes = [];
    for (const line of lines.slice(1)) {
      const cells = parseCsvLine(line);
      const row = {};
      header.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
      likes.push({
        id: `file:${likes.length}`,
        title: row.track || row.title || '',
        artists: (row.artist || '').split(',').map(a => a.trim()).filter(Boolean),
        album: row.album || '', durationMs: parseInt(row.duration_ms) || 0,
        source: 'file',
      });
    }
    return { likes, playlists: [], albums: [], artists: [] };
  }
  // JSON: [{artist, track}] или полный экспорт
  const data = JSON.parse(text);
  if (Array.isArray(data)) {
    return {
      likes: data.map((item, i) => ({
        id: `file:${i}`,
        title: item.track || item.title || '',
        artists: String(item.artist || '').split(',').map(a => a.trim()).filter(Boolean),
        source: 'file',
      })),
      playlists: [], albums: [], artists: [],
    };
  }
  // Полный формат экспорта
  return {
    likes: (data.likes || []).map((t, i) => ({
      id: t.id || `file:${i}`, title: t.title || '',
      artists: t.artists || [], album: t.album || '',
      durationMs: t.durationMs || 0, isrc: t.isrc || null, source: 'file',
    })),
    playlists: (data.playlists || []).map(p => ({
      id: p.id || p.kind, kind: p.kind || p.id, title: p.title || '',
      description: p.description || '',
      tracks: (p.tracks || []).map((t, i) => ({
        id: t.id || `file:${i}`, title: t.title || '',
        artists: t.artists || [], source: 'file',
      })),
    })),
    albums: data.albums || [], artists: data.artists || [],
  };
}

function parseCsvLine(line) {
  const cells = [];
  let current = '', inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { cells.push(current); current = ''; continue; }
    current += ch;
  }
  cells.push(current);
  return cells;
}

export function download(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
