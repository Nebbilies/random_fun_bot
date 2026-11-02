import { SAFETY_DURATION_MS, draw, validPlayer, EXPIRED_CHOICE } from './roundContest.js';

function prompt(state) {
  const inside = Object.keys(state.players).filter(id => state.players[id].inside);
  const list = side => inside.filter(id => (state.choices[id] ?? 'unpicked') === side)
    .map(id => `<@${id}>`).join('\n') || '—';
  return { round: state.round, phase: 'choice', publicChoices: true, card: {
    title: '🌉 Glass Bridge', heading: `Step ${state.round}`,
    rules: ['Choose Left or Right. One side is safe. A wrong or missed choice ends your run.',
      state.round === 1 ? 'Entry closes when this step ends.' : 'Entry is closed.'],
    deadline: state.closesAt,
  }, lines: [`### Left\n${list('left')}`, `### Right\n${list('right')}`,
    ...(state.round > 1 ? [`### Unpicked\n${list('unpicked')}`] : [])],
  buttons: [{ value: 'left', label: 'Left', style: 'primary' },
    { value: 'right', label: 'Right', style: 'primary' }] };
}

export const glassBridgeEvent = {
  id: 'glass_bridge', durationMs: SAFETY_DURATION_MS,
  available() { return true; },
  start({ now, rules, random = Math.random }) {
    const state = { phase: 'choice', round: 1, startedAt: now,
      closesAt: now + (rules?.firstRoundMs ?? 25_000), players: {}, choices: {},
      safeSide: draw(random) < 0.5 ? 'left' : 'right', ...(rules ? { rules: structuredClone(rules) } : {}) };
    return { state, view: prompt(state), nextInMs: state.closesAt - now };
  },
  advance({ state: previous, input, now, random = Math.random }) {
    const state = structuredClone(previous);
    const views = [];
    if (state.phase === 'finished') return { state };
    if (state.phase === 'final_result') {
      if (now < state.resultAt) return { state, nextInMs: state.resultAt - now };
      state.phase = 'finished';
      return { state, outcome: state.outcome, views: [{ round: state.round, phase: 'finished',
        text: '**🌉 Glass Bridge — Finished**', lines: [state.summary] }] };
    }
    if (state.phase === 'choice' && now >= state.closesAt) {
      const active = Object.keys(state.players).filter(id => state.players[id].inside);
      const survivors = active.filter(id => state.choices[id] === state.safeSide);
      const fell = active.filter(id => !survivors.includes(id));
      for (const id of fell) state.players[id].inside = false;
      views.push({ round: state.round, phase: 'result', text: `**🌉 Glass Bridge · Step ${state.round} results**\nSafe side: ${state.safeSide === 'left' ? 'Left' : 'Right'} ✅`,
        lines: ['### Crossed', ...(survivors.map(id => `<@${id}> — ${state.choices[id]} ✅`)),
          '### Fell', ...fell.map(id => `<@${id}> — ${state.choices[id] ?? 'Unpicked'} ❌`)] });
      if (survivors.length <= 1) {
        state.phase = 'final_result';
        const winnerId = survivors[0] ?? (state.round > 1 && fell.length
          ? fell[Math.floor(draw(random) * fell.length)] : null);
        state.outcome = winnerId ? { type: 'winner', userId: winnerId } : { type: 'no_winner' };
        state.summary = !winnerId ? 'Nobody crossed the first step. No winner.'
          : survivors.length ? `<@${winnerId}> crossed step ${state.round} and is the last player standing!`
            : `Everyone fell on step ${state.round}. <@${winnerId}> wins the random tiebreak among those who fell.`;
        state.resultAt = now + (state.rules?.resultMs ?? 8_000);
        return { state, views, nextInMs: state.resultAt - now };
      }
      state.phase = 'result';
      state.resultAt = now + (state.rules?.resultMs ?? 8_000);
    }
    if (state.phase === 'result' && now >= state.resultAt) {
      state.round++;
      state.phase = 'choice';
      state.choices = {};
      state.safeSide = draw(random) < 0.5 ? 'left' : 'right';
      state.closesAt = now + (state.rules?.laterRoundMs ?? 15_000);
      views.push(prompt(state));
    }
    let feedback;
    if (input?.type === 'button') {
      const player = state.players[input.userId];
      if (!validPlayer(input) || input.round !== state.round || state.phase !== 'choice'
        || !['left', 'right'].includes(input.value) || (player ? !player.inside : state.round !== 1)) {
        feedback = EXPIRED_CHOICE;
      } else {
        if (!player) state.players[input.userId] = { inside: true };
        state.choices[input.userId] = input.value;
        feedback = { type: 'choice_saved', round: state.round,
          choice: input.value === 'left' ? 'Left' : 'Right', deadlineAt: state.closesAt };
        views.push(prompt(state));
      }
    }
    return { state, views, feedback, nextInMs: Math.max(0,
      (state.phase === 'result' ? state.resultAt : state.closesAt) - now) };
  },
};
