import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { ComponentType, MessageFlags } from "discord.js";
import { installWeeklyEventSchema } from "../lib/weeklyEventSchema.js";
import { createFinalCatalog } from "../lib/catalogDb.js";
import { createReviewServer } from "../web/reviewCharacterTags.js";
import { authConfig, authenticatedFetch } from "./helpers/portalAuth.js";
import { run as weeklyCommand } from "../commands/weekly.js";
import {
  reserveRoll,
  publishRoll,
  claimRoll,
  getRoll,
  publishMysteryIntro,
} from "../lib/characterRolls.js";
import {
  advanceMysteryEvent,
  beginMysteryEvent,
  reserveMysteryAwareRoll,
} from "../lib/mysteryCoordinator.js";
import { addWish } from "../lib/characterWishlist.js";
import {
  confirmSoulmate,
  getAffectionTotal,
} from "../lib/characterAffection.js";
import { getClaimStatus } from "../features/rolls/rollAllowanceService.js";
import { getConfigView, saveConfigSection } from "../lib/gameConfig.js";
import { transferCharacter } from "../lib/characterTrade.js";
import { createItemAction, activateItemAction } from "../lib/itemActions.js";
import { addItemToInventory, getInventory } from "../lib/itemStorage.js";
import { ITEM_TIERS, getResolvedItemDefinition } from "../lib/itemRoster.js";
import { decideVaultReward, revealVaultReward } from "../lib/vaultRewards.js";
import {
  reserveWeeklyMysteryVaults,
  inspectVaultSessions,
  bindVaultSessionMessage,
} from "../lib/vaultSessions.js";
import { runWeeklyWork } from "../features/weeklyEvents/weeklyRuntime.js";
import { runSeasonWork } from "../features/seasons/seasonRuntime.js";
import {
  setWeeklyControls,
  advanceWeeklyContest,
  scoreWeekly,
  scoreWeeklyGain,
  settleWeeklyContest,
  weeklyView,
  weeklyPrize,
  tryWeeklyClaimReset,
} from "../features/weeklyEvents/weeklyEvents.js";

const sunday = Date.parse("2026-11-28T17:00:00Z");
const week = 7 * 86_400_000;

