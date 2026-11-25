import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog } from "../lib/catalogDb.js";
import { clueRevealEvent } from "../lib/mysteryEvents/clueReveal.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "clue-reveal-"));
  const db = openCatalog(join(dir, "catalog.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (1, 50, 100, 'Hero');
    INSERT INTO anime (id, title_romaji, title_english, synonyms, genres, tags, season_year,
      format, popularity, is_adult, fetched_at) VALUES
      (10, 'Hoshi no Monogatari', 'Star Chronicle', '["Tales of Stars"]',
        '["Adventure","Fantasy"]', '[{"name":"Space","rank":90}]', 2018,
        'TV', 1000, 0, 'now'),
      (11, 'Star Movie', 'Star Chronicle Movie', '[]',
        '["Adventure"]', '[{"name":"Space","rank":90}]', 2019,
        'MOVIE', 5000, 0, 'now'),
      (12, 'Other Stars', 'Star Chronicles', '[]',
        '["Adventure"]', '[{"name":"Space","rank":90}]', 2018,
        'TV', 500, 0, 'now');
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 10), (1, 11);`);
  return db;
}

test("leading linked TV anime supplies five safe staged clues", (t) => {
  const db = fixture(t);
  const ctx = { db, character: { id: 1 }, now: 1000 };
  assert.equal(clueRevealEvent.available(ctx), true);
  const started = clueRevealEvent.start(ctx);
  assert.equal(started.state.animeId, 10);
  assert.equal(started.durationMs, 90_000);
  assert.equal(started.nextInMs, 18_000);
  assert.match(started.view.text, /Format: TV/);
  assert.doesNotMatch(started.view.text, /Star Chronicle/);
  const next = clueRevealEvent.advance({
    db,
    state: started.state,
    input: { type: "timer" },
    now: 19_000,
  });
  assert.equal(next.state.stage, 1);
  assert.match(next.view.text, /Year: 2018/);
  const last = clueRevealEvent.advance({
    db,
    state: next.state,
    input: { type: "timer" },
    now: 73_000,
  });
  assert.equal(last.state.stage, 4);
  assert.match(last.view.text, /Title hint/);
  const expired = clueRevealEvent.advance({
    db,
    state: last.state,
    input: { type: "timer" },
    now: 91_000,
  });
  assert.deepEqual(expired.outcome, {
    type: "no_winner",
    answer: "Star Chronicle",
  });
});

test("alternate titles and small typos win, while wrong guesses lock until next clue", (t) => {
  const db = fixture(t);
  const state = clueRevealEvent.start({
    db,
    character: { id: 1 },
    now: 1000,
  }).state;
  const exact = clueRevealEvent.advance({
    db,
    state,
    input: { type: "answer", userId: "2", value: "tales-of stars" },
    now: 2000,
  });
  assert.deepEqual(exact.outcome, {
    type: "winner",
    userId: "2",
    answer: "Star Chronicle",
  });
  const typo = clueRevealEvent.advance({
    db,
    state,
    input: { type: "answer", userId: "3", value: "Tales of Starz" },
    now: 2000,
  });
  assert.equal(typo.outcome?.type, "winner");
  const wrong = clueRevealEvent.advance({
    db,
    state,
    input: { type: "answer", userId: "4", value: "Star Chronicles" },
    now: 2000,
  });
  assert.equal(wrong.feedback, "wrong");
  const locked = clueRevealEvent.advance({
    db,
    state: wrong.state,
    input: { type: "answer", userId: "4", value: "Star Chronicle" },
    now: 3000,
  });
  assert.equal(locked.feedback, "already_guessed");
  const next = clueRevealEvent.advance({
    db,
    state: locked.state,
    input: { type: "timer" },
    now: 19_000,
  });
  const unlocked = clueRevealEvent.advance({
    db,
    state: next.state,
    input: { type: "answer", userId: "4", value: "Star Chronicle" },
    now: 20_000,
  });
  assert.equal(unlocked.outcome?.type, "winner");
});

test("missing clue metadata makes the event unavailable", (t) => {
  const db = fixture(t);
  db.prepare("UPDATE anime SET tags = '[]' WHERE id = 10").run();
  assert.equal(clueRevealEvent.available({ db, character: { id: 1 } }), false);
  assert.equal(
    clueRevealEvent.start({ db, character: { id: 1 }, now: 1000 }),
    null,
  );
});
