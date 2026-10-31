// Журнал прогресса в localStorage — порт musictransfer/journal.py (раздел 6).
// Append-only по смыслу: каждая запись сразу сохраняется (flush+fsync аналог).

const PREFIX = 'mm-journal:';

export class Journal {
  constructor(direction) {
    this.key = PREFIX + direction;
    this.done = new Set();
    this.playlistMap = {};   // source kind -> target id (без дублей плейлистов)
    this.coversDone = new Set();
    this._load();
  }

  _load() {
    try {
      const data = JSON.parse(localStorage.getItem(this.key) || '{}');
      this.done = new Set(data.done || []);
      this.playlistMap = data.playlistMap || {};
      this.coversDone = new Set(data.coversDone || []);
    } catch { /* повреждённый журнал — начинаем заново, не падаем */ }
  }

  _save() {
    const data = {
      done: [...this.done],
      playlistMap: this.playlistMap,
      coversDone: [...this.coversDone],
    };
    localStorage.setItem(this.key, JSON.stringify(data));
  }

  isDone(k) { return this.done.has(k); }
  doneCount() { return this.done.size; }
  markDone(k) { this.done.add(k); this._save(); }
  playlistFor(kind) { return this.playlistMap[kind]; }
  recordPlaylistMap(kind, targetId) { this.playlistMap[kind] = targetId; this._save(); }
  recordCover(targetId) { this.coversDone.add(targetId); this._save(); }
  reset() { this.done.clear(); this.playlistMap = {}; this.coversDone.clear(); this._save(); }
}