function catalog(t) {
  const dir = mkdtempSync(join(tmpdir(), "weekly-event-"));
  const db = createFinalCatalog(join(dir, "weekly.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const characterId = "12345678-1234-4123-8123-123456789abc";
function addCharacter(db, id = characterId, rank = 1) {
  db.prepare(
    "INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')",
  ).run(id);
  db.prepare(
    "INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender) VALUES(?,?,0,?,'generated','Weekly test','Female')",
  ).run(id, rank, rank);
}

function winWeek(db, theme, userId = "10", repeat = false) {
  setWeeklyControls(db, {
    guildId: "1",
    enabled: true,
    channelId: "2",
    nextTheme: theme,
    now: sunday - 1,
  });
  const first = advanceWeeklyContest(db, "1", sunday);
  scoreWeekly(db, {
    guildId: "1",
    userId,
    theme,
    characterId,
    key: "setup-win",
    now: sunday + 1,
  });
  if (repeat)
    setWeeklyControls(db, {
      guildId: "1",
      enabled: true,
      channelId: "2",
      nextTheme: theme,
      now: sunday + 2,
    });
  advanceWeeklyContest(db, "1", sunday + week);
  settleWeeklyContest(db, first.id, new Set([userId]));
}

test("an enabled server opens at the next Sunday, scores once and awards a fixed prize week", () => {
  const db = new DatabaseSync(":memory:");
  try {
    installWeeklyEventSchema(db);
    const sunday = Date.parse("2026-11-28T17:00:00Z");
    const next = sunday + 7 * 86400000;
    assert.equal(weeklyView(db, "1", "10", sunday).contest, null);
    setWeeklyControls(db, {
      guildId: "1",
      enabled: true,
      channelId: "2",
      nextTheme: "wishes",
      now: sunday - 1000,
    });
    assert.equal(advanceWeeklyContest(db, "1", sunday - 1), null);
    const contest = advanceWeeklyContest(db, "1", sunday);
    assert.equal(contest.theme, "wishes");
    for (const [userId, key] of [
      ["10", "a"],
      ["10", "a"],
      ["11", "b"],
    ]) {
      scoreWeekly(db, {
        guildId: "1",
        userId,
        theme: "wishes",
        key,
        now: sunday + 1,
      });
    }
    assert.equal(weeklyView(db, "1", "10", sunday + 1).rank, 1);
    assert.equal(weeklyView(db, "1", "10", sunday + 1).score, 1);
    assert.equal(weeklyView(db, "2", "10", sunday + 1).contest, null);
    advanceWeeklyContest(db, "1", next, () => 0);
    settleWeeklyContest(db, contest.id, new Set(["10", "11"]));
    assert.equal(weeklyPrize(db, "1", "10", "wishes", next).wishMultiplier, 2);
    assert.equal(
      weeklyPrize(db, "1", "10", "wishes", next + 7 * 86400000),
      null,
    );
  } finally {
    db.close();
  }
});

test("the weekly prefix command displays current rules, leaders and the caller score", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    installWeeklyEventSchema(db);
    const now = Date.now();
    setWeeklyControls(db, {
      guildId: "1",
      enabled: true,
      channelId: "2",
      nextTheme: "wishes",
      now: now - 7 * 86400000,
    });
    scoreWeekly(db, {
      guildId: "1",
      userId: "10",
      theme: "wishes",
      key: "one",
      now,
    });
    let reply;
    await weeklyCommand({
      yoshiko: { catalogDb: db },
      message: {
        guildId: "1",
        author: { id: "10" },
        reply: (payload) => {
          reply = payload;
        },
      },
    });
    assert.equal(reply.flags, MessageFlags.IsComponentsV2);
    assert.deepEqual(reply.allowedMentions, { parse: [], repliedUser: false });
    const card = reply.components[0].toJSON();
    assert.equal(card.type, ComponentType.Container);
    assert.equal(card.accent_color, 0x9e598f);
    assert.deepEqual(
      card.components.map(({ type }) => type),
      [
        ComponentType.TextDisplay,
        ComponentType.Separator,
        ComponentType.TextDisplay,
        ComponentType.Separator,
        ComponentType.TextDisplay,
        ComponentType.Separator,
        ComponentType.TextDisplay,
      ],
    );
    const [header, prize, leaderboard, standing] = card.components
      .filter(({ type }) => type === ComponentType.TextDisplay)
      .map(({ content }) => content);
    assert.match(header, /^-# Weekly Event\n## Wish Upon a Roll\n/);
    assert.match(header, /Ends <t:\d+:F>$/);
    assert.match(prize, /2× roll chance/);
    assert.equal(leaderboard, "**Leaderboard**\n1. <@10> (**1 point**)");
    assert.equal(
      standing,
      "**Your standing**\nYou’re **#1** with **1 point**.",
    );
  } finally {
    db.close();
  }
});

test("Franchise Collector counts distinct gains and consumes a failed claim check", () => {
  const db = new DatabaseSync(":memory:");
  try {
    installWeeklyEventSchema(db);
    db.exec(`CREATE TABLE effective_character_franchises(character_id TEXT,franchise_id TEXT);
      INSERT INTO effective_character_franchises VALUES ('a','f'),('a','g'),('b','f');`);
    const sunday = Date.parse("2026-11-28T17:00:00Z");
    const next = sunday + 7 * 86400000;
    setWeeklyControls(db, {
      guildId: "1",
      enabled: true,
      channelId: "2",
      nextTheme: "franchise",
      now: sunday - 1,
    });
    const contest = advanceWeeklyContest(db, "1", sunday);
    for (const [characterId, key] of [
      ["a", "one"],
      ["a", "two"],
      ["b", "three"],
    ]) {
      scoreWeeklyGain(db, "1", "10", characterId, key, sunday + 1);
    }
    assert.equal(weeklyView(db, "1", "10", sunday + 1).score, 2);
    advanceWeeklyContest(db, "1", next);
    settleWeeklyContest(db, contest.id, new Set(["10"]));
    assert.equal(
      tryWeeklyClaimReset(db, "1", "10", 20, next, () => 0.9),
      false,
    );
    assert.equal(
      tryWeeklyClaimReset(db, "1", "10", 20, next, () => 0),
      false,
    );
    assert.equal(
      tryWeeklyClaimReset(db, "1", "10", 21, next, () => 0),
      true,
    );
  } finally {
    db.close();
  }
});

test("a finalized roll with multiple wish matches scores one point for the roller", (t) => {
  const db = catalog(t);
  const id = characterId;
  addCharacter(db, id);
  setWeeklyControls(db, {
    guildId: "1",
    enabled: true,
    channelId: "2",
    nextTheme: "wishes",
    now: sunday - 1000,
  });
  for (const userId of ["10", "11"])
    addWish(db, { guildId: "1", userId, characterId: id, now: sunday });
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "2",
    userId: "10",
    commandMessageId: "20",
    pool: "w",
    now: sunday,
    random: () => 0.9,
  });
  assert.equal(weeklyView(db, "1", "10", sunday).score, 0);
  assert.equal(publishRoll(db, roll.rollId, "21", sunday + 1), true);
  assert.equal(publishRoll(db, roll.rollId, "21", sunday + 2), false);
  assert.equal(weeklyView(db, "1", "10", sunday + 2).score, 1);
  assert.equal(weeklyView(db, "1", "11", sunday + 2).score, 0);
});

