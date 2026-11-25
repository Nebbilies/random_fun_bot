import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getTreasurePuzzle,
  solveTreasureHints,
  TREASURE_PUZZLE_COUNT,
} from "../lib/mysteryEvents/treasurePuzzles.js";
import { treasureHuntEvent } from "../lib/mysteryEvents/treasureHunt.js";

function fixture() {
  const wins = new Map();
  const db = {
    prepare(sql) {
      assert.match(sql, /treasure_puzzle_wins/);
      return {
        all(guildId) {
          return [...(wins.get(guildId) || [])].map((puzzle_id) => ({
            puzzle_id,
          }));
        },
      };
    },
  };
  return { db, wins };
}

test("checked puzzle bank has 10,000 distinct solvable instances", () => {
  assert.equal(TREASURE_PUZZLE_COUNT, 10_000);
  const ids = new Set();
  const answers = new Set();
  const templates = new Map();
  for (let i = 0; i < TREASURE_PUZZLE_COUNT; i++) {
    const puzzle = getTreasurePuzzle(`lock-${String(i).padStart(4, "0")}`);
    assert.equal(puzzle.clues.length, 3);
    assert.match(puzzle.answer, /^\d{4}$/);
    assert.equal(solveTreasureHints(puzzle.hints), puzzle.answer);
    ids.add(puzzle.id);
    answers.add(puzzle.answer);
    templates.set(
      puzzle.hints.template,
      (templates.get(puzzle.hints.template) || 0) + 1,
    );
  }
  assert.equal(ids.size, TREASURE_PUZZLE_COUNT);
  assert.equal(answers.size, TREASURE_PUZZLE_COUNT);
  assert.equal(templates.size, 5);
  for (const count of templates.values()) assert.equal(count, 2_000);
});

test("Hunt reveals three clues on absolute times and first correct answer wins", () => {
  const { db } = fixture();
  const ctx = { db, guildId: "1", now: 1_000, random: () => 0 };
  const opening = treasureHuntEvent.start(ctx);
  assert.equal(treasureHuntEvent.id, "treasure_hunt");
  assert.equal(treasureHuntEvent.durationMs, 120_000);
  assert.equal(opening.durationMs, 120_000);
  assert.equal(opening.nextInMs, 40_000);
  assert.equal(opening.state.puzzleId, "lock-0000");
  assert.match(opening.view.text, /Clue 1/);
  assert.deepEqual(JSON.parse(JSON.stringify(opening.state)), opening.state);
  const wrong = treasureHuntEvent.advance({
    state: opening.state,
    now: 2_000,
    input: { type: "answer", userId: "201", value: "9999" },
  });
  assert.equal(wrong.outcome, undefined);
  const second = treasureHuntEvent.advance({
    state: opening.state,
    now: 41_000,
    input: { type: "timer" },
  });
  assert.match(second.view.text, /Clue 1/);
  assert.match(second.view.text, /Clue 2/);
  assert.equal(second.nextInMs, 40_000);
  const third = treasureHuntEvent.advance({
    state: second.state,
    now: 81_000,
    input: { type: "timer" },
  });
  assert.match(third.view.text, /Clue 1/);
  assert.match(third.view.text, /Clue 2/);
  assert.match(third.view.text, /Clue 3/);
  const win = treasureHuntEvent.advance({
    state: third.state,
    now: 82_000,
    input: { type: "answer", userId: "202", value: "0-0-0-0" },
  });
  assert.deepEqual(win.outcome, {
    type: "winner",
    userId: "202",
    puzzleId: "lock-0000",
  });
  const delayed = treasureHuntEvent.advance({
    state: opening.state,
    now: 90_000,
    input: { type: "timer" },
  });
  assert.match(delayed.view.text, /Clue 2/);
  assert.match(delayed.view.text, /Clue 3/);
});

test("Hunt retires only won puzzles per guild and allows unsolved repeats", () => {
  const { db, wins } = fixture();
  const ctx = { db, guildId: "1", now: 1_000, random: () => 0 };
  const opening = treasureHuntEvent.start(ctx);
  assert.equal(
    treasureHuntEvent.advance({
      state: opening.state,
      now: 121_000,
      input: { type: "timer" },
    }).outcome.type,
    "no_winner",
  );
  assert.equal(wins.size, 0);
  assert.equal(
    treasureHuntEvent.start(ctx).state.puzzleId,
    opening.state.puzzleId,
  );
  wins.set("1", new Set(["lock-0000"]));
  assert.equal(treasureHuntEvent.start(ctx).state.puzzleId, "lock-0001");
  assert.equal(
    treasureHuntEvent.start({ ...ctx, guildId: "2" }).state.puzzleId,
    "lock-0000",
  );
  wins.set(
    "1",
    new Set(
      Array.from(
        { length: TREASURE_PUZZLE_COUNT },
        (_, i) => `lock-${String(i).padStart(4, "0")}`,
      ),
    ),
  );
  assert.equal(treasureHuntEvent.available(ctx), false);
  assert.equal(treasureHuntEvent.start(ctx), null);
});
