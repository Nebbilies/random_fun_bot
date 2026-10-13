const ENDPOINT = 'https://graphql.anilist.co';
const REQUEST_GAP_MS = 4_000; // At most 15 requests/minute, below the currently published 30/minute cap.

const HIGHEST_ANIME = `query { Page(page: 1, perPage: 1) { media(type: ANIME, sort: ID_DESC) { id } } }`;
const ANIME_FIELDS = `
      id title { romaji english native } format status averageScore popularity
      characters(page: 1, perPage: 25) {
        pageInfo { hasNextPage }
        nodes { id favourites name { full } }
      }
`;
const animePageQuery = (filters) => `query ($ids: [Int], $page: Int) {
  Page(page: $page, perPage: 10) {
    pageInfo { hasNextPage }
    media(type: ANIME, id_in: $ids, sort: ID${filters}) { ${ANIME_FIELDS} }
  }
}`;
const ANIME_PAGE = animePageQuery(', format_not: MUSIC, status_not: NOT_YET_RELEASED, averageScore_greater: 49, popularity_greater: 15000');
const UNFILTERED_ANIME_PAGE = animePageQuery('');
const EXTRA_CHARACTERS = `query ($id: Int, $page: Int) {
  Media(id: $id, type: ANIME) {
    characters(page: $page, perPage: 25) {
      pageInfo { hasNextPage }
      nodes { id favourites name { full } }
    }
  }
}`;
const CHARACTER_DETAILS = `query ($ids: [Int]) {
  Page(page: 1, perPage: 25) {
    characters(id_in: $ids, sort: ID) {
      id favourites name { full native alternative }
      gender age dateOfBirth { year month day }
      description image { large } siteUrl
      media(type: ANIME, page: 1, perPage: 10) {
        pageInfo { hasNextPage }
        nodes { id title { romaji english native } isAdult format status averageScore popularity }
      }
    }
  }
}`;
const EXTRA_CHARACTER_MEDIA = `query ($id: Int, $page: Int) {
  Character(id: $id) {
    media(type: ANIME, page: $page, perPage: 10) {
      pageInfo { hasNextPage }
      nodes { id title { romaji english native } isAdult format status averageScore popularity }
    }
  }
}`;
const CHARACTER_ANIME_PAGE = `query ($id: Int, $page: Int) {
  Character(id: $id) {
    media(type: ANIME, page: $page, perPage: 25) {
      pageInfo { hasNextPage }
      nodes { id }
    }
  }
}`;
const ANIME_DETAILS = `query ($ids: [Int]) {
  Page(page: 1, perPage: 25) {
    media(type: ANIME, id_in: $ids) {
      id title { romaji english native } synonyms genres
      tags { name rank isMediaSpoiler isGeneralSpoiler }
      startDate { year month day } seasonYear format status
      averageScore popularity isAdult coverImage { extraLarge large } siteUrl
      relations {
        edges {
          # COMPILATION is version 2 only; SAME_UNIVERSE is version 3 only.
          typeV2: relationType(version: 2)
          typeV3: relationType(version: 3)
          node { id type }
        }
      }
    }
  }
}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class AniListCatalogApi {
  constructor({ fetchImpl = fetch, gapMs = REQUEST_GAP_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.gapMs = gapMs;
    this.nextRequestAt = 0;
  }

  async query(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      if (wait) await sleep(wait);
      this.nextRequestAt = Date.now() + this.gapMs;
      const response = await this.fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= 8) throw new Error(`AniList HTTP ${response.status} after retries`);
        const retryAfter = Number(response.headers.get('retry-after'));
        const retryMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1_000 : Math.min(300_000, 10_000 * 2 ** attempt);
        this.nextRequestAt = Math.max(this.nextRequestAt, Date.now() + retryMs);
        continue;
      }
      if (!response.ok) throw new Error(`AniList HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const payload = await response.json();
      if (payload.errors?.length) throw new Error(`AniList GraphQL: ${payload.errors.map((item) => item.message).join('; ')}`);
      return payload.data;
    }
  }

  async highestAnimeId() {
    const data = await this.query(HIGHEST_ANIME);
    const id = data?.Page?.media?.[0]?.id;
    if (!Number.isInteger(id)) throw new Error('AniList returned no highest anime ID');
    return id;
  }

  async animePage(ids, page, { unfiltered = false } = {}) {
    return (await this.query(unfiltered ? UNFILTERED_ANIME_PAGE : ANIME_PAGE, { ids, page }))?.Page;
  }

  async extraCharacters(id, page) {
    return (await this.query(EXTRA_CHARACTERS, { id, page }))?.Media?.characters;
  }

  async characterDetails(ids) {
    return (await this.query(CHARACTER_DETAILS, { ids }))?.Page?.characters ?? [];
  }

  async extraCharacterMedia(id, page) {
    return (await this.query(EXTRA_CHARACTER_MEDIA, { id, page }))?.Character?.media;
  }

  async characterAnimePage(id, page) {
    return (await this.query(CHARACTER_ANIME_PAGE, { id, page }))?.Character?.media;
  }

  async animeDetails(ids) {
    return (await this.query(ANIME_DETAILS, { ids }))?.Page?.media ?? [];
  }
}
