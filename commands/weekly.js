import {
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import {
  weeklyThemes,
  weeklyView,
} from "../features/weeklyEvents/weeklyEvents.js";
import { formatNumber } from "../lib/formatNumber.js";

function prizeDescription(theme, rules) {
  switch (theme) {
    case "steals":
      return `**+${rules.extraCharges} ${rules.extraCharges === 1 ? "chance" : "chances"}** per qualifying steal or divorce item earned.`;
    case "affection":
      return `**+${Math.round(rules.affectionRate * 100)}%** to all affection gained (minimum ${rules.affectionMinimum} extra).`;
    case "wishes":
      return `**${rules.wishMultiplier}× roll chance** for eligible characters on your wishlist.`;
    case "reclaims":
      return `**${Math.round(rules.reclaimChance * 100)}% chance** to automatically reclaim each eligible character that escapes.`;
    case "mystery":
      return `**${rules.vaultsPerWin} free ${rules.vaultsPerWin === 1 ? "vault" : "vaults"}** per mystery event win.`;
    case "franchise":
      return `**${Math.round(rules.claimChance * 100)}% chance** to restore a spent normal claim, with ${rules.claimAttempts} ${rules.claimAttempts === 1 ? "attempt" : "attempts"} per claim window.`;
  }
}

function pointsLabel(points) {
  return `${formatNumber(points)} ${points === 1 ? "point" : "points"}`;
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
    .map(
      (row, index) =>
        `${index + 1}. <@${row.user_id}> (**${pointsLabel(row.points)}**)`,
    )
    .join("\n");
  const standing = view.rank
    ? `You’re **#${formatNumber(view.rank)}** with **${pointsLabel(view.score)}**.`
    : "You’re unranked with **0 points**.";
  const prize = prizeDescription(theme, JSON.parse(rules));
  const card = new ContainerBuilder()
    .setAccentColor(0x9e598f)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Weekly Event\n## ${title}\n${condition}\n-# Ends <t:${Math.floor(endsAt / 1000)}:F>`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Winner’s prize for next week**\n${prize}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**Leaderboard**\n${leaders || "No scores yet."}`,
      ),
    )
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**Your standing**\n${standing}`),
    );
  await message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: [card],
    allowedMentions: { parse: [], repliedUser: false },
  });
}
