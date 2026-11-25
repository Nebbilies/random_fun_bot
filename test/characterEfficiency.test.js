import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreCharacter,
  projectCharacterRanking,
  validateMudaeCharacterUrl,
} from "../lib/catalogRanking.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n, count = null, claim = null, legacy = null) => ({
  id: id(n),
  danbooru_post_count: count,
  mudae_claim_rank: claim,
  legacy_rank: legacy,
});

test("efficiency uses the fixed weighted bounds and preserves missing versus zero", () => {
  assert.equal(scoreCharacter(row(1, 149200, 1)), 2);
  assert.equal(scoreCharacter(row(1, null, 1)), 1.5);
  assert.equal(scoreCharacter(row(1, 149200)), 0.5);
  assert.equal(scoreCharacter(row(1)), 0);
  assert.equal(scoreCharacter(row(1, 0, 150837)), 0);
  assert.ok(scoreCharacter(row(1, null, 150838)) < 0);
  assert.ok(scoreCharacter(row(1, 298400, 1)) > 2);
});

test("efficiency ties use known claims then only applicable legacy ranks then UUID", () => {
  const input = [
    row(1, 0, null, 1),
    row(2),
    row(3, null, null, 20),
    row(4, null, null, 2),
    row(5, 0, 150837),
  ];
  assert.deepEqual(
    projectCharacterRanking(input).map((r) => r.id),
    [id(5), id(4), id(3), id(1), id(2)],
  );
  assert.deepEqual(
    projectCharacterRanking([...input].reverse()).map((r) => r.id),
    [id(5), id(4), id(3), id(1), id(2)],
  );
  assert.deepEqual(
    input.map((r) => r.legacy_rank),
    [1, null, 20, 2, null],
  );
});

test("ranking validates raw inputs and canonical identities and never clamps", () => {
  for (const value of [
    -1,
    1.5,
    NaN,
    Infinity,
    "1",
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => scoreCharacter(row(1, value)), /count/);
  }
  for (const value of [0, -1, 1.5, NaN, "1"])
    assert.throws(() => scoreCharacter(row(1, null, value)), /rank/);
  assert.ok(
    Number.isFinite(
      scoreCharacter(row(1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
    ),
  );
  assert.throws(() => projectCharacterRanking([row(1), row(1)]), /identity/);
  assert.throws(
    () => projectCharacterRanking([{ ...row(1), id: "not-uuid" }]),
    /UUID/,
  );
  const before = projectCharacterRanking([row(2, 149200), row(3, null, 1)]);
  const after = projectCharacterRanking([
    row(1),
    row(2, 149200),
    row(3, null, 1),
  ]);
  assert.deepEqual(
    before.map((r) => r.efficiency),
    [1.5, 0.5],
  );
  assert.deepEqual(
    after.map((r) => r.efficiency),
    [1.5, 0.5, 0],
  );
});

test("Mudae links are independent optional references with a bounded exact origin", () => {
  assert.equal(validateMudaeCharacterUrl(null), null);
  assert.equal(
    validateMudaeCharacterUrl("https://mudae.net/character/123/example"),
    "https://mudae.net/character/123/example",
  );
  for (const url of [
    "http://mudae.net/character/1/a",
    "https://mudae.net.evil/character/1/a",
    "https://user@mudae.net/character/1/a",
    "https://mudae.net:444/character/1/a",
    "https://mudae.net/character/0/a",
    "https://mudae.net/character/1/a\n",
    `https://mudae.net/character/1/${"x".repeat(2048)}`,
  ]) {
    assert.throws(() => validateMudaeCharacterUrl(url), /Mudae/);
  }
});

test("distinct exact scores retain order even when floating scores round to the same value", () => {
  const low = row(1, Number.MAX_SAFE_INTEGER - 1),
    high = row(2, Number.MAX_SAFE_INTEGER);
  assert.equal(scoreCharacter(low), scoreCharacter(high));
  assert.deepEqual(
    projectCharacterRanking([low, high]).map((row) => row.id),
    [id(2), id(1)],
  );
});

test("mixed legacy ties are deterministic across every permutation and claims break an exact weighted tie", () => {
  const input = [
    row(1, 0, null, 1),
    row(2),
    row(3, null, null, 20),
    row(4, null, null, 2),
    row(5, 0, 150837),
  ];
  const permutations = (rows) =>
    rows.length
      ? rows.flatMap((row, index) =>
          permutations(rows.filter((_, i) => i !== index)).map((tail) => [
            row,
            ...tail,
          ]),
        )
      : [[]];
  for (const permutation of permutations(input))
    assert.deepEqual(
      projectCharacterRanking(permutation).map((row) => row.id),
      [id(5), id(4), id(3), id(1), id(2)],
    );
  const scores = [row(1, 447600, 150837), row(2, 0, 1)];
  assert.deepEqual(
    projectCharacterRanking(scores).map((row) => [row.id, row.efficiency]),
    [
      [id(2), 1.5],
      [id(1), 1.5],
    ],
  );
});
