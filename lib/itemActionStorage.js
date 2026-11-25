import { currentSeasonRows } from "./seasonSchema.js";
import { randomUUID } from "node:crypto";
import {
  captureAffectionItemUseInTransaction,
  hasItemAffection,
} from "./affectionItemUse.js";
import { getAffectionDecision } from "./affectionPerks.js";
import { isLegacyAffectionSource } from "./affectionSchema.js";

export function initItemActions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS item_actions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, inventory_id INTEGER NOT NULL, state TEXT NOT NULL,
      selections_json TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, deadline_at INTEGER, message_id TEXT,
      delivery_pending INTEGER NOT NULL DEFAULT 0, crown_json TEXT
    );
    CREATE TABLE IF NOT EXISTS item_action_costs (
      action_id TEXT NOT NULL, inventory_id INTEGER NOT NULL UNIQUE, snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_character_reservations (
      guild_id TEXT NOT NULL, character_id INTEGER NOT NULL, action_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, marriage_id INTEGER NOT NULL,
      PRIMARY KEY (guild_id, character_id)
    );
    CREATE TABLE IF NOT EXISTS counterfeit_crowns (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, character_id INTEGER NOT NULL,
      marriage_id INTEGER NOT NULL, generation_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS item_actions_pending ON item_actions(state, deadline_at);
  `);
}

/** Caller owns the transaction containing both action creation and its source hold. */
export function reserveItemActionSource(db, actionId, source, startedAt) {
  db.prepare("INSERT INTO item_action_costs VALUES(?,?,?)").run(
    actionId,
    source.id,
    JSON.stringify(source),
  );
  db.prepare(
    "INSERT INTO item_use_reservations(action_id,inventory_id,started_at) VALUES(?,?,?)",
  ).run(actionId, source.id, startedAt);
}

/** A reservation authorizes exactly one source charge, never the remaining inventory. */
export function getItemActionSource(db, action) {
  const hold = db
    .prepare(
      "SELECT * FROM item_action_costs WHERE action_id=? AND inventory_id=?",
    )
    .get(action.id, action.inventory_id);
  const reservation = db
    .prepare(
      "SELECT * FROM item_use_reservations WHERE action_id=? AND inventory_id=?",
    )
    .get(action.id, action.inventory_id);
  const source = db
    .prepare("SELECT * FROM user_inventory WHERE id=?")
    .get(action.inventory_id);
  if (
    (!hold && !reservation) ||
    !source ||
    source.guild_id !== action.guild_id ||
    source.user_id !== action.actor_id ||
    source.item_id !== action.kind ||
    source.charges < 1
  )
    return null;
  if (!hold) return source; // Versioned upgrade provenance for pre-rollout confirmations.
  const snapshot = JSON.parse(hold.snapshot_json);
  if (
    snapshot.id !== source.id ||
    snapshot.guild_id !== source.guild_id ||
    snapshot.user_id !== source.user_id ||
    snapshot.item_id !== source.item_id ||
    snapshot.charges < 1 ||
    source.charges !== snapshot.charges
  )
    return null;
  return source;
}

/** Caller must be inside the action transaction. No ordinary inventory bypass. */
export function consumeItemActionSource(db, action, options = {}) {
  const source = getItemActionSource(db, action);
  const binocularsDelivery =
    action.kind === "binoculars" &&
    action.state === "resolved" &&
    JSON.parse(action.result_json ?? "null")?.status === "dm_pending";
  if (
    !source ||
    (!["confirming", "awaiting_delivery"].includes(action.state) &&
      !binocularsDelivery)
  )
    throw new Error("Missing reserved action source");
  const selections =
    action.selections ?? JSON.parse(action.selections_json ?? "{}");
  // Missing saved terms on old delayed actions retains their original one-charge policy.
  if (
    !selections._affectionItemUse &&
    options.chance == null &&
    hasItemAffection(db) &&
    !isLegacyAffectionSource(db, "item_action", action.id)
  )
    throw new Error(
      "Missing captured item use terms; inspect before settlement",
    );
  const terms =
    selections._affectionItemUse ??
    (options.chance != null
      ? captureAffectionItemUseInTransaction(db, {
          sourceKey: action.id,
          guildId: action.guild_id,
          userId: action.actor_id,
          ...options,
        })
      : { actualDebit: 1, triggered: false });
  if (
    ![0, 1].includes(terms.actualDebit) ||
    (terms.version != null && terms.version !== 1)
  )
    throw new Error("Invalid saved item use cost");
  if (selections._affectionItemUse && hasItemAffection(db)) {
    const saved = getAffectionDecision(db, {
      sourceKey: action.id,
      guildId: action.guild_id,
      userId: action.actor_id,
      effect: "item_conservation",
    });
    if (
      !saved ||
      saved.chance !== terms.chance ||
      saved.triggered !== terms.triggered ||
      terms.actualDebit !== (saved.triggered ? 0 : 1)
    )
      throw new Error(
        "Corrupt captured item use decision; inspect before settlement",
      );
  }
  releaseItemActionSource(db, action.id);
  if (terms.actualDebit) {
    if (source.charges === 1)
      db.prepare("DELETE FROM user_inventory WHERE id=?").run(source.id);
    else
      db.prepare("UPDATE user_inventory SET charges=charges-1 WHERE id=?").run(
        source.id,
      );
  }
  return {
    actualDebit: terms.actualDebit,
    conserved: Boolean(terms.triggered),
  };
}

export function releaseItemActionSource(db, actionId) {
  db.prepare("DELETE FROM item_use_reservations WHERE action_id=?").run(
    actionId,
  );
  db.prepare("DELETE FROM item_action_costs WHERE action_id=?").run(actionId);
}

export function getItemAction(db, id) {
  const row = db
    .prepare(
      `SELECT * FROM ${currentSeasonRows(db, "item_actions")} WHERE id = ?`,
    )
    .get(id);
  return row
    ? {
        ...row,
        selections: JSON.parse(row.selections_json),
        result: row.result_json ? JSON.parse(row.result_json) : null,
      }
    : null;
}

export function getCounterfeitCrown(db, guildId, userId) {
  return (
    db
      .prepare(
        "SELECT * FROM counterfeit_crowns WHERE guild_id = ? AND user_id = ?",
      )
      .get(guildId, userId) ?? null
  );
}

export function setCounterfeitCrown(db, guildId, userId, character) {
  const generation = randomUUID();
  db.prepare(
    `INSERT INTO counterfeit_crowns VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(guild_id,user_id) DO UPDATE SET character_id=excluded.character_id,
    marriage_id=excluded.marriage_id,generation_id=excluded.generation_id`,
  ).run(
    guildId,
    userId,
    character.characterId,
    character.marriageId,
    generation,
  );
  return getCounterfeitCrown(db, guildId, userId);
}
