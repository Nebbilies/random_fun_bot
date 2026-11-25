import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createFinalCatalog,
  openCatalog,
  openCatalogReadOnly,
  openFinalCatalog,
} from "../lib/catalogDb.js";
import { installEmptyFinalCatalog } from "../lib/catalogFinalSchema.js";
import { pruneSeasonReceipts } from "../features/seasons/seasonPruning.js";

test("writable startup recognizes existing players as Season 0 and preserves their progress", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "season-migration-"));
  const path = join(directory, "game.sqlite");
  const connections = [];
  t.after(() => {
    for (const connection of connections.reverse()) connection.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const previous = new DatabaseSync(path);
  installEmptyFinalCatalog(previous);
  previous.exec(`
    INSERT INTO guild_prefixes VALUES ('20','!');
    INSERT INTO roll_allowances VALUES ('10','101',123,4);
    INSERT INTO claim_allowances VALUES ('10','102',456);
  `);
  previous.close();

  const first = openCatalog(path);
  connections.push(first);
  const second = openFinalCatalog(path);
  connections.push(second);
  const reader = openCatalogReadOnly(path);
  connections.push(reader);
  for (const db of [first, second, reader]) {
    assert.deepEqual(
      db
        .prepare("SELECT guild_id AS guild, season FROM guild_seasons")
        .all()
        .map((row) => ({ ...row })),
      [{ guild: "10", season: 0 }],
    );
    assert.deepEqual(
      db
        .prepare("SELECT user_id FROM season_players ORDER BY user_id")
        .all()
        .map((row) => row.user_id),
      ["101", "102"],
    );
    assert.equal(db.prepare("SELECT used FROM roll_allowances").get().used, 4);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  }
});

test("background pruning leaves its work queued when the database already has a writer", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "season-pruning-"));
  const path = join(directory, "game.sqlite");
  const db = createFinalCatalog(path);
  const writer = new DatabaseSync(path);
  t.after(() => {
    writer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=20;
    INSERT INTO roll_allowances VALUES ('10','101',123,1);
    INSERT INTO affection_requests VALUES ('old','10','101','90','{}',1);
    UPDATE guild_seasons SET season=2 WHERE guild_id='10';
    INSERT INTO season_rollovers(guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester)
      VALUES ('10',1,1,'applied','90',1,2,'admin');
  `);
  writer.exec("BEGIN IMMEDIATE");
  assert.equal(pruneSeasonReceipts(db), 0);
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 20);
  assert.equal(
    db.prepare("SELECT pruned_at FROM season_rollovers").get().pruned_at,
    null,
  );
  writer.exec("ROLLBACK");
  assert.equal(pruneSeasonReceipts(db), 1);
});
