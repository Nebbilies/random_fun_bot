import { getGameConfig } from "../../lib/gameConfig.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  escapeMarkdown,
  MessageFlags,
  SectionBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import {
  findFranchises,
  isFranchiseCatalogCurrent,
  loadFranchiseCharacters,
  loadFranchiseCover,
  loadMainFranchiseIndex,
} from "../../lib/franchiseLookup.js";
import { formatNumber } from "../../lib/formatNumber.js";
import {
  characterListName,
  markCharacterOwnership,
} from "../../lib/characterOwnershipDisplay.js";

const CHARACTER_PAGE_SIZE = 15;
const FRANCHISE_PAGE_SIZE = 25;

function short(value, length = 100) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function button(id, label, disabled) {
  return new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

function container(content) {
  return new ContainerBuilder()
    .setAccentColor(0x5865f2)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

export async function runFranchiseCommand(ctx) {
  const { catalogDb: db } = ctx.yoshiko;
  const query = ctx.args.slice(1).join(" ").trim();
  if (!query) {
    await ctx.message.reply(`Usage: ${ctx.prefix}${ctx.args[0]} <franchise>`);
    return;
  }
  const snapshot = ctx.yoshiko.catalogSnapshot;
  const directOnly = snapshot
    ? !snapshot.franchiseCurrent
    : !isFranchiseCatalogCurrent(db);
  const coverOptions = { directOnly };
  const index = snapshot?.mainFranchiseIndex ?? loadMainFranchiseIndex(db);
  const franchises = findFranchises(index, query);
  if (!franchises.length) {
    await ctx.message.reply(
      "No franchise found. Try a fuller title or another alias.",
    );
    return;
  }

  const showRank = Boolean(ctx.showRank);
  const guildId = ctx.message.guildId ?? null;
  let page = 0;
  let franchisePage = 0;
  let selected = franchises.length === 1 ? franchises[0] : null;
  let characters = selected
    ? loadFranchiseCharacters(db, selected.id, guildId, { mainOnly: true })
    : [];
  let cover = selected
    ? loadFranchiseCover(db, selected.id, coverOptions)
    : null;
  if (selected && !characters.length) {
    await ctx.message.reply(
      "No current catalog characters found in that franchise.",
    );
    return;
  }

  const render = (disabled = false) => {
    if (!selected) {
      const pages = Math.ceil(franchises.length / FRANCHISE_PAGE_SIZE);
      const options = franchises
        .slice(
          franchisePage * FRANCHISE_PAGE_SIZE,
          (franchisePage + 1) * FRANCHISE_PAGE_SIZE,
        )
        .map((item) => ({
          label: short(item.name),
          value: String(item.id),
        }));
      return [
        container(
          `## Choose a franchise\n${formatNumber(franchises.length)} matches • Page ${franchisePage + 1} of ${pages}`,
        )
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId("franchise:choose")
                .setPlaceholder("Select a franchise")
                .setDisabled(disabled)
                .addOptions(options),
            ),
          )
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              button(
                "franchise:franchise:prev",
                "Previous",
                disabled || franchisePage === 0,
              ),
              button(
                "franchise:franchise:next",
                "Next",
                disabled || franchisePage === pages - 1,
              ),
            ),
          ),
      ];
    }

    if (!characters.length)
      return [
        container(
          `## ${escapeMarkdown(selected.name)}\nNo current catalog characters found in this franchise.`,
        ),
      ];
    const pages = Math.max(
      1,
      Math.ceil(characters.length / CHARACTER_PAGE_SIZE),
    );
    const visible = markCharacterOwnership(
      db,
      guildId,
      characters.slice(
        page * CHARACTER_PAGE_SIZE,
        (page + 1) * CHARACTER_PAGE_SIZE,
      ),
    );
    const lines = visible.map((character) => {
      const owner =
        ctx.showOwner && character.ownerId ? ` => <@${character.ownerId}>` : "";
      const name =
        characterListName(character.name_full, character.married) + owner;
      return showRank ? `#${formatNumber(character.rank)} - ${name}` : name;
    });
    const content = `## ${escapeMarkdown(selected.name)}\n${formatNumber(characters.length)} characters • Page ${page + 1} of ${pages}\n\n${lines.join("\n")}`;
    const result = new ContainerBuilder().setAccentColor(0x5865f2);
    if (cover)
      result.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(content),
          )
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(cover)),
      );
    else
      result.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(content),
      );
    return [
      result.addActionRowComponents(
        new ActionRowBuilder().addComponents(
          button(
            "franchise:characters:prev",
            "Previous",
            disabled || page === 0,
          ),
          button(
            "franchise:characters:next",
            "Next",
            disabled || page === pages - 1,
          ),
        ),
      ),
    ];
  };

  const sent = await ctx.message.reply({
    flags: MessageFlags.IsComponentsV2,
    components: render(),
    allowedMentions: { parse: [] },
  });
  if (!sent?.createMessageComponentCollector) return;
  const controlLifetime = getGameConfig(
    ctx.yoshiko.catalogDb,
    ctx.message.guildId,
  ).controls.lifetimeMs;
  const collector = sent.createMessageComponentCollector({
    time: controlLifetime,
  });
  const ownerId = ctx.message.author?.id;
  let busy = false;
  let expired = false;

  collector.on("collect", async (interaction) => {
    if (ownerId && interaction.user.id !== ownerId) {
      await interaction.reply({
        content: "Only the command user can change these results.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (busy || expired) return;
    busy = true;
    try {
      await interaction.deferUpdate();
      if (interaction.customId === "franchise:choose" && !selected) {
        selected =
          franchises.find(
            (item) => String(item.id) === interaction.values?.[0],
          ) ?? null;
        if (selected) {
          characters = loadFranchiseCharacters(db, selected.id, guildId, {
            mainOnly: true,
          });
          cover = loadFranchiseCover(db, selected.id, coverOptions);
          page = 0;
        }
      } else if (
        interaction.customId === "franchise:franchise:prev" &&
        franchisePage > 0
      )
        franchisePage--;
      else if (
        interaction.customId === "franchise:franchise:next" &&
        (franchisePage + 1) * FRANCHISE_PAGE_SIZE < franchises.length
      )
        franchisePage++;
      else if (interaction.customId === "franchise:characters:prev" && page > 0)
        page--;
      else if (
        interaction.customId === "franchise:characters:next" &&
        selected &&
        (page + 1) * CHARACTER_PAGE_SIZE < characters.length
      )
        page++;
      await sent.edit({
        components: render(expired),
        allowedMentions: { parse: [] },
      });
      collector.resetTimer?.();
    } catch (error) {
      console.error("Franchise command interaction failed:", error);
    } finally {
      busy = false;
    }
  });
  collector.on("end", async () => {
    expired = true;
    try {
      await sent.edit({
        components: render(true),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error("Franchise command expiry update failed:", error);
    }
  });
}
