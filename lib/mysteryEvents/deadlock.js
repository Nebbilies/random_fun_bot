import { SAFETY_DURATION_MS, RESULT_DURATION_MS, closesAt, nextInMs, outcome, standings,
  validPlayer, choiceFeedback, EXPIRED_CHOICE } from './roundContest.js';

function prompt(state) {
  return { round: state.round, phase: 'choice',
    text: `**Deadlock · Round ${state.round}/3**\n`
      + 'Pick 1–5. A unique pick scores its value; duplicate picks score zero.\n'
      + 'Choose to join at any round. You may revise your pick until the deadline.\n'
      + `Participants: ${Object.keys(state.players).length} · Closes <t:${Math.ceil(closesAt(state) / 1000)}:R>.`,
    lines: ['**Cumulative standings**', ...standings(state.players, 'score')],
    buttons: [1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: String(value) })) };
}

function settle(state) {
  const counts = {};
  for (const value of Object.values(state.choices)) counts[value] = (counts[value] ?? 0) + 1;
  const lines = [];
  for (const [id, player] of Object.entries(state.players)) {
    const pick = state.choices[id];
    const earned = pick && counts[pick] === 1 ? Number(pick) : 0;
    player.score += earned;
    lines.push(`<@${id}>: ${pick ? `picked ${pick}` : 'missed'} · +${earned} · total ${player.score}`);
  }
  state.phase = state.round === 3 ? 'finished' : 'result';
  return { round: state.round, phase: state.phase,
    text: `**Deadlock · Round ${state.round} results**`,
    lines: [...lines, state.phase === 'finished' ? '**Final standings**' : '**Cumulative standings**',
      ...standings(state.players, 'score')] };
}

export const deadlockEvent = {
  id: 'deadlock', durationMs: SAFETY_DURATION_MS,
  available() { return true; },
  start({ now }) {
    const state = { phase: 'choice', round: 1, startedAt: now, players: {}, choices: {} };
    return { state, view: prompt(state), nextInMs: nextInMs(state, now) };
  },
  advance({ state: previous, input, now, random = Math.random }) {
    if (previous.phase === 'finished') return { state: previous };
    const state = structuredClone(previous);
    const views = [];
    while (true) {
      if (state.phase === 'choice' && now >= closesAt(state)) {
        views.push(settle(state));
        if (state.phase === 'finished') return { state, views, outcome: outcome(state.players, 'score', random) };
      }
      if (state.phase === 'result' && now >= closesAt(state) + RESULT_DURATION_MS) {
        state.round++;
        state.phase = 'choice';
        state.choices = {};
        if (now < closesAt(state)) views.push(prompt(state));
        continue;
      }
      break;
    }
    let feedback;
    if (input?.type === 'button') {
      if (!validPlayer(input) || input.round !== state.round || state.phase !== 'choice'
        || !['1', '2', '3', '4', '5'].includes(input.value)) {
        feedback = EXPIRED_CHOICE;
      } else {
        const joined = !state.players[input.userId];
        if (joined) state.players[input.userId] = { score: 0 };
        state.choices[input.userId] = input.value;
        feedback = choiceFeedback(state, input.value);
        if (joined) {
          if (views.at(-1)?.phase === 'choice') views.pop();
          views.push(prompt(state));
        }
      }
    }
    return { state, views, feedback, nextInMs: nextInMs(state, now) };
  },
};
