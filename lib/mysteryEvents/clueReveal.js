const CLUE_INTERVAL = 18_000;
const DURATION = 90_000;

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeTitle(value) {
  return String(value || '').normalize('NFKD').toLocaleLowerCase('en')
    .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]/gu, '');
}

function titleAliases(row) {
  return [row.title_romaji, row.title_english, row.title_native, ...parseArray(row.synonyms)]
    .filter((title) => typeof title === 'string' && title.trim());
}

function targetAnime(db, characterId, rules) {
  const row = db.prepare(`SELECT a.id, a.title_romaji, a.title_english, a.title_native,
    a.synonyms, a.genres, a.tags, a.start_date, a.season_year, a.format,
    a.popularity, a.is_adult FROM character_anime AS ca
    JOIN anime AS a ON a.id = ca.anime_id WHERE ca.character_id = ?
    ORDER BY (a.format = 'TV') DESC, COALESCE(a.popularity, 0) DESC, a.id ASC LIMIT 1`)
    .get(characterId);
  if (!row || row.is_adult) return null;
  const aliases = titleAliases(row);
  const title = row.title_english || row.title_romaji || row.title_native;
  if (!title || !aliases.length || !row.format) return null;
  const genres = parseArray(row.genres).filter((item) => typeof item === 'string' && item.trim());
  const tags = parseArray(row.tags)
    .filter((item) => item && typeof item.name === 'string' && item.name.trim()
      && !item.isMediaSpoiler && !item.isGeneralSpoiler && (item.rank ?? 0) >= (rules?.tagMinRank ?? 50))
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  let year = Number(row.season_year);
  if (!Number.isSafeInteger(year) || year < 1900) {
    try { year = Number(JSON.parse(row.start_date || '{}').year); } catch { year = NaN; }
  }
  if (!Number.isSafeInteger(year) || year < 1900 || !genres.length || !tags.length) return null;
  const initial = Array.from(title.trim())[0];
  if (!initial || normalizeTitle(title).length < 3) return null;
  const words = title.trim().split(/\s+/).length;
  const clues = [
    `Format: ${row.format}`,
    `Year: ${year}`,
    `Genres: ${genres.slice(0, rules?.genreCount ?? 2).join(', ')}`,
    `Tags: ${tags.slice(0, rules?.tagCount ?? 2).map((item) => item.name).join(', ')}`,
    `Title hint: starts with **${initial}**; ${words} word${words === 1 ? '' : 's'}.`,
  ];
  const normalizedAliases = aliases.map(normalizeTitle).filter(Boolean);
  if (clues.slice(0, 4).some((clue) => normalizedAliases.some((alias) => alias.length >= 3
    && normalizeTitle(clue).includes(alias)))) return null;
  return { animeId: row.id, title, aliases, clues };
}

function typoLimit(length, rules) {
  if (length < (rules?.typoShortLength ?? 5)) return rules?.shortTypos ?? 0;
  if (length < (rules?.typoLongLength ?? 10)) return rules?.mediumTypos ?? 1;
  return rules?.longTypos ?? 2;
}

function withinDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let minimum = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
      minimum = Math.min(minimum, current[j]);
    }
    if (minimum > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

function matchesAnswer(db, state, value) {
  const guess = normalizeTitle(value);
  if (!guess) return false;
  const aliases = state.aliases.map(normalizeTitle).filter(Boolean);
  if (aliases.includes(guess)) return true;
  const closeToTarget = aliases.some((alias) => withinDistance(guess, alias, typoLimit(alias.length, state.rules)));
  if (!closeToTarget) return false;
  const other = db.prepare('SELECT id, title_romaji, title_english, title_native, synonyms FROM anime WHERE id != ?')
    .all(state.animeId);
  for (const row of other) {
    for (const alias of titleAliases(row)) {
      const normalized = normalizeTitle(alias);
      if (normalized && withinDistance(guess, normalized, typoLimit(normalized.length, state.rules))) return false;
    }
  }
  return true;
}

function clueView(state) {
  return { text: `Guess the anime linked to the mystery character.\n${state.clues.slice(0, state.stage + 1)
    .map((clue, index) => `**Clue ${index + 1}:** ${clue}`).join('\n')}` };
}

export const clueRevealEvent = {
  id: 'clue_reveal',
  durationMs: DURATION,
  available({ db, character, rules }) {
    return Boolean(targetAnime(db, character.id, rules));
  },
  start({ db, character, now, rules }) {
    const target = targetAnime(db, character.id, rules);
    if (!target) return null;
    const state = { ...target, stage: 0, startedAt: now, guessedAtStage: {},
      ...(rules ? { rules: structuredClone(rules) } : {}) };
    return { state, durationMs: rules?.durationMs ?? DURATION,
      nextInMs: rules?.clueIntervalMs ?? CLUE_INTERVAL, view: clueView(state) };
  },
  advance({ db, state, input, now }) {
    const durationMs = state.rules?.durationMs ?? DURATION;
    const clueIntervalMs = state.rules?.clueIntervalMs ?? CLUE_INTERVAL;
    if (now >= state.startedAt + durationMs) {
      return { state, outcome: { type: 'no_winner', answer: state.title } };
    }
    if (input.type === 'timer') {
      const stage = Math.min(4, Math.floor((now - state.startedAt) / clueIntervalMs));
      if (stage <= state.stage) {
        const nextElapsed = state.stage >= 4 ? durationMs : (state.stage + 1) * clueIntervalMs;
        return { state, nextInMs: Math.max(0, nextElapsed - (now - state.startedAt)) };
      }
      const next = { ...state, stage };
      return { state: next, view: clueView(next),
        nextInMs: Math.min(stage >= 4 ? durationMs : clueIntervalMs, durationMs - (now - state.startedAt)) };
    }
    if (input.type !== 'answer' || typeof input.userId !== 'string') return { state };
    if (state.guessedAtStage[input.userId] === state.stage) return { state, feedback: 'already_guessed' };
    if (matchesAnswer(db, state, input.value)) {
      return { state, outcome: { type: 'winner', userId: input.userId, answer: state.title } };
    }
    return { state: { ...state, guessedAtStage: { ...state.guessedAtStage, [input.userId]: state.stage } },
      feedback: 'wrong' };
  },
};
