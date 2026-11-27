import {
  weeklyThemes,
  weeklyView,
} from "../features/weeklyEvents/weeklyEvents.js";

function prizeDescription(theme, rules) {
  switch (theme) {
    case "steals":
      return `+${rules.extraCharges} charge per qualifying item earned.`;
    case "affection":
      return `+${Math.round(rules.affectionRate * 100)}% affection (minimum ${rules.affectionMinimum} extra).`;
    case "wishes":
      return `${rules.wishMultiplier}× weight for eligible characters on your wishlist.`;
    case "reclaims":
      return `${Math.round(rules.reclaimChance * 100)}% automatic reclaim chance per eligible escape.`;
    case "mystery":
      return `${rules.vaultsPerWin} free vault(s) per mystery win.`;
    case "franchise":
      return `${Math.round(rules.claimChance * 100)}% chance to restore a spent normal claim, ${rules.claimAttempts} attempt(s) per claim window.`;
  }
}

export async function run({ yoshiko, message }) {
  const view = weeklyView(
    yoshiko.catalogDb,
    message.guildId,
    message.author.id,
    Date.now(),
  );
  if (!view.contest) {
    await message.reply(
      view.controls?.enabled
        ? "The next Weekly Event is waiting for its scheduled start."
        : "Weekly Events are disabled here.",
    );
    return;
  }
  const { theme, ends_at: endsAt, rules } = view.contest;
  const [title, condition] = weeklyThemes[theme];
  const leaders = view.leaders
    .map((row, index) => `${index + 1}. <@${row.user_id}> · ${row.points}`)
    .join("\n");
  const rank = view.rank
    ? `Your rank: #${view.rank} · ${view.score}`
    : "Your score: 0 · Unranked";
  await message.reply({
    embeds: [
      {
        title: `Weekly Event · ${title}`,
        description: condition,
        fields: [
          { name: "Prize", value: prizeDescription(theme, JSON.parse(rules)) },
          { name: "Leaderboard", value: leaders || "No scores yet." },
        ],
        footer: { text: rank },
      },
    ],
    content: `Ends <t:${Math.floor(endsAt / 1000)}:F>.`,
    allowedMentions: { parse: [], repliedUser: false },
  });
}