test("a trade of an opening character away and back adds one franchise point", (t) => {
  const db = catalog(t);
  addCharacter(db);
  const id = db
    .prepare(
      "INSERT INTO franchises(display_name,created_at) VALUES('Franchise','test')",
    )
    .run().lastInsertRowid;
  db.prepare("INSERT INTO character_franchise_memberships VALUES(?,?)").run(
    characterId,
    id,
  );
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
  ).run("1", characterId, "10", new Date(sunday - 10_000).toISOString());
  setWeeklyControls(db, {
    guildId: "1",
    enabled: true,
    channelId: "2",
    nextTheme: "franchise",
    now: sunday - 1000,
  });
  assert.equal(weeklyView(db, "1", "10", sunday).score, 0);
  for (const [fromOwnerId, toOwnerId, now] of [
    ["10", "11", sunday + 1],
    ["11", "10", sunday + 2],
    ["10", "11", sunday + 3],
    ["11", "10", sunday + 4],
  ]) {
    assert.equal(
      transferCharacter(db, {
        guildId: "1",
        characterId,
        fromOwnerId,
        toOwnerId,
        now,
      }).status,
      "transferred",
    );
  }
  assert.equal(weeklyView(db, "1", "10", sunday + 5).score, 1);
  assert.equal(weeklyView(db, "1", "11", sunday + 5).score, 1);
});

test("the affection prize increases a finalized roll award without a duplicate award", (t) => {
  const db = catalog(t);
  addCharacter(db);
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
  ).run("1", characterId, "10", new Date(sunday - 1000).toISOString());
  winWeek(db, "affection");
  const now = sunday + week + 1;
  const result = reserveRoll(db, {
    guildId: "1",
    channelId: "2",
    userId: "10",
    commandMessageId: "30",
    pool: "w",
    now,
    random: () => 0.9,
  });
  assert.equal(publishRoll(db, result.rollId, "31", now + 1), true);
  assert.equal(publishRoll(db, result.rollId, "31", now + 2), false);
  assert.equal(getAffectionTotal(db, "1", "10", characterId), 130);
});

test("Unbroken Bond and the Weekly Event prize credit 260, limited by the character cap", (t) => {
  const db = catalog(t);
  addCharacter(db);
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
  ).run("1", characterId, "10", new Date(sunday - 1000).toISOString());
  db.prepare("INSERT INTO character_affection VALUES(?,?,?,?,?)").run(
    "1",
    "10",
    characterId,
    200,
    sunday,
  );
  confirmSoulmate(db, { guildId: "1", userId: "10", characterId, now: sunday });
  winWeek(db, "affection", "10", true);
  const time = sunday + week + 1;
  const publish = (commandMessageId, messageId, now) => {
    const roll = reserveRoll(db, {
      guildId: "1",
      channelId: "2",
      userId: "10",
      commandMessageId,
      pool: "w",
      now,
      random: () => 0,
    });
    assert.equal(publishRoll(db, roll.rollId, messageId, now + 1), true);
  };
  publish("30", "40", time);
  assert.equal(getAffectionTotal(db, "1", "10", characterId), 460);
  assert.equal(weeklyView(db, "1", "10", time + 1).score, 260);
  db.prepare(
    "UPDATE character_affection SET total=2050 WHERE guild_id='1' AND user_id='10'",
  ).run();
  publish("31", "41", time + 2);
  assert.equal(getAffectionTotal(db, "1", "10", characterId), 2100);
  assert.equal(weeklyView(db, "1", "10", time + 3).score, 310);
  const award = db
    .prepare(
      "SELECT amount, milestones_json FROM affection_awards ORDER BY rowid DESC LIMIT 1",
    )
    .get();
  assert.equal(award.amount, 50);
  assert.ok(
    JSON.parse(award.milestones_json).some(
      (milestone) => milestone.threshold === 2100,
    ),
  );
});

