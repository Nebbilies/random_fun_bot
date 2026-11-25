import assert from "node:assert/strict";
import { test } from "node:test";
import { doorsEvent } from "../lib/mysteryEvents/doors.js";

const base = { rollerId: "101", now: 1_000, random: () => 0.5 };

test("Doors makes a uniform hidden choice and only the roller can choose", () => {
  const opening = doorsEvent.start(base);
  assert.equal(doorsEvent.id, "doors");
  assert.equal(doorsEvent.durationMs, 30_000);
  assert.equal(doorsEvent.available(base), true);
  assert.equal(opening.durationMs, 30_000);
  assert.equal(opening.view.buttons.length, 2);
  assert.deepEqual(
    opening.view.buttons.map((button) => button.label),
    ["Left", "Right"],
  );
  for (const [draw, slot] of [
    [0, 1],
    [0.499999, 1],
    [0.5, 2],
    [0.999999, 2],
  ]) {
    assert.equal(
      doorsEvent.start({ ...base, random: () => draw }).state.winningDoor,
      slot,
    );
  }
  assert.equal(opening.state.winningDoor, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(opening.state)), opening.state);
  const spectator = doorsEvent.advance({
    state: opening.state,
    now: 2_000,
    input: { type: "button", userId: "202", value: "2" },
  });
  assert.deepEqual(spectator.state, opening.state);
  assert.equal(spectator.outcome, undefined);
  const chosen = doorsEvent.advance({
    state: opening.state,
    now: 2_000,
    input: { type: "button", userId: "101", value: "2" },
  });
  assert.deepEqual(chosen.outcome, { type: "winner", userId: "101" });
  assert.equal(
    doorsEvent.advance({
      state: chosen.state,
      now: 3_000,
      input: { type: "button", userId: "101", value: "2" },
    }).outcome,
    undefined,
  );
});

test("Doors loses on a wrong choice or deadline, without a replacement prize", () => {
  const opening = doorsEvent.start(base);
  assert.equal(
    doorsEvent.advance({
      state: opening.state,
      now: 30_000,
      input: { type: "timer" },
    }).nextInMs,
    1_000,
  );
  const wrong = doorsEvent.advance({
    state: opening.state,
    now: 2_000,
    input: { type: "button", userId: "101", value: "1" },
  });
  assert.deepEqual(wrong.outcome, { type: "no_winner" });
  const timeout = doorsEvent.advance({
    state: opening.state,
    now: 31_000,
    input: { type: "timer" },
  });
  assert.deepEqual(timeout.outcome, { type: "no_winner" });
  assert.throws(
    () => doorsEvent.start({ ...base, random: () => 1 }),
    /random/i,
  );
});
