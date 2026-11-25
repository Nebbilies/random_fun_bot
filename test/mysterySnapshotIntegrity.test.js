import test from "node:test";
import assert from "node:assert/strict";
import { openCatalog } from "../lib/catalogDb.js";
import {
  reserveRoll,
  getMysterySession,
  publishMysteryIntro,
  advanceMysterySession,
  openMysteryClaim,
  claimRoll,
} from "../lib/characterRolls.js";
import {
  beginMysteryEvent,
  advanceMysteryEvent,
} from "../lib/mysteryCoordinator.js";
import { adaptCharacterSnapshot } from "../lib/characterIdentitySnapshots.js";

function fixture(t, mutate = false) {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  db.exec(
    "INSERT INTO characters(id,rank,favourites,name_full) VALUES(12,1,1234,'Prize')",
  );
  const roll = reserveRoll(db, {
    guildId: "1",
    channelId: "10",
    commandMessageId: "100",
    userId: "101",
    pool: "w",
    now: 1000,
    random: () => 0,
    mystery: {
      eventChannelId: "10",
      selectEvent: ({ character }) => {
        if (mutate) {
          character.rank = 999;
          character.id = 99;
          character.name_full = "Wrong";
        }
        return { eventId: "doors", durationMs: 60000, state: {} };
      },
    },
  });
  assert.equal(roll.status, "mystery");
  return { db, roll };
}
const data = (db) =>
  ["mystery_sessions", "character_rolls"].map((table) =>
    db.prepare(`SELECT * FROM ${table}`).all(),
  );
for (const corruption of ["null", "version", "identity", "rank", "scalar"]) {
  for (const phase of ["intro", "begin", "advance", "claim", "award"])
    test(`${phase} rejects ${corruption} snapshot without writes`, (t) => {
      const { db, roll } = fixture(t);
      if (phase !== "intro")
        publishMysteryIntro(db, roll.sessionId, "500", 1100);
      if (["advance", "claim", "award"].includes(phase))
        beginMysteryEvent(db, roll.sessionId, 6100, () => 0);
      if (["claim", "award"].includes(phase)) {
        const running = getMysterySession(db, roll.sessionId);
        assert.equal(
          advanceMysterySession(db, {
            sessionId: roll.sessionId,
            expectedState: "running",
            expectedStateJson: running.stateJson,
            state: "countdown",
            winnerId: "101",
            nextAt: 6200,
            now: 6101,
          }).status,
          "advanced",
        );
      }
      if (phase === "award")
        assert.equal(
          openMysteryClaim(db, {
            sessionId: roll.sessionId,
            messageId: "501",
            now: 6200,
          }).status,
          "open",
        );
      const session = getMysterySession(db, roll.sessionId);
      const state = JSON.parse(session.stateJson);
      if (corruption === "null") state.characterSnapshot = null;
      if (corruption === "version") state.characterSnapshot.version = 999;
      if (corruption === "identity") state.characterSnapshot.id = 99;
      if (corruption === "rank") state.characterSnapshot.rank = 0;
      if (corruption === "scalar")
        db.prepare(
          "UPDATE mystery_sessions SET rank_snapshot=999 WHERE id=?",
        ).run(roll.sessionId);
      db.prepare("UPDATE mystery_sessions SET state_json=? WHERE id=?").run(
        JSON.stringify(state),
        roll.sessionId,
      );
      const before = data(db);
      const action =
        phase === "intro"
          ? () => publishMysteryIntro(db, roll.sessionId, "501", 1100)
          : phase === "begin"
            ? () => beginMysteryEvent(db, roll.sessionId, 6100, () => 0)
            : phase === "advance"
              ? () =>
                  advanceMysteryEvent(db, {
                    sessionId: roll.sessionId,
                    input: { type: "timer" },
                    now: 6200,
                  })
              : phase === "claim"
                ? () =>
                    openMysteryClaim(db, {
                      sessionId: roll.sessionId,
                      messageId: "501",
                      now: 6200,
                    })
                : () =>
                    claimRoll(db, {
                      guildId: "1",
                      channelId: "10",
                      messageId: "501",
                      userId: "101",
                      now: 6300,
                    });
      assert.throws(action, /snapshot/);
      assert.deepEqual(data(db), before);
    });
}
test("selector mutation cannot change the captured scalar rank", (t) => {
  const { db, roll } = fixture(t, true);
  const session = getMysterySession(db, roll.sessionId);
  assert.equal(
    db
      .prepare("SELECT character_id FROM character_rolls WHERE id=?")
      .get(roll.rollId).character_id,
    12,
  );
  assert.equal(roll.character.id, 12);
  assert.equal(session.rankSnapshot, 1);
  assert.equal(JSON.parse(session.stateJson).characterSnapshot.rank, 1);
  const row = db.prepare("SELECT * FROM mystery_sessions").get();
  row.rank_snapshot = 999;
  assert.throws(
    () => adaptCharacterSnapshot("mystery_sessions", "state_json", row),
    /rank mismatch/,
  );
});
