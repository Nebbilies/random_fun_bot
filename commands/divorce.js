import { currentSeason } from "../features/seasons/seasonStore.js";
import { getGameConfig } from "../lib/gameConfig.js";
import {
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextDisplayBuilder,
} from "discord.js";
import { divorceCharacters, listMarriages } from "../lib/characterMarriage.js";
import { formatNumber } from "../lib/formatNumber.js";
import {
  CHARACTER_BATCH_LIMIT,
  characterSelectionProgress,
  planCharacterSelection,
} from "../lib/characterBatchSelection.js";
import {
  CHARACTER_PICKER_PAGE_SIZE,
  characterActionRow,
  characterBatchLine,
  characterPickerComponents,
  characterPickerPage,
  displayCharacterQuery,
} from "../lib/characterBatchPresentation.js";

function button(id, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

/** @param {import('../lib/characterMarriage.js').MarriageRow[]} rows */
function confirmationComponents(rows, disabled = false) {
  const [first] = rows;
  const text =
    rows.length === 1
      ? `## Divorce **${displayCharacterQuery(characterName(first))}**?\n#${formatNumber(first.rank)} • Character ID ${first.characterId} • Owner <@${first.ownerId}>`
      : `## Divorce ${rows.length} characters?\nOwner <@${first.ownerId}>\n${divorceList(rows)}`;
  return [
    new ContainerBuilder()
      .setAccentColor(0xed4245)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text))
      .addActionRowComponents(
        characterActionRow(
          button("divorce:confirm", "Divorce", ButtonStyle.Danger, disabled),
          button("divorce:cancel", "Cancel", ButtonStyle.Secondary, disabled),
        ),
      ),
  ];
}

function characterName(row) {
  return row.name_full || `Character ${row.characterId}`;
}

function divorceList(rows) {
  return rows
    .map((row) =>
      characterBatchLine({ name: characterName(row), rank: row.rank }),
    )
    .join("\n");
}

function duplicateMessage(row) {
  return `**${displayCharacterQuery(characterName(row))}** is listed more than once. Run the command with a corrected list.`;
}

function resultComponents(message) {
  return [
    new ContainerBuilder()
      .setAccentColor(0x5865f2)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(message)),
  ];
}

function isAdministrator(permissions) {
  return Boolean(permissions?.has(PermissionFlagsBits.Administrator));
}

