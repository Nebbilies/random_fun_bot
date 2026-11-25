/** Shared, pure matching for human-entered names, never opaque identities. */
export const normalizeName = (value) =>
  typeof value === "string"
    ? value
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .trim()
        .replace(/\s+/g, " ")
    : "";

const words = (value) => value.match(/[\p{L}\p{N}]+/gu) ?? [];

export function prepareNames(primary, aliases = []) {
  const full = normalizeName(primary);
  const other = [...new Set(aliases.map(normalizeName).filter(Boolean))];
  return {
    primary: full,
    aliases: other,
    labels: [full, ...other]
      .map((text, index) => ({ text, tokens: words(text), alias: index > 0 }))
      .filter((label) => label.text),
  };
}

/** Optimal string alignment distance: adjacent transpositions count as one edit. */
function distance(left, right, limit) {
  const a = Array.from(left),
    b = Array.from(right);
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let beforePrevious = previous;
  for (let i = 1; i <= a.length; i++) {
    const current = Array(b.length + 1).fill(limit + 1);
    current[0] = i;
    for (
      let j = Math.max(1, i - limit);
      j <= Math.min(b.length, i + limit);
      j++
    ) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
    }
    beforePrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

function typo(left, right) {
  if (Math.abs(left.length - right.length) > 4) return null;
  const a = Array.from(left).length,
    b = Array.from(right).length;
  const length = Math.min(a, b);
  const limit = Math.min(
    length < 4 ? 0 : length < 8 ? 1 : 2,
    Math.floor(Math.max(a, b) / 4),
  );
  if (!limit || Math.abs(a - b) > limit) return null;
  // Every absent code point needs an insertion/deletion/substitution. This cheap
  // lower bound rejects unrelated labels before allocating distance rows.
  let absent = 0;
  for (const point of left) {
    if (!right.includes(point) && ++absent > limit) return null;
  }
  const edits = distance(left, right, limit);
  return edits <= limit ? [edits, edits / Math.max(a, b)] : null;
}

function literal(q, target) {
  if (!q.length) return null;
  let best = null;
  for (let start = 0; start + q.length <= target.length; start++) {
    const span = target.slice(start, start + q.length);
    if (
      q.every((word, i) =>
        /\p{N}/u.test(word) ? word === span[i] : span[i].startsWith(word),
      )
    ) {
      const partial = q.some((word, i) => word !== span[i]) ? 1 : 0;
      if (best === null || partial < best) best = partial;
    }
  }
  return best;
}

function fuzzy(query, q, label, target, cache) {
  if (!q.length) return null;
  let best = null;
  // Full labels handle punctuation/spelling differences; numeric tokens remain exact.
  const numeric = (word) => /\p{N}/u.test(word);
  const matchText = (text) => {
    if (!cache.has(text)) cache.set(text, typo(q.join(" "), text));
    return cache.get(text);
  };
  if (
    q.length === target.length &&
    q.every(
      (word, i) =>
        (!numeric(word) && !numeric(target[i])) || word === target[i],
    )
  )
    best = typo(query, label);
  for (let start = 0; start + q.length <= target.length; start++) {
    const span = target.slice(start, start + q.length);
    if (
      q.some(
        (word, i) =>
          (/\p{N}/u.test(word) || /\p{N}/u.test(span[i])) && word !== span[i],
      )
    )
      continue;
    const match = matchText(span.join(" "));
    if (match && (!best || compare(match, best) < 0)) best = match;
  }
  return best;
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Entries are already scoped by the caller. Returned indices preserve original rows.
 * Exact aliases can share the primary tier for franchise lookup compatibility.
 */
export function matchNames(entries, input, { combinedExact = false } = {}) {
  const query = normalizeName(input);
  const queryWords = words(query);
  if (query.length < 2) return { indices: [], matchType: "none" };
  const primary = [],
    aliases = [];
  entries.forEach((entry, index) => {
    if (entry.primary === query) primary.push(index);
    else if (entry.aliases.includes(query)) aliases.push(index);
  });
  const exact = combinedExact
    ? [...primary, ...aliases].sort((a, b) => a - b)
    : primary.length
      ? primary
      : aliases;
  if (exact.length) return { indices: exact, matchType: "exact" };
  if (!queryWords.length) return { indices: [], matchType: "none" };

  // Literal word evidence wins; only evaluate expensive typo comparisons if needed.
  for (const kind of ["partial", "fuzzy", "substring"]) {
    const matches = [];
    const qualities = new Map();
    const typoCache = new Map();
    entries.forEach((entry, index) => {
      let best = null;
      for (const prepared of entry.labels) {
        const { text: label, tokens, alias } = prepared;
        let quality;
        if (qualities.has(label)) {
          quality = qualities.get(label);
          if (!quality) continue;
        } else if (kind === "partial") {
          const value = literal(queryWords, tokens);
          if (value === null) {
            qualities.set(label, null);
            continue;
          }
          quality = [value, 0];
        } else if (kind === "fuzzy") {
          quality = fuzzy(query, queryWords, label, tokens, typoCache);
          if (!quality) {
            qualities.set(label, null);
            continue;
          }
        } else {
          const numeric = queryWords.some((word) => /\p{N}/u.test(word));
          // Numeric queries must align their own token sequence, not borrow an
          // equal number elsewhere in the label to validate a substring.
          const alignedNumbers =
            !numeric ||
            tokens.some(
              (_, start) =>
                start + queryWords.length <= tokens.length &&
                queryWords.every((word, i) =>
                  /\p{N}/u.test(word)
                    ? word === tokens[start + i]
                    : tokens[start + i].includes(word),
                ),
            );
          if (!label.includes(query) || !alignedNumbers) {
            qualities.set(label, null);
            continue;
          }
          quality = [0, 0];
        }
        qualities.set(label, quality);
        const score = [...quality, alias ? 1 : 0];
        if (!best || compare(score, best) < 0) best = score;
      }
      if (best) matches.push({ index, score: best });
    });
    if (matches.length) {
      matches.sort((a, b) => compare(a.score, b.score) || a.index - b.index);
      return { indices: matches.map((match) => match.index), matchType: kind };
    }
  }
  return { indices: [], matchType: "none" };
}
