import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeLegacyCatalog } from "../lib/catalogDb.js";
import { cleanupRolls } from "../lib/characterRolls.js";
import {
  createVaultAbandonmentEntry,
  inspectLegacyVaultAbandonment,
  LEGACY_VAULT_ABANDONMENT_KEY,
} from "../lib/legacyVaultAbandonment.js";

const protectedIds = [17317, 17358];
const now = 2 * 3_600_000;

function fixture(t, evidence = true) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  initializeLegacyCatalog(db);
  // Same unbound legacy-vault shape as the abandonment operation fixtures,
  // with actual publication times so report-expiry cleanup reaches these rows.
  for (const id of [...protectedIds, 16994]) {
    db.prepare(
      `INSERT INTO character_rolls
      (id,guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
      VALUES(?,'1','10',?,0,'vault','vault',100)`,
    ).run(id, String(id + 100000));
  }
  db.exec(`INSERT INTO character_rolls
    (id,guild_id,channel_id,command_message_id,character_id,character_name,state,published_at,expires_at)
    VALUES(18000,'1','10','999001',7,'Synthetic','closed',100,200);
    INSERT INTO roll_notices(roll_id,user_id) VALUES(17317,'101'),(16994,'101'),(18000,'101');`);
  if (evidence) {
    const entries = protectedIds.map((id) =>
      createVaultAbandonmentEntry(
        db,
        db.prepare("SELECT * FROM character_rolls WHERE id=?").get(id),
        {
          reason: "Explicit abandonment without compensation",
          operator: "synthetic",
          operationId: "12345678-1234-4123-8123-123456789abc",
          sourceSha256: "a".repeat(64),
          acknowledgedAt: 1000,
        },
      ),
    );
    db.prepare("INSERT INTO catalog_meta(key,value) VALUES(?,?)").run(
      LEGACY_VAULT_ABANDONMENT_KEY,
      JSON.stringify({ version: 1, entries }),
    );
    assert.deepEqual(inspectLegacyVaultAbandonment(db), {
      ids: new Set(protectedIds),
      blockers: [],
    });
  }
  return db;
}

const rows = (db) =>
  db.prepare("SELECT * FROM character_rolls ORDER BY id").all();
const notices = (db) =>
  db.prepare("SELECT * FROM roll_notices ORDER BY roll_id,user_id").all();
const evidenceValue = (db) =>
  db
    .prepare("SELECT value FROM catalog_meta WHERE key=?")
    .get(LEGACY_VAULT_ABANDONMENT_KEY).value;

test("cleanup retains validated abandonment rows and exact evidence after report expiry", (t) => {
  const db = fixture(t);
  const before = rows(db).filter((row) => protectedIds.includes(row.id));
  const evidence = evidenceValue(db);
  assert.equal(cleanupRolls(db, now), 2);
  assert.deepEqual(rows(db), before);
  assert.deepEqual(
    notices(db).map((row) => row.roll_id),
    [17317],
  );
  assert.equal(evidenceValue(db), evidence);
  assert.deepEqual(inspectLegacyVaultAbandonment(db), {
    ids: new Set(protectedIds),
    blockers: [],
  });
  assert.equal(cleanupRolls(db, now + 24 * 3_600_000), 0);
  assert.deepEqual(inspectLegacyVaultAbandonment(db), {
    ids: new Set(protectedIds),
    blockers: [],
  });
});

test("without abandonment evidence even allowlisted expired vault rows are cleaned up", (t) => {
  const db = fixture(t, false);
  assert.equal(cleanupRolls(db, now), 4);
  assert.deepEqual(rows(db), []);
  assert.deepEqual(notices(db), []);
});

for (const variant of [
  "malformed",
  "corrupt-second-entry",
  "stale-row",
  "missing-row",
]) {
  test(`cleanup fails closed without deleting anything for ${variant} evidence`, (t) => {
    const db = fixture(t);
    if (variant === "malformed") {
      db.prepare("UPDATE catalog_meta SET value=? WHERE key=?").run(
        "{",
        LEGACY_VAULT_ABANDONMENT_KEY,
      );
    } else if (variant === "corrupt-second-entry") {
      const contract = JSON.parse(evidenceValue(db));
      contract.entries[1].fingerprint = "0".repeat(64);
      db.prepare("UPDATE catalog_meta SET value=? WHERE key=?").run(
        JSON.stringify(contract),
        LEGACY_VAULT_ABANDONMENT_KEY,
      );
    } else if (variant === "stale-row") {
      db.exec(
        "UPDATE character_rolls SET message_id='123456789' WHERE id=17358",
      );
    } else {
      db.exec("DELETE FROM character_rolls WHERE id=17358");
    }
    assert.ok(inspectLegacyVaultAbandonment(db).blockers.length);
    const before = rows(db),
      beforeNotices = notices(db),
      evidence = evidenceValue(db);
    assert.throws(
      () => cleanupRolls(db, now),
      /Invalid legacy vault abandonment evidence/,
    );
    assert.deepEqual(rows(db), before);
    assert.deepEqual(notices(db), beforeNotices);
    assert.equal(evidenceValue(db), evidence);
  });
}
