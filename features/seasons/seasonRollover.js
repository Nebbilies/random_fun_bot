import { transaction } from "../../lib/catalogDb.js";
import { seedSoulmateAffectionInTransaction } from "../../lib/characterAffection.js";
import { flushAffectionRewardsInTransaction } from "../../lib/affectionRewards.js";
import { getResolvedItemDefinitions } from "../../lib/itemRoster.js";
import { readProfileCollection } from "../../lib/profileCardData.js";
import { totalMarriedLeaderboard } from "../../lib/serverLeaderboard.js";
import {
  addSeasonMessage,
  recordSeasonPlayer,
  seasonPlayers,
} from "./seasonStore.js";

export function closingPlayerIds(db, guildId, season) {
  const owners = totalMarriedLeaderboard(db, guildId).map((row) => row.ownerId);
  return [...new Set([...seasonPlayers(db, guildId, season), ...owners])];
}

function archiveProfiles(db, guildId, season, members) {
  const leaderboard = totalMarriedLeaderboard(db, guildId);
  const scores = new Map(
    leaderboard.map(({ ownerId, score }) => [ownerId, score]),
  );
  const ranks = new Map(
    leaderboard
      .filter(({ ownerId }) => members.has(ownerId))
      .map(({ ownerId }, index) => [ownerId, index + 1]),
  );
  const save = db.prepare(
    "INSERT INTO season_profiles(guild_id,season,user_id,version,summary_json) VALUES (?,?,?,1,?)",
  );
  for (const userId of new Set([
    ...seasonPlayers(db, guildId, season),
    ...scores.keys(),
  ])) {
    const collection = readProfileCollection(db, guildId, userId);
    save.run(
      guildId,
      season,
      userId,
      JSON.stringify({
        ...collection,
        characterCount: scores.get(userId) ?? 0,
        serverRank: ranks.get(userId) ?? null,
      }),
    );
  }
}

function clearLiveState(db, guildId, keep, now) {
  db.prepare(
    "DELETE FROM item_use_reservations WHERE inventory_id IN (SELECT id FROM user_inventory WHERE guild_id=?)",
  ).run(guildId);
  db.prepare(
    "DELETE FROM fortune_recasts WHERE guild_id=? AND state IN ('pending','presented')",
  ).run(guildId);
  for (const table of [
    "fortune_holds",
    "fortune_armed",
    "item_character_reservations",
    "counterfeit_crowns",
    "character_protection_locks",
    "user_inventory",
    "user_inventory_limits",
    "active_user_buffs",
    "character_wishes",
    "treasure_puzzle_wins",
    "roll_allowances",
    "claim_allowances",
    "claim_events",
    "daily_roll_claims",
    "player_soulmates",
    "character_affection",
    "affection_entitlements",
    "season_soulmate_waivers",
  ])
    db.prepare(`DELETE FROM ${table} WHERE guild_id=?`).run(guildId);

  db.prepare(
    `DELETE FROM marriages WHERE guild_id=?
    AND id NOT IN (SELECT value FROM json_each(?))`,
  ).run(guildId, JSON.stringify(keep.map((row) => row.marriage_id)));
  // Ownership loss triggers still run, so clear their rollover output as well.
  db.prepare("DELETE FROM character_ownership_losses WHERE guild_id=?").run(
    guildId,
  );
  db.prepare(
    "UPDATE character_rolls SET state='closed',expires_at=? WHERE guild_id=? AND state IN ('pending','open')",
  ).run(now, guildId);
  db.prepare(
    `UPDATE mystery_sessions SET state='canceled',resolved_at=?,outcome='season_ended',next_at=NULL
    WHERE guild_id=? AND state IN ('reserved','running','countdown','claim_open')`,
  ).run(now, guildId);
  db.prepare(
    "UPDATE vault_sessions SET state='expired' WHERE guild_id=? AND state='unopened'",
  ).run(guildId);
  db.prepare(
    `UPDATE item_actions SET state='canceled',delivery_pending=0 WHERE guild_id=?
    AND state NOT IN ('completed','resolved','canceled','failed','expired')`,
  ).run(guildId);
  db.prepare(
    "UPDATE item_actions SET delivery_pending=0 WHERE guild_id=? AND delivery_pending<>0",
  ).run(guildId);
}

export function applySeasonRollover(
  db,
  { guildId, season, members, now = Date.now(), random = Math.random },
) {
  return transaction(db, () => {
    const rollover = db
      .prepare("SELECT * FROM season_rollovers WHERE guild_id=? AND season=?")
      .get(guildId, season);
    if (rollover?.phase === "applied")
      return { status: "already-applied", season: season + 1 };
    if (rollover?.phase !== "announced" || rollover.cutoff_at > now)
      return { status: "not-due" };
    const active = db
      .prepare("SELECT season FROM guild_seasons WHERE guild_id=?")
      .get(guildId);
    if (active?.season !== season)
      throw new Error("Season changed before rollover");

    const keep = db
      .prepare(
        `SELECT p.user_id,p.character_id,p.revision,m.id AS marriage_id,COALESCE(a.total,0) AS affection
      FROM player_soulmates p
      JOIN marriages m ON m.guild_id=p.guild_id AND m.owner_id=p.user_id AND m.character_id=p.character_id
      LEFT JOIN character_affection a ON a.guild_id=p.guild_id AND a.user_id=p.user_id AND a.character_id=p.character_id
      WHERE p.guild_id=?`,
      )
      .all(guildId)
      .filter((row) => members.has(row.user_id));
    archiveProfiles(db, guildId, season, members);
    db.prepare(
      "UPDATE guild_seasons SET season=?,started_at=? WHERE guild_id=?",
    ).run(season + 1, rollover.cutoff_at, guildId);
    clearLiveState(db, guildId, keep, now);

    const select = db.prepare(
      "INSERT INTO player_soulmates VALUES (?,?,?,?,0,?)",
    );
    const rewardRoster = keep.length
      ? getResolvedItemDefinitions(db, guildId)
      : [];
    for (const row of keep) {
      select.run(
        guildId,
        row.user_id,
        row.character_id,
        rollover.cutoff_at,
        row.revision + 1,
      );
      recordSeasonPlayer(db, guildId, row.user_id, now);
      seedSoulmateAffectionInTransaction(db, {
        guildId,
        userId: row.user_id,
        characterId: row.character_id,
        channelId: rollover.channel_id,
        season: season + 1,
        total: Math.floor(row.affection / 10),
        now,
        rewardRoster,
        random,
      });
      flushAffectionRewardsInTransaction(db, {
        guildId,
        userId: row.user_id,
        now,
      });
    }
    db.prepare(
      "UPDATE season_rollovers SET phase='applied',completed_at=? WHERE guild_id=? AND season=?",
    ).run(now, guildId, season);
    addSeasonMessage(db, rollover, "start");
    return { status: "applied", season: season + 1, carried: keep.length };
  });
}
