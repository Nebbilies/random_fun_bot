import {
  SAFETY_DURATION_MS,
  resultDurationMs,
  closesAt,
  nextInMs,
  draw,
  outcome,
  standings,
  validPlayer,
  choiceFeedback,
  EXPIRED_CHOICE,
} from "./roundContest.js";

const TOTALS = [1, 3, 6, 10, 15];
const COLLAPSE = [0.1, 0.2, 0.3, 0.45, 0.67];
const TOTAL_ROUNDS = 5;
const ACCENT = 0xf1c40f;

function prompt(state) {
  return {
    round: state.round,
    phase: "choice",
    card: {
      title: "💰 Greed Chamber",
      heading: `Round ${state.round}/${state.rules?.rounds ?? TOTAL_ROUNDS}`,
      accent: ACCENT,
      rules: [
        "Stay to risk your unbanked points, or Escape to bank them.",
        state.round === 1
          ? "Entry closes after this round."
          : "Entry is closed — missing a choice automatically banks your points.",
      ],
      stats: [
        `Participants: ${Object.keys(state.players).length}`,
        `Survive Stay for **${(state.rules?.totals ?? TOTALS)[state.round - 1]} point${(state.rules?.totals ?? TOTALS)[state.round - 1] === 1 ? "" : "s"}**`,
      ],
      deadline: closesAt(state),
    },
    lines: ["**Banked standings**", ...standings(state.players, "banked")],
    buttons: [
      { value: "stay", label: "Stay", style: "success", emoji: "💎" },
      { value: "escape", label: "Escape", style: "danger", emoji: "🏃" },
    ],
  };
}

function settle(state, random) {
  const stayed = [];
  const lines = [];
  for (const [id, player] of Object.entries(state.players)) {
    if (player.status !== "inside") continue;
    if (state.choices[id] === "stay") {
      stayed.push([id, player]);
    } else {
      player.banked = player.score;
      player.score = 0;
      player.status = "escaped";
      lines.push(
        `<@${id}>: ${state.choices[id] ? "Escaped" : "Automatically escaped"} · banked ${player.banked}`,
      );
    }
  }
  const collapsed =
    stayed.length > 0 &&
    draw(random) < (state.rules?.collapseChances ?? COLLAPSE)[state.round - 1];
  for (const [id, player] of stayed) {
    player.score = collapsed
      ? 0
      : (state.rules?.totals ?? TOTALS)[state.round - 1];
    if (collapsed) player.status = "collapsed";
    else if (state.round === (state.rules?.rounds ?? TOTAL_ROUNDS)) {
      player.banked = player.score;
      player.score = 0;
      player.status = "escaped";
    }
    lines.push(
      `<@${id}>: Stayed · ${
        collapsed
          ? "collapsed · 0 points"
          : state.round === (state.rules?.rounds ?? TOTAL_ROUNDS)
            ? `banked ${player.banked}`
            : `survived · ${player.score} unbanked`
      }`,
    );
  }
  state.phase = Object.values(state.players).some(
    (player) => player.status === "inside",
  )
    ? "result"
    : "finished";
  return {
    round: state.round,
    phase: state.phase,
    text:
      `**💰 Greed Chamber · Round ${state.round} results**\n` +
      (collapsed
        ? "The chamber collapsed."
        : stayed.length
          ? "The chamber survived."
          : "The chamber is empty."),
    lines: [
      ...lines,
      state.phase === "finished"
        ? "**Final banked standings**"
        : "**Banked standings**",
      ...standings(state.players, "banked"),
    ],
  };
}

export const greedChamberEvent = {
  id: "greed_chamber",
  durationMs: SAFETY_DURATION_MS,
  available() {
    return true;
  },
  start({ now, rules }) {
    const state = {
      phase: "choice",
      round: 1,
      startedAt: now,
      players: {},
      choices: {},
      ...(rules ? { rules: structuredClone(rules) } : {}),
    };
    return { state, view: prompt(state), nextInMs: nextInMs(state, now) };
  },
  advance({ state: previous, input, now, random = Math.random }) {
    if (previous.phase === "finished") return { state: previous };
    const state = structuredClone(previous);
    const views = [];
    // Catch up absolute phases without admitting an input to an elapsed window.
    while (true) {
      if (state.phase === "choice" && now >= closesAt(state)) {
        views.push(settle(state, random));
        if (state.phase === "finished")
          return {
            state,
            views,
            outcome: outcome(state.players, "banked", random),
          };
      }
      if (
        state.phase === "result" &&
        now >= closesAt(state) + resultDurationMs(state)
      ) {
        state.round++;
        state.phase = "choice";
        state.choices = {};
        if (now < closesAt(state)) views.push(prompt(state));
        continue;
      }
      break;
    }
    let feedback;
    if (input?.type === "button") {
      const player = state.players[input.userId];
      if (
        !validPlayer(input) ||
        input.round !== state.round ||
        state.phase !== "choice" ||
        !["stay", "escape"].includes(input.value) ||
        (player ? player.status !== "inside" : state.round !== 1)
      ) {
        feedback = EXPIRED_CHOICE;
      } else {
        const joined = !player;
        if (joined)
          state.players[input.userId] = {
            score: 0,
            banked: 0,
            status: "inside",
          };
        state.choices[input.userId] = input.value;
        feedback = choiceFeedback(
          state,
          input.value === "stay" ? "Stay" : "Escape",
        );
        if (joined) {
          if (views.at(-1)?.phase === "choice") views.pop();
          views.push(prompt(state));
        }
      }
    }
    return { state, views, feedback, nextInMs: nextInMs(state, now) };
  },
};
