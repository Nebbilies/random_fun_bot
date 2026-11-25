import { DANBOORU_USER_AGENT } from "./danbooruApi.js";

const POOL_SIZE = 10;
const SEARCH_PAGES = 3;
const POSTS_PER_PAGE = 100;
const CACHE_MS = 60 * 60 * 1000;
const FAILURE_CACHE_MS = 5 * 60 * 1000;

function safeImageUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "donmai.us" || url.hostname.endsWith(".donmai.us"))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export function createCharacterImagePicker({
  fetchImpl = fetch,
  random = Math.random,
} = {}) {
  const pools = new Map();
  const rotations = new Map();

  async function poolFor(tag) {
    const cached = pools.get(tag);
    if (cached && cached.expiresAt > Date.now()) return cached.posts;

    try {
      const seen = new Set();
      const solo = [];
      const other = [];
      for (
        let page = 1;
        page <= SEARCH_PAGES && solo.length < POOL_SIZE;
        page++
      ) {
        let body;
        try {
          const url = new URL("https://safebooru.donmai.us/posts.json");
          url.searchParams.set("tags", `${tag} order:score`);
          url.searchParams.set("limit", String(POSTS_PER_PAGE));
          if (page > 1) url.searchParams.set("page", String(page));
          const response = await fetchImpl(url, {
            headers: {
              accept: "application/json",
              "user-agent": DANBOORU_USER_AGENT,
            },
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok)
            throw new Error(`Safebooru HTTP ${response.status}`);
          body = await response.json();
          if (!Array.isArray(body))
            throw new Error("Unexpected Safebooru response");
        } catch (error) {
          if (page === 1) throw error;
          console.warn(
            `Character image search stopped at page ${page} for ${tag}: ${error.message}`,
          );
          break;
        }
        for (const post of body) {
          if (post.rating !== "g") continue;
          const imageUrl = safeImageUrl(post.large_file_url || post.file_url);
          const key = post.md5 || imageUrl;
          if (!Number.isInteger(post.id) || !imageUrl || seen.has(key))
            continue;
          seen.add(key);
          const tags = ` ${post.tag_string_general || post.tag_string || ""} `;
          const candidate = {
            id: post.id,
            url: imageUrl,
            score: post.score ?? 0,
            solo: tags.includes(" solo "),
          };
          (candidate.solo ? solo : other).push(candidate);
        }
        if (body.length < POSTS_PER_PAGE) break;
      }
      solo.sort((a, b) => b.score - a.score);
      other.sort((a, b) => b.score - a.score);
      const posts =
        solo.length >= 2
          ? solo.slice(0, POOL_SIZE)
          : [...solo, ...other].slice(0, POOL_SIZE);
      pools.set(tag, { posts, expiresAt: Date.now() + CACHE_MS });
      return posts;
    } catch (error) {
      console.warn(
        `Character image lookup failed for ${tag}: ${error.message}`,
      );
      pools.set(tag, { posts: [], expiresAt: Date.now() + FAILURE_CACHE_MS });
      return [];
    }
  }

  return {
    async pick(guildId, characterId, tag, portraitUrl) {
      if (!tag) return { url: portraitUrl, source: "anilist", poolSize: 0 };
      const posts = await poolFor(tag);
      if (!posts.length)
        return { url: portraitUrl, source: "anilist", poolSize: 0 };

      const key = `${guildId}:${characterId}`;
      let rotation = rotations.get(key);
      if (!rotation || rotation.tag !== tag || !rotation.remaining.length) {
        let remaining = [
          ...shuffle(
            posts.filter((post) => post.solo),
            random,
          ),
          ...shuffle(
            posts.filter((post) => !post.solo),
            random,
          ),
        ];
        if (remaining.length > 1 && remaining[0].id === rotation?.lastId) {
          [remaining[0], remaining[1]] = [remaining[1], remaining[0]];
        }
        rotation = {
          tag,
          remaining,
          lastId: rotation?.tag === tag ? rotation.lastId : null,
        };
        rotations.set(key, rotation);
      }
      const post = rotation.remaining.shift();
      rotation.lastId = post.id;
      return {
        url: post.url,
        source: "danbooru",
        postId: post.id,
        poolSize: posts.length,
      };
    },
  };
}
