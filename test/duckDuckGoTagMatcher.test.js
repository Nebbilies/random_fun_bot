import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCatalog,
  openCatalogReadOnly,
  saveDecision,
  setMeta,
} from "../lib/catalogDb.js";
import { inspectDanbooruResult } from "../lib/danbooruSearchResult.js";
import {
  duckDuckGoResults,
  matchDuckDuckGoTags,
  parseDuckDuckGoResults,
} from "../scripts/matchDuckDuckGoTags.js";

const tag = (name) => ({
  name,
  category: 4,
  is_deprecated: false,
  post_count: 12,
});
const result = (url, title = "Result") =>
  `<a href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc" class='result-link'>${title}</a>`;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "duckduckgo-tags-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "bot.sqlite");
  const db = openCatalog(path);
  setMeta(db, "import_phase", "complete");
  db.prepare(
    `INSERT INTO characters (id, rank, favourites, name_full, anime_titles)
    VALUES (1, 1, 1, 'X', '["To Be Hero X"]'),
      (2, 2, 1, 'Manual', '["Example"]')`,
  ).run();
  return { path, db };
}

test("DuckDuckGo Lite parser unwraps and keeps the first two organic results", () => {
  const first = "https://danbooru.donmai.us/posts?tags=x_%28to_be_hero_x%29";
  const second = "https://danbooru.donmai.us/posts/11965047";
  const ad = `<a href="//duckduckgo.com/y.js?ad_domain=example.com" class='result-link'>Sponsored</a>
    <a href="https://duckduckgo.com/duckduckgo-help-pages/company/ads-by-microsoft-on-duckduckgo-private-search/" class='result-link'>more info</a>`;
  const html = `<a href="https://example.com">Navigation</a>${ad}${result(first)}${result(first)}${result(second)}${result("https://example.com/third")}`;
  assert.deepEqual(
    parseDuckDuckGoResults(html).map(({ url }) => url),
    [first, second],
  );
});

test("DuckDuckGo Lite stops on a non-200 response and unreadable results", async () => {
  await assert.rejects(
    duckDuckGoResults(async () => ({ status: 202 }), "query"),
    /HTTP 202/,
  );
  await assert.rejects(
    duckDuckGoResults(
      async () => ({
        status: 200,
        text: async () => "<html>No results</html>",
      }),
      "query",
    ),
    /no readable organic results/,
  );
});

test("tag, alias, and post URLs require one active character tag", async () => {
  const tags = new Map([
    ["x_(to_be_hero_x)", tag("x_(to_be_hero_x)")],
    ["yatogami_tohka", tag("yatogami_tohka")],
    [
      "richeh_(tongari_boushi_no_atelier)",
      tag("richeh_(tongari_boushi_no_atelier)"),
    ],
    ["other_character", tag("other_character")],
  ]);
  const api = {
    exactTag: async (name) => tags.get(name) ?? null,
    aliases: async () => [],
    tagAlias: async () => ({
      status: "active",
      antecedent_name: "yatogami_tooka",
      consequent_name: "yatogami_tohka",
    }),
    post: async (id) => ({
      tag_string_character:
        id === 1
          ? "richeh_(tongari_boushi_no_atelier)"
          : "richeh_(tongari_boushi_no_atelier) other_character",
      tag_string_copyright: "tongari_boushi_no_atelier",
    }),
  };
  assert.equal(
    (
      await inspectDanbooruResult(
        api,
        "https://danbooru.donmai.us/posts?tags=to_be_hero_x",
      )
    ).tag,
    undefined,
  );
  assert.equal(
    (
      await inspectDanbooruResult(
        api,
        "https://danbooru.donmai.us/posts?tags=x_%28to_be_hero_x%29",
      )
    ).tag.name,
    "x_(to_be_hero_x)",
  );
  assert.equal(
    (
      await inspectDanbooruResult(
        api,
        "https://danbooru.donmai.us/tag_aliases/126168",
      )
    ).tag.name,
    "yatogami_tohka",
  );
  assert.equal(
    (await inspectDanbooruResult(api, "https://danbooru.donmai.us/posts/1")).tag
      .name,
    "richeh_(tongari_boushi_no_atelier)",
  );
  assert.equal(
    (await inspectDanbooruResult(api, "https://danbooru.donmai.us/posts/2"))
      .tag,
    undefined,
  );
});

