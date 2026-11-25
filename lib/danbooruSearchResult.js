const DANBOORU_HOSTS = new Set(["danbooru.donmai.us", "safebooru.donmai.us"]);
const LITERAL_TAG = /^[a-z0-9_().!-]{2,120}$/i;

async function resolveTag(api, name) {
  const exact = await api.exactTag(name);
  if (exact) return { tag: exact, aliasFrom: null };
  const aliases = await api.aliases(name);
  return aliases.length === 1 ? { tag: aliases[0], aliasFrom: name } : null;
}

export async function inspectDanbooruResult(api, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { reason: "Invalid result URL", candidates: [] };
  }
  if (url.protocol !== "https:" || !DANBOORU_HOSTS.has(url.hostname))
    return { reason: "Result is not Danbooru", candidates: [] };

  let names = [];
  let copyrightTags = [];
  let post = false;
  try {
    const postId = url.pathname.match(/^\/posts\/(\d+)\/?$/)?.[1];
    const aliasId = url.pathname.match(/^\/tag_aliases\/(\d+)\/?$/)?.[1];
    if (postId) {
      const data = await api.post(Number(postId));
      names = String(data.tag_string_character || "")
        .split(/\s+/)
        .filter(Boolean);
      copyrightTags = String(data.tag_string_copyright || "")
        .split(/\s+/)
        .filter(Boolean);
      post = true;
    } else if (aliasId) {
      const alias = await api.tagAlias(Number(aliasId));
      if (alias.status !== "active")
        return { reason: "Tag alias is not active", candidates: [] };
      const tag = await api.exactTag(alias.consequent_name);
      if (!tag)
        return {
          reason: "Alias does not lead to an active character tag",
          candidates: [],
        };
      return {
        tag,
        aliasFrom: alias.antecedent_name,
        copyrightTags,
        candidates: [tag],
        reason: "Active character-tag alias",
      };
    } else if (url.pathname.startsWith("/wiki_pages/")) {
      names = [decodeURIComponent(url.pathname.slice("/wiki_pages/".length))];
    } else if (url.pathname === "/wiki_pages") {
      names = [url.searchParams.get("title")].filter(Boolean);
    } else if (url.pathname === "/posts") {
      names = (url.searchParams.get("tags") || "")
        .split(/\s+/)
        .filter((name) => LITERAL_TAG.test(name))
        .slice(0, 10);
    } else {
      return {
        reason: "Danbooru URL does not identify tags or a post",
        candidates: [],
      };
    }

    const found = new Map();
    for (const name of names) {
      const resolved = await resolveTag(api, name);
      if (resolved) found.set(resolved.tag.name, resolved);
    }
    const candidates = [...found.values()].map(({ tag }) => tag);
    if (post && names.length !== 1)
      return {
        reason: `Post has ${names.length} character tags; need exactly one`,
        candidates,
        copyrightTags,
      };
    if (found.size !== 1)
      return {
        reason: `Found ${found.size} character tags; need exactly one`,
        candidates,
        copyrightTags,
      };
    const [{ tag, aliasFrom }] = found.values();
    return {
      tag,
      aliasFrom,
      copyrightTags,
      candidates,
      reason: "One active character tag",
    };
  } catch (error) {
    if (/^Danbooru HTTP 404:/.test(error.message))
      return {
        reason: "Danbooru post or tag no longer exists",
        candidates: [],
      };
    throw error;
  }
}
