// Портированный из musictransfer/normalize.py + matcher.py (раздел 5 промта).
// Скоринговый матчинг: караоке/трибьюты отвергаются порогом ≥ 2 баллов.

export const DURATION_TOLERANCE_MS = 3000; // ±3 секунды
export const SCORE_THRESHOLD = 2;

const BRACKET_NOISE = /[\(\[\{](?:feat\.?|ft\.?|featuring|with|w\/|remaster(?:ed)?(?:\s+\d{4})?|re-?mastered|radio\s+edit|single\s+version|album\s+version|mono|stereo|deluxe|bonus|explicit|clean|live|bonus\s+track|instrumental|acoustic|karaoke|tribute(?:\s+to)?|cover|original|extended|mix)[^\)\]\}]*[\)\]\}]/gi;

function stripAccents(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeText(value) {
  if (!value) return '';
  let v = value.replace(BRACKET_NOISE, ' ');
  v = v.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  v = stripAccents(v);
  return v.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function normalizeTitle(title) { return normalizeText(title); }
export function normalizeArtist(artist) { return normalizeText(artist); }

export function artistMatches(a, b) {
  const na = normalizeArtist(a), nb = normalizeArtist(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= 3) return longer.includes(shorter);
  return false;
}

export function artistsIntersect(a, b) {
  return a.some(x => b.some(y => artistMatches(x, y)));
}

export function searchQuery(track) {
  return `${track.title} ${track.artists.join(' ')}`.trim();
}

export function scoreCandidate(track, candidate) {
  let score = 0;
  if (track.durationMs && candidate.durationMs) {
    if (Math.abs(track.durationMs - candidate.durationMs) <= DURATION_TOLERANCE_MS) score += 2;
  }
  if (track.artists.length && candidate.artists.length) {
    if (artistsIntersect(track.artists, candidate.artists)) score += 2;
  }
  if (track.title && candidate.title) {
    if (normalizeTitle(track.title) === normalizeTitle(candidate.title)) score += 1;
  }
  return score;
}

export function bestMatch(track, candidates) {
  if (!candidates || !candidates.length) return { best: null, score: 0, reason: 'нет кандидатов' };
  // ISRC — сильнейший сигнал, приоритетнее скоринга.
  if (track.isrc) {
    const byIsrc = candidates.find(c => c.isrc && c.isrc.toUpperCase() === track.isrc.toUpperCase());
    if (byIsrc) return { best: byIsrc, score: SCORE_THRESHOLD, reason: 'isrc', isrc: true };
  }
  let best = null, bestScore = 0;
  for (const candidate of candidates) {
    const score = scoreCandidate(track, candidate);
    if (score > bestScore) { bestScore = score; best = candidate; }
  }
  if (best && bestScore >= SCORE_THRESHOLD) return { best, score: bestScore, reason: `score=${bestScore}` };
  return { best: null, score: bestScore, reason: `порог не достигнут (best=${bestScore})` };
}
