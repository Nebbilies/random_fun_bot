import test from "node:test";
import assert from "node:assert/strict";
import { DanbooruApi } from "../lib/danbooruApi.js";
import { DatabaseSync } from "node:sqlite";
test("ranking lookup accepts copyright and explicit zero but never uses cached or missing counts", async () => {
  const api = new DanbooruApi({
    gapMs: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify([
          { name: "series", category: 3, post_count: 0, is_deprecated: false },
        ]),
      ),
  });
  const evidence = await api.verifyRankingTag("series");
  assert.equal(evidence.post_count, 0);
  assert.equal(evidence.category, 3);
  await assert.rejects(
    () => api.verifyRankingTag("series", { allowCopyright: false }),
    /tag/,
  );
  const missing = new DanbooruApi({
    gapMs: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify([{ name: "series", category: 4, is_deprecated: false }]),
      ),
  });
  await assert.rejects(() => missing.verifyRankingTag("series"), /count/);
  const unavailable = new DanbooruApi({
    gapMs: 0,
    fetchImpl: async () =>
      new Response("", { status: 429, headers: { "retry-after": "0.001" } }),
  });
  await assert.rejects(() => unavailable.verifyRankingTag("series"), /429/);
});

test("fresh ranking requests recover from rate limits and server errors without using cached counts", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE tag_search_cache(query TEXT PRIMARY KEY,response TEXT,fetched_at TEXT)",
    );
    const query =
      "/tags.json?" +
      new URLSearchParams({ "search[name]": "series", limit: "5" });
    db.prepare("INSERT INTO tag_search_cache VALUES(?,?,?)").run(
      query,
      JSON.stringify([
        {
          name: "series",
          category: 4,
          post_count: 149200,
          is_deprecated: false,
        },
      ]),
      "old",
    );
    let calls = 0;
    const api = new DanbooruApi({
      db,
      gapMs: 0,
      fetchImpl: async () => {
        const status = [429, 503][calls++];
        return status
          ? new Response("", { status, headers: { "retry-after": "0.001" } })
          : new Response(
              JSON.stringify([
                {
                  name: "series",
                  category: 4,
                  post_count: 0,
                  is_deprecated: false,
                },
              ]),
            );
      },
    });
    assert.equal((await api.verifyRankingTag("series")).post_count, 0);
    assert.equal(calls, 3);
  } finally {
    db.close();
  }
});

test("fresh ranking evidence bypasses an indefinite cached success and retains successful zero", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE tag_search_cache(query TEXT PRIMARY KEY,response TEXT,fetched_at TEXT)",
    );
    const query =
      "/tags.json?" +
      new URLSearchParams({ "search[name]": "series", limit: "5" });
    db.prepare("INSERT INTO tag_search_cache VALUES(?,?,?)").run(
      query,
      JSON.stringify([
        {
          name: "series",
          category: 4,
          post_count: 149200,
          is_deprecated: false,
        },
      ]),
      "old",
    );
    const failed = new DanbooruApi({
      db,
      gapMs: 0,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    await assert.rejects(failed.verifyRankingTag("series"), /offline/);
    const zero = new DanbooruApi({
      db,
      gapMs: 0,
      fetchImpl: async () =>
        new Response(
          JSON.stringify([
            {
              name: "series",
              category: 3,
              post_count: 0,
              is_deprecated: false,
            },
          ]),
        ),
    });
    assert.equal((await zero.verifyRankingTag("series")).post_count, 0);
  } finally {
    db.close();
  }
});
