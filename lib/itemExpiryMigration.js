import {
  INVENTORY_EXPIRY_COLUMN,
  ITEM_EXPIRY_DDL,
} from "./itemExpirySchema.js";
import { getItemExpiryDeadline } from "./itemExpiry.js";
import { isDeepStrictEqual } from "node:util";

/** Caller owns the schema-gated write transaction. No deletion or acquisition events. */
export function migrateItemExpiry(db, { now = Date.now() } = {}) {
  if (
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name='item_expiry_schema'")
      .get()
  )
    return;
  if (!Number.isSafeInteger(now) || now < 0)
    throw new Error("Invalid item expiry rollout time");
  const inventory = db.prepare("SELECT * FROM user_inventory").all();
  const byId = new Map(inventory.map((row) => [row.id, row]));
  const deadlines = new Map(
    inventory.map((row) => [
      row.id,
      getItemExpiryDeadline(db, row.guild_id, row.item_id, now),
    ]),
  );
  // Validate exact historical escrow before rewriting it. Unknown or mixed shapes fail closed.
  const snapshots = db
    .prepare("SELECT * FROM item_action_costs")
    .all()
    .map((cost) => {
      const source = byId.get(cost.inventory_id);
      let snapshot;
      try {
        snapshot = JSON.parse(cost.snapshot_json);
      } catch {
        throw new Error(`Invalid item expiry escrow ${cost.action_id}`);
      }
      if (!source || !isDeepStrictEqual(snapshot, { ...source }))
        throw new Error(
          `Item expiry escrow ${cost.action_id}: source snapshot mismatch`,
        );
      return { ...cost, snapshot };
    });
  db.exec(`ALTER TABLE user_inventory ADD COLUMN ${INVENTORY_EXPIRY_COLUMN}`);
  for (const [id, deadline] of deadlines)
    db.prepare("UPDATE user_inventory SET expires_at=? WHERE id=?").run(
      deadline,
      id,
    );
  db.exec(ITEM_EXPIRY_DDL);
  db.prepare("INSERT INTO item_expiry_schema VALUES(1,?)").run(now);
  for (const cost of snapshots)
    db.prepare(
      "UPDATE item_action_costs SET snapshot_json=? WHERE action_id=? AND inventory_id=?",
    ).run(
      JSON.stringify({
        ...cost.snapshot,
        expires_at: deadlines.get(cost.inventory_id),
      }),
      cost.action_id,
      cost.inventory_id,
    );
  // Durable Fortune/Hostage holds outrank prompts, regardless of prompt age.
  // Keep their provenance intact; never release another action's escrow.
  const escrowOwners = new Map(
    snapshots.map((cost) => [cost.inventory_id, cost.action_id]),
  );
  const hasFortuneHolds = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='fortune_holds'",
    )
    .get();
  const fortuneSources = new Set(
    hasFortuneHolds
      ? db
          .prepare("SELECT inventory_id FROM fortune_holds")
          .all()
          .map((row) => row.inventory_id)
      : [],
  );
  const reservedSources = new Set();
  const cancel = (action, reason) =>
    db
      .prepare(
        `UPDATE item_actions
    SET state='canceled', result_json=?, delivery_pending=1 WHERE id=?`,
      )
      .run(
        JSON.stringify({
          status: "canceled",
          message: `Canceled during item expiry upgrade: ${reason}. No cost.`,
        }),
        action.id,
      );
  for (const action of db
    .prepare(
      "SELECT * FROM item_actions WHERE state='confirming' ORDER BY created_at, id",
    )
    .all()) {
    const source = byId.get(action.inventory_id);
    if (!source) {
      cancel(action, "the source inventory entry is missing");
      continue;
    }
    // A different owner/kind is ambiguous corruption, not an ordinary spent source.
    if (
      source.guild_id !== action.guild_id ||
      source.user_id !== action.actor_id ||
      source.item_id !== action.kind
    ) {
      throw new Error(
        `Item expiry action ${action.id}: missing or invalid source`,
      );
    }
    if (source.charges <= 0) {
      cancel(action, "the source inventory entry is already spent");
      continue;
    }
    const escrowOwner = escrowOwners.get(source.id);
    if (
      fortuneSources.has(source.id) ||
      (escrowOwner !== undefined && escrowOwner !== action.id)
    ) {
      cancel(
        action,
        "this inventory entry is already held by Fortune or a Hostage action",
      );
      continue;
    }
    if (escrowOwner === action.id) continue; // Its existing escrow is already authority.
    if (reservedSources.has(source.id)) {
      cancel(
        action,
        "another confirmation already reserves this inventory entry",
      );
      continue;
    }
    db.prepare("INSERT INTO item_use_reservations VALUES(?,?,?)").run(
      action.id,
      source.id,
      action.created_at,
    );
    reservedSources.add(source.id);
  }
}