test("the reclaim prize automatically closes an escape for its owner", (t) => {
  const db = catalog(t);
  addCharacter(db);
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
  ).run("1", characterId, "10", new Date(sunday - 1000).toISOString());
  winWeek(db, "reclaims");
  const now = sunday + week + 1;
  const result = reserveRoll(db, {
    guildId: "1",
    channelId: "2",
    userId: "11",
    commandMessageId: "30",
    pool: "w",
    now,
    random: () => 0.9,
  });
  assert.equal(
    publishRoll(db, result.rollId, "31", now + 1, () => 0),
    true,
  );
  assert.equal(getRoll(db, "1", "2", "31").escapeOutcome, "reclaimed");
  assert.equal(
    claimRoll(db, {
      guildId: "1",
      channelId: "2",
      messageId: "31",
      userId: "11",
      now: now + 2,
    }).status,
    "closed",
  );
});

test("a successful franchise prize restores only the first normal claim spent", (t) => {
  const db = catalog(t);
  addCharacter(db);
  addCharacter(db, "12345678-1234-4123-8123-123456789abd", 2);
  const id = db
    .prepare(
      "INSERT INTO franchises(display_name,created_at) VALUES('Franchise','test')",
    )
    .run().lastInsertRowid;
  db.prepare("INSERT INTO character_franchise_memberships VALUES(?,?)").run(
    characterId,
    id,
  );
  saveConfigSection(db, {
    section: "weeklyEvents",
    expectedRevision: getConfigView(db).revision,
    values: { "weeklyEvents.claimChance": 1 },
  });
  winWeek(db, "franchise");
  const now = sunday + week + 1;
  for (let i = 0; i < 2; i++) {
    const time = now + i * 10;
    const result = reserveRoll(db, {
      guildId: "1",
      channelId: "2",
      userId: "11",
      commandMessageId: String(30 + i),
      pool: "w",
      now: time,
      random: () => (i ? 0.99 : 0.25),
    });
    assert.equal(
      publishRoll(db, result.rollId, String(40 + i), time + 1),
      true,
    );
    assert.equal(
      claimRoll(db, {
        guildId: "1",
        channelId: "2",
        messageId: String(40 + i),
        userId: "10",
        now: time + 2,
      }).status,
      "married",
    );
    assert.equal(getClaimStatus(db, "1", "10", time + 3).canClaim, i === 0);
  }
});

test("a bonus vault survives delivery delay and gets one opening window", (t) => {
  const db = catalog(t);
  const session = { id: 3, guildId: "1", eventChannelId: "2" };
  reserveWeeklyMysteryVaults(db, session, "10", 1, sunday);
  reserveWeeklyMysteryVaults(db, session, "10", 1, sunday);
  const [vault, duplicate] = inspectVaultSessions(db, {
    now: sunday + 120_000,
  });
  assert.equal(duplicate, undefined);
  assert.equal(vault.paidRollId, null);
  const placed = bindVaultSessionMessage(
    db,
    vault.vaultId,
    "20",
    null,
    sunday + 120_005,
    sunday + 120_000,
  );
  assert.equal(placed.deadline, sunday + 180_000);
  assert.equal(
    bindVaultSessionMessage(db, vault.vaultId, "21", "20", sunday + 125_000)
      .deadline,
    placed.deadline,
  );
});

