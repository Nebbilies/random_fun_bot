export const TREASURE_PUZZLE_COUNT = 10_000;
const TEMPLATE_IDS = [
  "checksum",
  "row_sums",
  "middle_product",
  "shifts",
  "ordering",
];

function puzzleId(index) {
  return `lock-${String(index).padStart(4, "0")}`;
}

export function getTreasurePuzzle(id) {
  if (typeof id !== "string" || !/^lock-\d{4}$/.test(id))
    throw new Error("Invalid treasure puzzle ID");
  const answer = id.slice(5);
  const [a, b, c, d] = [...answer].map(Number);
  const template = TEMPLATE_IDS[Number(answer) % TEMPLATE_IDS.length];
  let hints;
  let clues;
  switch (template) {
    case "checksum": {
      hints = {
        template,
        sum: a + b + c + d,
        first: a,
        last: d,
        middleDifference: b - c,
      };
      clues = [
        `The four lock digits add up to ${hints.sum}.`,
        `The first digit is ${a}; the fourth is ${d}.`,
        `The second digit minus the third is ${hints.middleDifference}.`,
      ];
      break;
    }
    case "row_sums": {
      hints = { template, rowSums: [a + b, c + d], first: a, third: c };
      clues = [
        `The first two digits add to ${a + b}; the last two add to ${c + d}.`,
        `The first digit is ${a}.`,
        `The third digit is ${c}.`,
      ];
      break;
    }
    case "middle_product": {
      hints = {
        template,
        first: a,
        last: d,
        middleSum: b + c,
        middleProduct: b * c,
        comparison: Math.sign(b - c),
      };
      const relation =
        hints.comparison < 0
          ? "smaller than"
          : hints.comparison > 0
            ? "larger than"
            : "equal to";
      clues = [
        `The first digit is ${a}; the fourth is ${d}.`,
        `The middle digits add to ${hints.middleSum} and multiply to ${hints.middleProduct}.`,
        `The second digit is ${relation} the third.`,
      ];
      break;
    }
    case "shifts": {
      hints = {
        template,
        first: a,
        second: b,
        thirdShift: (c - a + 10) % 10,
        fourthShift: (d - b + 10) % 10,
      };
      clues = [
        `The first two digits are ${a} and ${b}. The last two wrap around after 9.`,
        `Add ${hints.thirdShift} to the first digit, wrapping after 9, to get the third.`,
        `Add ${hints.fourthShift} to the second digit, wrapping after 9, to get the fourth.`,
      ];
      break;
    }
    case "ordering": {
      hints = {
        template,
        sorted: [a, b, c, d].sort((x, y) => x - y),
        first: a,
        third: c,
        comparison: Math.sign(b - d),
      };
      const relation =
        hints.comparison < 0
          ? "smaller than"
          : hints.comparison > 0
            ? "larger than"
            : "equal to";
      clues = [
        `The four digits, shuffled into ascending order, are ${hints.sorted.join(", ")}.`,
        `The first digit is ${a}; the third is ${c}.`,
        `The second digit is ${relation} the fourth.`,
      ];
      break;
    }
  }
  const puzzle = { id, answer, hints, clues };
  if (solveTreasureHints(hints) !== answer)
    throw new Error(`Invalid treasure puzzle template for ${id}`);
  return puzzle;
}

export function solveTreasureHints(hints) {
  switch (hints.template) {
    case "checksum": {
      const middleSum = hints.sum - hints.first - hints.last;
      return [
        hints.first,
        (middleSum + hints.middleDifference) / 2,
        (middleSum - hints.middleDifference) / 2,
        hints.last,
      ].join("");
    }
    case "row_sums":
      return [
        hints.first,
        hints.rowSums[0] - hints.first,
        hints.third,
        hints.rowSums[1] - hints.third,
      ].join("");
    case "middle_product": {
      const root = Math.sqrt(hints.middleSum ** 2 - 4 * hints.middleProduct);
      const low = (hints.middleSum - root) / 2;
      const high = (hints.middleSum + root) / 2;
      return [
        hints.first,
        hints.comparison <= 0 ? low : high,
        hints.comparison <= 0 ? high : low,
        hints.last,
      ].join("");
    }
    case "shifts":
      return [
        hints.first,
        hints.second,
        (hints.first + hints.thirdShift) % 10,
        (hints.second + hints.fourthShift) % 10,
      ].join("");
    case "ordering": {
      const remaining = [...hints.sorted];
      remaining.splice(remaining.indexOf(hints.first), 1);
      remaining.splice(remaining.indexOf(hints.third), 1);
      const [low, high] = remaining;
      return [
        hints.first,
        hints.comparison <= 0 ? low : high,
        hints.third,
        hints.comparison <= 0 ? high : low,
      ].join("");
    }
    default:
      throw new Error("Unknown treasure puzzle template");
  }
}

export function isCorrectTreasureAnswer(puzzle, value) {
  if (typeof value !== "string" || !/^[\d\s-]+$/.test(value)) return false;
  return value.replace(/[\s-]/g, "") === puzzle.answer;
}

export function chooseTreasurePuzzle(usedIds, random = Math.random) {
  if (!(usedIds instanceof Set))
    throw new Error("Used treasure puzzle IDs must be a Set");
  let available = 0;
  for (let i = 0; i < TREASURE_PUZZLE_COUNT; i++) {
    if (!usedIds.has(puzzleId(i))) available++;
  }
  if (!available) return null;
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1)
    throw new Error("Invalid random value");
  let offset = Math.floor(draw * available);
  for (let i = 0; i < TREASURE_PUZZLE_COUNT; i++) {
    const id = puzzleId(i);
    if (usedIds.has(id)) continue;
    if (offset-- === 0) return getTreasurePuzzle(id);
  }
  throw new Error("Treasure puzzle selection failed");
}
