import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFinalCatalog } from "../lib/catalogDb.js";
import {
  getRollStatus,
  claimDailyRolls,
  getClaimAvailability,
  getClaimStatus,
  nextClaimReset,
} from "../lib/characterRolls.js";
import { addActiveBuff } from "../lib/itemStorage.js";

const now = Date.parse("2026-11-04T02:00:00Z");
function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "affection-quota-"));
  const db = createFinalCatalog(join(path, "synthetic.sqlite"));
  t.after(() => {
    db.close();
    rmSync(path, { recursive: true, force: true });
  });
  return db;
}
function owned(db, index, total) {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')",
  ).run(id);
  db.prepare(
    "INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender) VALUES (?,?,0,?,'generated',?,'Female')",
  ).run(id, index, index, `Character ${index}`);
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
  ).run("1", id, "101", new Date(now).toISOString());
  db.prepare(
    "INSERT INTO character_affection(guild_id,user_id,character_id,total,updated_at) VALUES(?,?,?,?,?)",
  ).run("1", "101", id, total, now);
  return id;
}

test("owned affection roll contributions cap at five and are added after Rush", (t) => {
  const db = fixture(t);
  for (let i = 1; i <= 7; i++) owned(db, i, 200);
  assert.equal(getRollStatus(db, "1", "101", now).remaining, 12);
  addActiveBuff(
    db,
    "1",
    "101",
    "adrenaline_rush",
    JSON.stringify({ allowanceMultiplier: 2, durationMs: 3_600_000 }),
    now + 3_600_000,
  );
  assert.equal(getRollStatus(db, "1", "101", now).remaining, 19);
  assert.equal(claimDailyRolls(db, "1", "101", now).remaining, 19);
});

test("normal claim eligibility includes a capped affection reduction and stays read-only", (t) => {
  const db = fixture(t);
  for (let i = 1; i <= 12; i++) owned(db, i, 700);
  const claimedAt = now + 5 * 60_000;
  const period = Math.floor((claimedAt + 7 * 3_600_000) / (3 * 3_600_000));
  db.prepare("INSERT INTO claim_allowances VALUES(?,?,?)").run(
    "1",
    "101",
    period,
  );
  db.prepare("INSERT INTO claim_events VALUES(?,?,?)").run(
    "1",
    "101",
    claimedAt,
  );
  const availableAt = claimedAt + 2 * 3_600_000;
  assert.equal(
    getClaimAvailability(db, "1", "101", availableAt - 1).canClaim,
    false,
  );
  assert.equal(
    getClaimAvailability(db, "1", "101", availableAt).canClaim,
    true,
  );
  const before = db.prepare("SELECT total_changes() n").get().n;
  assert.equal(getClaimStatus(db, "1", "101", availableAt).canClaim, true);
  assert.equal(db.prepare("SELECT total_changes() n").get().n, before);
  assert.equal(nextClaimReset(availableAt, db, "1"), now + 3 * 3_600_000);
});
