export function normalizeTag(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function namesFor(character) {
  const raw = [];
  for (const value of [character.name, ...(character.alternatives ?? [])]) {
    raw.push(value);
    const parts = String(value ?? "")
      .trim()
      .split(/\s+/);
    if (parts.length === 2) raw.push(`${parts[1]} ${parts[0]}`);
  }
  return [...new Set(raw.map(normalizeTag).filter((name) => name.length >= 3))];
}

export function chooseTagByCount(character, tags) {
  const ranked = tags
    .filter((tag) => Number.isInteger(tag.post_count))
    .sort((a, b) => b.post_count - a.post_count);
  if (ranked.length < 2) return null;
  const [top, second] = ranked;
  const countLead = top.post_count - second.post_count >= 500;
  const ratioLead =
    top.post_count >= 100 &&
    second.post_count > 0 &&
    top.post_count >= 5 * second.post_count;
  const tagName = normalizeTag(top.name);
  const aliasName = normalizeTag(top.aliasFrom);
  const names = namesFor(character);
  const canonicalNameMatches = names.some(
    (name) => tagName === name || tagName.startsWith(`${name}_`),
  );
  const seriesMatches = [...String(top.name).matchAll(/\(([^()]+)\)/g)]
    .map((match) => normalizeTag(match[1]))
    .filter((series) => series.length >= 4)
    .some((series) =>
      (character.animeTitles ?? []).some((title) =>
        normalizeTag(title).includes(series),
      ),
    );
  const aliasMatches =
    names.includes(aliasName) && (aliasName.includes("_") || seriesMatches);
  const exactZeroLead =
    top.post_count >= 100 &&
    ranked.slice(1).every((tag) => tag.post_count === 0) &&
    (names.includes(tagName) || aliasMatches);
  if (!countLead && !ratioLead && !exactZeroLead) return null;
  if (!canonicalNameMatches && !aliasMatches) return null;
  return {
    status: "automatic",
    tag: top.name,
    reason: countLead
      ? "Character tag leads by at least 500 posts"
      : ratioLead
        ? "Character tag has at least 5× the posts"
        : "Exact name or alias has at least 100 posts; other tags have none",
  };
}

export function chooseTag(character, tags) {
  const names = namesFor(character);
  const titles = (character.animeTitles ?? [])
    .map(normalizeTag)
    .filter(Boolean);
  const matches = tags.filter((tag) => {
    const name = normalizeTag(tag.name);
    return names.some(
      (candidate) => name === candidate || name.startsWith(`${candidate}_`),
    );
  });
  const qualified = matches.filter((tag) => {
    const value = normalizeTag(tag.name);
    return (
      names.some((name) => value.startsWith(`${name}_`)) &&
      titles.some((title) => {
        const suffix = value.slice(
          (names.find((name) => value.startsWith(`${name}_`)) ?? "").length + 1,
        );
        return title.includes(suffix) && suffix.length >= 4;
      })
    );
  });
  if (qualified.length === 1)
    return {
      status: "automatic",
      tag: qualified[0].name,
      reason: "Unique character name and anime title",
    };
  const exact = matches.filter((tag) => names.includes(normalizeTag(tag.name)));
  if (
    matches.length === 1 &&
    exact.length === 1 &&
    names.some((name) => name.includes("_"))
  )
    return {
      status: "automatic",
      tag: exact[0].name,
      reason: "Unique exact multiword name",
    };
  const countWinner = chooseTagByCount(character, tags);
  if (countWinner) return countWinner;
  return {
    status: "review",
    tag: null,
    reason: matches.length ? "Ambiguous character name" : "No matching tag",
  };
}

export function searchNames(character) {
  return namesFor(character).slice(0, 4);
}
