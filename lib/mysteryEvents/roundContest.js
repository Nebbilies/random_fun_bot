// Shared arithmetic and presentation for the two round contests.
export const SAFETY_DURATION_MS = 180_000;
const FIRST_ROUND_MS = 10_000;
const LATER_ROUND_MS = 6_000;
export const RESULT_DURATION_MS = 2_000;

export function closesAt(state) {
  return state.startedAt + FIRST_ROUND_MS + (state.round - 1) * (LATER_ROUND_MS + RESULT_DURATION_MS);
}

export function nextInMs(state, now) {
  return Math.max(0, closesAt(state) + (state.phase === 'result' ? RESULT_DURATION_MS : 0) - now);
}

export function draw(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid random value');
  return value;
}

export function leaders(players, scoreKey) {
  return Object.entries(players).sort((a, b) => b[1][scoreKey] - a[1][scoreKey]
    || a[0].localeCompare(b[0], 'en'));
}

export function outcome(players, scoreKey, random) {
  const sorted = leaders(players, scoreKey);
  const top = sorted[0]?.[1][scoreKey] ?? 0;
  if (top <= 0) return { type: 'no_winner' };
  const tied = sorted.filter(([, player]) => player[scoreKey] === top);
  const index = tied.length === 1 ? 0 : Math.floor(draw(random) * tied.length);
  return { type: 'winner', userId: tied[index][0] };
}

export function standings(players, scoreKey) {
  const rows = leaders(players, scoreKey).map(([id, player]) => `<@${id}>: ${player[scoreKey]}`);
  return rows.length ? rows : ['No points scored yet.'];
}

export function validPlayer(input) {
  return input?.type === 'button' && typeof input.userId === 'string' && /^\d+$/.test(input.userId);
}

export function choiceFeedback(state, choice) {
  return { type: 'choice_saved', round: state.round, choice, deadlineAt: closesAt(state) };
}

export const EXPIRED_CHOICE = { type: 'rejected', message: 'This round is closed or you cannot enter it.' };