test("read-only sample proposes a tag without changing the database", async (t) => {
  const { path, db } = fixture(t);
  saveDecision(db, 2, "no_match");
  db.close();
  const readOnly = openCatalogReadOnly(path);
  const logs = [];
  try {
    const summary = await matchDuckDuckGoTags({
      db: readOnly,
      limit: 1,
      delayMs: 0,
      fetchImpl: async () => ({
        status: 200,
        text: async () =>
          result("https://danbooru.donmai.us/posts?tags=x_%28to_be_hero_x%29"),
      }),
      api: {
        exactTag: async (name) =>
          name === "x_(to_be_hero_x)" ? tag(name) : null,
        aliases: async () => [],
      },
      log: (message) => logs.push(message),
    });
    assert.deepEqual(summary, { searched: 1, approved: 1, manual: 0 });
    assert.match(logs.join("\n"), /would auto approve x_\(to_be_hero_x\)/);
    assert.equal(
      readOnly
        .prepare("SELECT COUNT(*) AS n FROM duckduckgo_tag_attempts")
        .get().n,
      0,
    );
    assert.equal(
      readOnly.prepare("SELECT COUNT(*) AS n FROM tag_decisions").get().n,
      1,
    );
  } finally {
    readOnly.close();
  }
});

test("searches with anime title first, then character only if no tag is found", async (t) => {
  const { db } = fixture(t);
  const queries = [];
  const logs = [];
  try {
    const summary = await matchDuckDuckGoTags({
      db,
      apply: true,
      limit: 1,
      delayMs: 0,
      fetchImpl: async (url) => {
        const query = url.searchParams.get("q");
        queries.push(query);
        const urls =
          query === "X To Be Hero X danbooru"
            ? [
                result("https://danbooru.donmai.us/posts?tags=to_be_hero_x"),
                result("https://example.com/x"),
              ]
            : [
                result(
                  "https://danbooru.donmai.us/posts?tags=x_%28to_be_hero_x%29",
                ),
              ];
        return { status: 200, text: async () => urls.join("") };
      },
      api: {
        exactTag: async (name) =>
          name === "x_(to_be_hero_x)" ? tag(name) : null,
        aliases: async () => [],
      },
      log: (message) => logs.push(message),
    });
    assert.deepEqual(queries, ["X To Be Hero X danbooru", "X danbooru"]);
    assert.deepEqual(summary, { searched: 1, approved: 1, manual: 0 });
    assert.match(
      logs.join("\n"),
      /auto approved x_\(to_be_hero_x\) from character-only query result #1/,
    );
    const attempt = db
      .prepare(
        "SELECT query, details FROM duckduckgo_tag_attempts WHERE character_id = 1",
      )
      .get();
    assert.equal(attempt.query, queries[0]);
    assert.match(
      attempt.details,
      /X danbooru result #1: One active character tag/,
    );
  } finally {
    db.close();
  }
});

test("applied run saves once and preserves manual decisions", async (t) => {
  const { db } = fixture(t);
  try {
    saveDecision(db, 2, "no_match");
    let searches = 0;
    const options = {
      db,
      apply: true,
      limit: 2,
      delayMs: 0,
      fetchImpl: async () => {
        searches++;
        return {
          status: 200,
          text: async () =>
            result(
              "https://danbooru.donmai.us/posts?tags=x_%28to_be_hero_x%29",
            ),
        };
      },
      api: {
        exactTag: async (name) =>
          name === "x_(to_be_hero_x)" ? tag(name) : null,
        aliases: async () => [],
      },
      log: () => {},
    };
    assert.deepEqual(await matchDuckDuckGoTags(options), {
      searched: 1,
      approved: 1,
      manual: 0,
    });
    assert.equal((await matchDuckDuckGoTags(options)).searched, 0);
    assert.equal(searches, 1);
    assert.equal(
      db
        .prepare("SELECT tag_name FROM tag_decisions WHERE character_id = 1")
        .get().tag_name,
      "x_(to_be_hero_x)",
    );
    assert.equal(
      db
        .prepare("SELECT status FROM tag_decisions WHERE character_id = 2")
        .get().status,
      "no_match",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM duckduckgo_tag_attempts").get().n,
      1,
    );
  } finally {
    db.close();
  }
});

test("blocked applied search records no attempt or decision", async (t) => {
  const { db } = fixture(t);
  try {
    await assert.rejects(
      matchDuckDuckGoTags({
        db,
        apply: true,
        limit: 1,
        delayMs: 0,
        fetchImpl: async () => ({ status: 202 }),
        api: {},
        log: () => {},
      }),
      /HTTP 202/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM duckduckgo_tag_attempts").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tag_decisions").get().n,
      0,
    );
  } finally {
    db.close();
  }
});

test("blocked fallback leaves an applied character untouched", async (t) => {
  const { db } = fixture(t);
  let searches = 0;
  try {
    await assert.rejects(
      matchDuckDuckGoTags({
        db,
        apply: true,
        limit: 1,
        delayMs: 0,
        fetchImpl: async () => {
          searches++;
          return searches === 1
            ? {
                status: 200,
                text: async () => result("https://example.com/no-tag"),
              }
            : { status: 202 };
        },
        api: { exactTag: async () => null, aliases: async () => [] },
        log: () => {},
      }),
      /HTTP 202/,
    );
    assert.equal(searches, 2);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM duckduckgo_tag_attempts").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM tag_decisions").get().n,
      0,
    );
  } finally {
    db.close();
  }
});