test("a genuine mystery win scores and reserves one free vault alongside consolation", (t) => {
  const db = catalog(t);
  addCharacter(db);
  winWeek(db, "mystery", "10", true);
  const now = sunday + week + 1;
  addItemToInventory(db, "1", "10", "consolation_chit", 1, { now });
  db.prepare("INSERT INTO claim_allowances VALUES(?,?,?)").run(
    "1",
    "10",
    Math.floor((now + 420 * 60_000) / 10_800_000),
  );
  const roll = reserveMysteryAwareRoll(db, {
    guildId: "1",
    channelId: "2",
    userId: "10",
    commandMessageId: "100",
    pool: "w",
    now,
    random: () => 0,
    mysteryEnabled: true,
  });
  assert.equal(roll.eventId, "doors");
  assert.equal(publishMysteryIntro(db, roll.sessionId, "101", now + 1), true);
  assert.equal(
    beginMysteryEvent(db, roll.sessionId, now + 5001, () => 0).status,
    "started",
  );
  const request = {
    sessionId: roll.sessionId,
    guildId: "1",
    channelId: "2",
    input: { type: "button", userId: "10", value: "1" },
    now: now + 5002,
    random: () => 0.6,
  };
  assert.equal(advanceMysteryEvent(db, request).status, "winner");
  advanceMysteryEvent(db, request);
  assert.equal(weeklyView(db, "1", "10", now + 5003).score, 1);
  assert.equal(inspectVaultSessions(db, { now: now + 5003 }).length, 1);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) count FROM reward_sources WHERE source_kind='mystery_consolation'",
      )
      .get().count,
    1,
  );
});

test("forced divorce scores once and an earned extra charge survives overflow past expiry", (t) => {
  const db = catalog(t);
  addCharacter(db);
  db.prepare(
    "INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)",
  ).run("1", characterId, "11", new Date(sunday - 1000).toISOString());
  setWeeklyControls(db, {
    guildId: "1",
    enabled: true,
    channelId: "2",
    nextTheme: "steals",
    now: sunday - 1,
  });
  const opening = advanceWeeklyContest(db, "1", sunday);
  const item = addItemToInventory(db, "1", "10", "severed_fate", 1, {
    now: sunday,
  }).item;
  const action = createItemAction(db, {
    guildId: "1",
    actorId: "10",
    channelId: "2",
    inventoryId: item.id,
    now: sunday,
    selections: { targets: [{ characterId, ownerId: "11", marriageId: 1 }] },
  });
  const use = {
    actionId: action.id,
    guildId: "1",
    actorId: "10",
    now: sunday + 1,
  };
  assert.equal(activateItemAction(db, use).status, "resolved");
  activateItemAction(db, use);
  assert.equal(weeklyView(db, "1", "10", sunday + 2).score, 1);
  advanceWeeklyContest(db, "1", sunday + week);
  settleWeeklyContest(db, opening.id, new Set(["10"]));
  const time = sunday + 2 * week - 1;
  for (let i = 0; i < 5; i++)
    addItemToInventory(db, "1", "10", "four_leaf_clover", 1, { now: time });
  const reward = revealVaultReward(db, {
    vaultId: "test-overflow",
    guildId: "1",
    userId: "10",
    channelId: "2",
    messageId: "40",
    now: time,
    outcome: {
      item: getResolvedItemDefinition(db, "1", "master_key"),
      tier: "legendary",
      tierData: ITEM_TIERS.legendary,
    },
  });
  assert.equal(reward.state, "overflow");
  const inventoryId = getInventory(db, "1", "10", time)[0].id;
  const result = decideVaultReward(db, {
    vaultId: reward.vaultId,
    guildId: "1",
    userId: "10",
    channelId: "2",
    messageId: "40",
    action: "replace",
    inventoryId,
    now: time + 2,
  });
  assert.equal(result.reward.state, "delivered");
  assert.equal(
    getInventory(db, "1", "10", time + 2).find(
      (entry) => entry.item_id === "master_key",
    ).charges,
    2,
  );
});

test("a missing announcement channel and membership outage leave the next contest open", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    installWeeklyEventSchema(db);
    setWeeklyControls(db, {
      guildId: "1",
      enabled: true,
      channelId: "2",
      nextTheme: "mystery",
      now: sunday - 1,
    });
    scoreWeekly(db, {
      guildId: "1",
      userId: "10",
      theme: "mystery",
      key: "win",
      now: sunday + 1,
    });
    const client = {
      guilds: {
        fetch: async () => {
          throw new Error("offline");
        },
      },
      channels: { fetch: async () => null },
    };
    const late = sunday + week + 1;
    await runWeeklyWork({ db, client, now: late });
    assert.equal(
      weeklyView(db, "1", "10", late).contest.starts_at,
      sunday + week,
    );
    assert.equal(weeklyPrize(db, "1", "10", "mystery", late), null);
    client.guilds.fetch = async () => ({
      members: { fetch: async () => new Map([["10", {}]]) },
    });
    await runWeeklyWork({ db, client, now: late });
    assert.equal(weeklyPrize(db, "1", "10", "mystery", late).vaultsPerWin, 1);
    assert.ok(weeklyView(db, "1", "10", late).errors.length);
  } finally {
    db.close();
  }
});