export async function run(ctx) {
  const actorId = ctx.message.author.id;
  const guildId = ctx.message.guildId;
  const words = ctx.args.slice(1);
  const targetToken = words[0];
  const mention = targetToken?.match(/^<@!?(\d+)>$/);
  const targetIsId = /^\d+$/.test(targetToken ?? "");
  const targetId = mention?.[1] ?? (targetIsId ? targetToken : actorId);
  if (mention || targetIsId) words.shift();
  if (
    targetId !== actorId &&
    !isAdministrator(ctx.message.member?.permissions)
  ) {
    await ctx.message.reply(
      "Only an Administrator can divorce another user’s character.",
    );
    return;
  }
  const query = words.join(" ").trim();
  if (!query) {
    await ctx.message.reply(
      `Usage: ${ctx.prefix}divorce [@user or user ID] <name or #rank> [$ <name or #rank> ...]. Choose up to ${CHARACTER_BATCH_LIMIT} characters.`,
    );
    return;
  }

  const db = ctx.yoshiko.catalogDb;
  const season = currentSeason(db, guildId)?.season;
  const marriages = listMarriages(db, guildId, targetId, "rank");
  const plan = planCharacterSelection(marriages, query, {
    exactSingleCharacter: true,
  });
  if (plan.status === "limit")
    return ctx.message.reply(
      `Choose up to ${CHARACTER_BATCH_LIMIT} characters.`,
    );
  if (plan.status === "empty")
    return ctx.message.reply(
      "A character name is missing before or after `$`. Run the command with a corrected list.",
    );
  if (plan.status === "missing")
    return ctx.message.reply({
      content: `No matching married character found for **${displayCharacterQuery(plan.query)}**. Run the command with a corrected name or list.`,
      allowedMentions: { parse: [] },
    });

  const { entries } = plan;
  let selection = characterSelectionProgress(entries);
  if (selection.status === "duplicate")
    return ctx.message.reply({
      content: duplicateMessage(selection.row),
      allowedMentions: { parse: [] },
    });
  let page = 0;
  let step = 0;
  let expired = false;
  let finished = false;
  let busy = false;
  function pickerId(action) {
    return entries.length === 1
      ? `divorce:${action}`
      : `divorce:${action}:${step}`;
  }
  function render(disabled = false) {
    if (selection.status === "ready")
      return confirmationComponents(selection.rows, disabled);
    if (selection.status === "duplicate")
      return resultComponents(duplicateMessage(selection.row));
    const { entry } = selection;
    return characterPickerComponents({
      matches: entry.matches,
      page,
      disabled,
      title: "Choose a marriage to end",
      detail: `Pick the character you meant by **${displayCharacterQuery(entry.query)}**.`,
      chooseId: pickerId("choose"),
      previousId: pickerId("prev"),
      nextId: pickerId("next"),
    });
  }
  const reply = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: render(),
    allowedMentions: { parse: [] },
  });
  if (!reply?.createMessageComponentCollector) return;
  const controlLifetime = getGameConfig(db, guildId).controls.lifetimeMs;
  const collector = reply.createMessageComponentCollector({
    time: controlLifetime,
  });
  async function finish(message) {
    finished = true;
    collector.stop();
    await reply.edit({
      components: resultComponents(message),
      allowedMentions: { parse: [] },
    });
  }
  collector.on("collect", async (interaction) => {
    let ownsLock = false;
    try {
      if (interaction.user.id !== actorId || interaction.guildId !== guildId) {
        await interaction.reply({
          content: "Only the command user can decide this divorce.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (expired || finished || busy) {
        await interaction.reply({
          content: "This divorce prompt is no longer available.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      busy = true;
      ownsLock = true;
      await interaction.deferUpdate();
      if (expired || finished) return;
      const id = interaction.customId;
      if (selection.status === "choose") {
        const { entry } = selection;
        if (id === pickerId("choose")) {
          const choice = characterPickerPage(entry.matches, page).find(
            (row) => String(row.characterId) === interaction.values?.[0],
          );
          if (!choice) return;
          entry.row = choice;
          selection = characterSelectionProgress(entries);
          page = 0;
          step++;
          if (selection.status === "duplicate")
            return await finish(duplicateMessage(selection.row));
        } else if (id === pickerId("prev") && page > 0) {
          page--;
        } else if (
          id === pickerId("next") &&
          (page + 1) * CHARACTER_PICKER_PAGE_SIZE < entry.matches.length
        ) {
          page++;
        } else {
          return;
        }
        await reply.edit({ components: render() });
        return;
      }
      if (selection.status !== "ready") return;
      if (id === "divorce:cancel") return await finish("Divorce cancelled.");
      if (id !== "divorce:confirm") return;
      if (
        targetId !== actorId &&
        !isAdministrator(interaction.memberPermissions)
      ) {
        return await finish(
          "Administrator permission changed. Nothing was divorced.",
        );
      }
      const selected = selection.rows;
      const findName = (characterId) => {
        const row = selected.find((row) => row.characterId === characterId);
        return row ? `**${displayCharacterQuery(characterName(row))}** — ` : "";
      };
      let result;
      try {
        result = divorceCharacters(db, {
          guildId,
          ownerId: targetId,
          season,
          characters: selected.map((row) => ({
            characterId: row.characterId,
            marriageId: row.id,
          })),
        });
      } catch (error) {
        console.error("Divorce write failed:", error);
        return await finish(
          error.code?.startsWith("SEASON_")
            ? error.message
            : `${findName(error?.characterId)}the ownership update failed. Nothing was divorced.`,
        );
      }
      if (result.status !== "divorced") {
        const reason =
          result.status === "stale"
            ? "the marriage has changed"
            : "the character is committed to another action";
        return await finish(
          `${findName(result.characterId)}${reason}. Nothing was divorced.`,
        );
      }
      await finish(
        selected.length === 1
          ? `Divorced **${displayCharacterQuery(characterName(selected[0]))}**.`
          : `Divorced ${selected.length} characters.\n${divorceList(selected)}`,
      );
    } catch (error) {
      console.error("Divorce interaction failed:", error);
      if (interaction.replied || interaction.deferred) {
        await interaction
          .followUp({
            content: "Divorce failed. Please try again later.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(console.error);
      }
    } finally {
      if (ownsLock) busy = false;
    }
  });
  collector.on("end", () => {
    expired = true;
    if (!finished)
      reply.edit({ components: render(true) }).catch(console.error);
  });
}
