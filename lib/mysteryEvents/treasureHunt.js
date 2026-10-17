import { chooseTreasurePuzzle, getTreasurePuzzle, isCorrectTreasureAnswer } from './treasurePuzzles.js';

const DURATION_MS = 120_000;
const CLUE_TIMES_MS = [0, 40_000, 80_000];

function usedPuzzleIds(db, guildId) {
  return new Set(db.prepare('SELECT puzzle_id FROM treasure_puzzle_wins WHERE guild_id = ?')
    .all(guildId).map(row => row.puzzle_id));
}

function clueView(puzzle, indices) {
  return { text: indices.map(index => `Clue ${index + 1}/3: ${puzzle.clues[index]}`).join('\n') };
}

export const treasureHuntEvent = {
  id: 'treasure_hunt',
  durationMs: DURATION_MS,

  available({ db, guildId }) {
    return chooseTreasurePuzzle(usedPuzzleIds(db, guildId), () => 0) !== null;
  },

  start({ db, guildId, now, random = Math.random }) {
    const puzzle = chooseTreasurePuzzle(usedPuzzleIds(db, guildId), random);
    if (!puzzle) return null;
    return {
      state: { status: 'open', puzzleId: puzzle.id, startedAt: now,
        deadlineAt: now + DURATION_MS, clueIndex: 0 },
      durationMs: DURATION_MS,
      nextInMs: CLUE_TIMES_MS[1],
      view: clueView(puzzle, [0]),
    };
  },

  advance({ state, input, now }) {
    if (state.status !== 'open') return { state };
    if (now >= state.deadlineAt) {
      return { state: { ...state, status: 'closed' }, outcome: { type: 'no_winner' } };
    }
    const puzzle = getTreasurePuzzle(state.puzzleId);
    if (input?.type === 'answer' && input.userId && isCorrectTreasureAnswer(puzzle, input.value)) {
      return { state: { ...state, status: 'closed' },
        outcome: { type: 'winner', userId: input.userId, puzzleId: state.puzzleId } };
    }
    if (input?.type !== 'timer') return { state };
    const elapsed = now - state.startedAt;
    const dueIndex = elapsed >= CLUE_TIMES_MS[2] ? 2 : elapsed >= CLUE_TIMES_MS[1] ? 1 : 0;
    if (dueIndex <= state.clueIndex) {
      const nextAt = state.startedAt + (CLUE_TIMES_MS[state.clueIndex + 1] ?? DURATION_MS);
      return { state, nextInMs: Math.max(0, nextAt - now) };
    }
    const nextIndex = dueIndex + 1;
    const nextAt = state.startedAt + (CLUE_TIMES_MS[nextIndex] ?? DURATION_MS);
    return {
      state: { ...state, clueIndex: dueIndex },
      view: clueView(puzzle, Array.from({ length: dueIndex + 1 }, (_, i) => i)),
      nextInMs: Math.max(0, nextAt - now),
    };
  },
};
