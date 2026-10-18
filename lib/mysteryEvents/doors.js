const DURATION_MS = 30_000;

export const doorsEvent = {
  id: 'doors',
  durationMs: DURATION_MS,

  available() {
    return true;
  },

  start({ rollerId, now, random = Math.random }) {
    const draw = random();
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error('Invalid random value');
    return {
      state: { status: 'open', rollerId, winningDoor: Math.floor(draw * 2) + 1, deadlineAt: now + DURATION_MS },
      durationMs: DURATION_MS,
      nextInMs: DURATION_MS,
      view: {
        text: 'Choose Left or Right. One character, one John Pork. Only the roller may choose.',
        buttons: [1, 2].map(door => ({ value: String(door), label: door === 1 ? 'Left' : 'Right' })),
      },
    };
  },

  advance({ state, input, now }) {
    if (state.status !== 'open') return { state };
    if (now >= state.deadlineAt) {
      return { state: { ...state, status: 'closed' }, outcome: { type: 'no_winner' } };
    }
    if (input?.type === 'timer') return { state, nextInMs: state.deadlineAt - now };
    if (input?.type !== 'button' || input.userId !== state.rollerId || !['1', '2'].includes(input.value)) {
      return { state };
    }
    const won = Number(input.value) === state.winningDoor;
    return {
      state: { ...state, status: 'closed' },
      outcome: won ? { type: 'winner', userId: state.rollerId } : { type: 'no_winner' },
    };
  },
};
