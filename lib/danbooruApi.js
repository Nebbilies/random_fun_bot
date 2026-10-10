import { chooseTag, normalizeTag, searchNames } from './danbooruTagMatcher.js';

const BASE = 'https://danbooru.donmai.us';
export const DANBOORU_USER_AGENT = process.env.DANBOORU_USER_AGENT ||
  'random-fun-bot-character-catalog/1.0 (private server catalog)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const literalTag = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');

export class DanbooruApi {
  constructor({ fetchImpl = fetch, db = null, gapMs = 1_200 } = {}) {
    this.fetchImpl = fetchImpl;
    this.db = db;
    this.gapMs = gapMs;
    this.nextRequestAt = 0;
  }

  async request(path, params = {}, { array = true } = {}) {
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const key = url.pathname + url.search;
    const cached = this.db?.prepare('SELECT response FROM tag_search_cache WHERE query = ?').get(key);
    if (cached) return JSON.parse(cached.response);
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      if (wait) await sleep(wait);
      this.nextRequestAt = Date.now() + this.gapMs;
      const response = await this.fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': DANBOORU_USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= 8) throw new Error(`Danbooru HTTP ${response.status} after retries`);
        const retryAfter = Number(response.headers.get('retry-after'));
        this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() +
          (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : Math.min(300_000, 10_000 * 2 ** attempt)));
        continue;
      }
      if (!response.ok) throw new Error(`Danbooru HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const payload = await response.json();
      if (array ? !Array.isArray(payload) : !payload || typeof payload !== 'object' || Array.isArray(payload))
        throw new Error('Unexpected Danbooru API response');
      this.db?.prepare('INSERT OR REPLACE INTO tag_search_cache (query, response, fetched_at) VALUES (?, ?, ?)')
        .run(key, JSON.stringify(payload), new Date().toISOString());
      return payload;
    }
  }

  async searchTags(name) {
    const normalized = normalizeTag(name);
    if (!normalized) return [];
    const tags = await this.request('/tags.json', {
      'search[category]': 4, 'search[name_matches]': `${normalized}*`,
      'search[is_deprecated]': false, limit: 100,
    });
    return tags.filter((tag) => tag.category === 4 && !tag.is_deprecated)
      .map((tag) => ({ name: tag.name, post_count: tag.post_count ?? 0 }));
  }

  async searchTagsLiteral(name) {
    const query = literalTag(name);
    if (!query) return [];
    const tags = await this.request('/tags.json', {
      'search[category]': 4, 'search[name_matches]': `${query}*`,
      'search[is_deprecated]': false, limit: 100,
    });
    return tags.filter((tag) => tag.category === 4 && !tag.is_deprecated)
      .map((tag) => ({ name: tag.name, post_count: tag.post_count ?? 0 }));
  }

  async exactTag(name) {
    const literal = literalTag(name);
    const tags = await this.request('/tags.json', { 'search[name]': literal, 'search[category]': 4, limit: 5 });
    return tags.find((tag) => tag.name === literal && tag.category === 4 && !tag.is_deprecated) ?? null;
  }

  async post(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid Danbooru post ID');
    return this.request(`/posts/${id}.json`, {}, { array: false });
  }

  async tagAlias(id) {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid Danbooru alias ID');
    return this.request(`/tag_aliases/${id}.json`, {}, { array: false });
  }

  async aliases(name) {
    const aliases = await this.request('/tag_aliases.json', {
      'search[antecedent_name]': normalizeTag(name), 'search[status]': 'active',
      'search[category]': 4, limit: 20,
    });
    const resolved = [];
    for (const item of aliases.filter((alias) => alias.status === 'active')) {
      const tag = await this.exactTag(item.consequent_name);
      if (tag && Number.isInteger(tag.post_count))
        resolved.push({ name: tag.name, post_count: tag.post_count, aliasFrom: item.antecedent_name });
    }
    return resolved;
  }

  async candidates(character) {
    const found = new Map();
    for (const name of searchNames(character).slice(0, 2)) {
      const tags = await this.searchTags(name);
      for (const tag of tags) {
        const existing = found.get(tag.name);
        found.set(tag.name, existing?.aliasFrom ? { ...tag, aliasFrom: existing.aliasFrom } : tag);
      }
      const exact = tags.find((tag) => tag.name === name);
      if (!exact || exact.post_count === 0) {
        for (const tag of await this.aliases(name)) {
          found.delete(tag.aliasFrom);
          found.set(tag.name, tag);
        }
      }
    }
    const all = [...found.values()];
    const chosen = chooseTag(character, all).tag;
    return all.sort((a, b) => {
      const score = (tag) => (tag.name === chosen ? 2 : chooseTag(character, [tag]).status === 'automatic' ? 1 : 0);
      return score(b) - score(a) || b.post_count - a.post_count;
    }).slice(0, 25);
  }
}
