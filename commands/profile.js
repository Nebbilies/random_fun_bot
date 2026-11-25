import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  escapeMarkdown,
} from "discord.js";
import { truncate } from "../lib/affectionPresentation.js";
import { loadProfileCardData, profileSeasons } from "../lib/profileCardData.js";
import { getGameConfig } from "../lib/gameConfig.js";
import { claimedCollectorInteractions } from "../app/events/collectorInteractions.js";

const mentions = { parse: [], repliedUser: false };
const filename = "profile-card.png";
const progress = (line) => ({
  content: `Rendering your profile card...\n-# ${line}`,
  allowedMentions: mentions,
});
const pageSize = 24;

function seasonControls(seasons, selected, page, disabled = false) {
  if (!seasons) return [];
  const menu = new StringSelectMenuBuilder()
    .setCustomId("profile:season")
    .setPlaceholder("Choose a season")
    .setDisabled(disabled);
  menu.addOptions(
    {
      label: `Current season · Season ${seasons.current}`,
      value: "current",
      default: selected === null,
    },
    ...seasons.archived
      .slice(page * pageSize, (page + 1) * pageSize)
      .map((season) => ({
        label: `Season ${season}`,
        value: String(season),
        default: selected === season,
      })),
  );
  const rows = [new ActionRowBuilder().addComponents(menu)];
  if (seasons.archived.length > pageSize)
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("profile:previous")
          .setLabel("Previous seasons")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled || page === 0),
        new ButtonBuilder()
          .setCustomId("profile:next")
          .setLabel("More seasons")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(
            disabled || (page + 1) * pageSize >= seasons.archived.length,
          ),
      ),
    );
  return rows;
}

export function createProfileCommand({
  preparePortraits = async (model) =>
    (await import("../lib/profileCardRenderer.js")).preparePortraits(model),
  renderProfileCard = async (model, portraits) =>
    (await import("../lib/profileCardRenderer.js")).renderProfileCard(
      model,
      portraits,
    ),
  reportFailure = (error) => console.error("Profile card failed:", error),
} = {}) {
  return async function run({ yoshiko, message, args, prefix }) {
    if (!message.guildId) return;
    if (args.length !== 1) {
      await message.reply({
        content: `Usage: \`${prefix}profile\``,
        allowedMentions: mentions,
      });
      return;
    }

    const db = yoshiko.catalogDb;
    const reply = await message.reply(progress("Loading collection stats..."));
    let selected = null;
    let page = 0;
    let seasons = profileSeasons(db, message.guildId, message.author.id);
    let failure = "Couldn’t load collection stats. Please try again.";
    async function render(initial = false) {
      failure = "Couldn’t load collection stats. Please try again.";
      const model = await loadProfileCardData(db, message, selected);
      failure = "Couldn’t prepare portraits. Please try again.";
      if (initial) await reply.edit(progress("Preparing portraits..."));
      const portraits = await preparePortraits(model);
      failure = "Couldn’t render your profile card. Please try again.";
      if (initial) await reply.edit(progress("Rendering image..."));
      const png = await renderProfileCard(model, portraits);
      failure = "Couldn’t upload your profile card. Please try again.";
      const titleSuffix = "'s Profile Card";
      const title =
        truncate(escapeMarkdown(model.displayName), 256 - titleSuffix.length) +
        titleSuffix;
      const embed = new EmbedBuilder()
        .setTitle(title)
        .setImage(`attachment://${filename}`);
      if (seasons)
        embed.setDescription(`Season ${selected ?? seasons.current}`);
      await reply.edit({
        content: null,
        embeds: [embed],
        attachments: [],
        files: [new AttachmentBuilder(png, { name: filename })],
        components: seasonControls(seasons, selected, page),
        allowedMentions: mentions,
      });
    }
    try {
      await render(true);
    } catch (error) {
      if (error.code === "SEASON_CUTOFF") {
        await reply.edit({
          content: error.message,
          components: seasonControls(seasons, selected, page),
          allowedMentions: mentions,
        });
        if (!seasons?.archived.length) return;
      } else {
        reportFailure(error);
        await reply.edit(progress(failure)).catch(reportFailure);
        return;
      }
    }
    if (!seasons || !reply.createMessageComponentCollector) return;
    const collector = reply.createMessageComponentCollector({
      time: getGameConfig(db, message.guildId).controls.lifetimeMs,
    });
    let update = Promise.resolve();
    collector.on("collect", async (interaction) => {
      if (!interaction.customId?.startsWith("profile:")) return;
      claimedCollectorInteractions.add(interaction);
      if (
        interaction.user.id !== message.author.id ||
        interaction.guildId !== message.guildId
      ) {
        await interaction
          .reply({
            content:
              "Only the person who opened this card can change its season.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(reportFailure);
        return;
      }
      const acknowledgement = interaction.deferUpdate().then(
        () => true,
        (error) => {
          reportFailure(error);
          return false;
        },
      );
      update = update
        .then(async () => {
          if (!(await acknowledgement)) return;
          seasons = profileSeasons(db, message.guildId, message.author.id);
          const previous = selected;
          if (interaction.customId === "profile:previous")
            page = Math.max(page - 1, 0);
          else if (interaction.customId === "profile:next")
            page = Math.min(
              page + 1,
              Math.max(0, Math.ceil(seasons.archived.length / pageSize) - 1),
            );
          else if (interaction.customId === "profile:season") {
            const choice = interaction.values?.[0];
            if (choice === "current") selected = null;
            else if (seasons.archived.includes(Number(choice)))
              selected = Number(choice);
            else return;
            try {
              await render();
            } catch (error) {
              selected = previous;
              if (error.code !== "SEASON_CUTOFF") reportFailure(error);
              const content =
                error.code === "SEASON_CUTOFF" ? error.message : failure;
              await interaction
                .followUp({ content, flags: MessageFlags.Ephemeral })
                .catch(reportFailure);
            }
            return;
          } else return;
          await reply.edit({
            components: seasonControls(seasons, selected, page),
          });
        })
        .catch(reportFailure);
    });
    collector.on("end", () => {
      update
        .then(() =>
          reply.edit({
            components: seasonControls(seasons, selected, page, true),
          }),
        )
        .catch(reportFailure);
    });
  };
}

export const run = createProfileCommand();