test("a schedule edit preserves the cutoff and prize week, then skips wholly missed weeks", (t) => {
  const db = catalog(t);
  setWeeklyControls(db, {
    guildId: "1",
    enabled: true,
    channelId: "2",
    nextTheme: "wishes",
    now: sunday - 1,
  });
  const first = advanceWeeklyContest(db, "1", sunday);
  scoreWeekly(db, {
    guildId: "1",
    userId: "10",
    theme: "wishes",
    key: "wish",
    now: sunday + 1,
  });
  saveConfigSection(db, {
    section: "weeklyEvents",
    expectedRevision: getConfigView(db).revision,
    values: { "weeklyEvents.day": 1 },
  });
  assert.equal(
    advanceWeeklyContest(db, "1", sunday + 86_400_000).ends_at,
    sunday + week,
  );
  assert.equal(advanceWeeklyContest(db, "1", sunday + week), null);
  settleWeeklyContest(db, first.id, new Set(["10"]));
  assert.equal(advanceWeeklyContest(db, "1", sunday + week + 86_400_000), null);
  assert.equal(
    weeklyPrize(db, "1", "10", "wishes", sunday + 2 * week - 1).wishMultiplier,
    2,
  );
  const resumed = advanceWeeklyContest(
    db,
    "1",
    sunday + 5 * week + 86_400_000 + 20,
  );
  assert.equal(resumed.starts_at, sunday + 5 * week + 86_400_000);
  assert.equal(
    db.prepare("SELECT COUNT(*) count FROM weekly_contests").get().count,
    2,
  );
});

test("a season rollover on the weekly cutoff cancels the contest and skips that start", async (t) => {
  const db = catalog(t);
  db.prepare("INSERT INTO guild_seasons VALUES(?,?,?)").run("1", 0, null);
  setWeeklyControls(db, {
    guildId: "1",
    enabled: true,
    channelId: "2",
    nextTheme: "wishes",
    now: sunday - 1,
  });
  const first = advanceWeeklyContest(db, "1", sunday);
  const cutoff = sunday + week;
  db.prepare(
    `INSERT INTO season_rollovers(guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester,announced_at)
    VALUES('1',0,1,'announced','2',?,?,?,?)`,
  ).run(sunday, cutoff, "test", sunday);
  const sent = [];
  const channel = {
    guildId: "1",
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    async send(payload) {
      sent.push(payload.content);
      return { id: String(sent.length) };
    },
  };
  const client = {
    guilds: {
      fetch: async () => ({
        channels: { fetch: async () => channel },
        members: { me: {} },
      }),
    },
    channels: { fetch: async () => channel },
  };
  for (let pass = 0; pass < 2; pass++) {
    await runSeasonWork({ db, client, now: () => cutoff });
    await runWeeklyWork({ db, client, now: cutoff });
  }
  assert.equal(
    db.prepare("SELECT season FROM guild_seasons WHERE guild_id='1'").get()
      .season,
    1,
  );
  assert.equal(
    db.prepare("SELECT state FROM weekly_contests WHERE id=?").get(first.id)
      .state,
    "cancelled",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Season 1 has started/);
  settleWeeklyContest(db, first.id, new Set(["10"]));
  assert.equal(weeklyPrize(db, "1", "10", "wishes", cutoff), null);
  assert.equal(advanceWeeklyContest(db, "1", cutoff + week).season, 1);
});

test("the authenticated portal saves weekly eligibility and theme controls", async (t) => {
  const db = catalog(t);
  const server = createReviewServer({ db, port: 0, authConfig });
  t.after(async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/api/game/weekly-events`;
  const response = await authenticatedFetch(url, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      guildId: "1",
      channelId: "2",
      enabled: true,
      nextTheme: "franchise",
    }),
  });
  assert.equal(response.status, 200);
  const saved = await authenticatedFetch(`${url}?guildId=1`).then((result) =>
    result.json(),
  );
  assert.equal(saved.controls.enabled, 1);
  assert.equal(saved.controls.next_theme, "franchise");
  assert.deepEqual(saved.schedule, { day: 0, minute: 0, offset: 420 });
});
