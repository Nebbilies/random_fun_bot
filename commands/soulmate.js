import { MessageFlags } from "discord.js";
import {
  hasAffection,
  getSoulmateState,
  getAffectionDetail,
  confirmSoulmate,
  seasonSoulmateWaiverAvailable,
} from "../lib/characterAffection.js";
import { currentSeason } from "../features/seasons/seasonStore.js";
import { getPerks } from "../lib/affectionRules.js";
import { isCharacterBusy } from "../lib/characterAvailability.js";
import { requireNewGameAction } from "../lib/catalogMaintenance.js";
import { findCharacters } from "../lib/gameCharacterLookup.js";
import { resolveTargetUsername } from "../lib/userTarget.js";
import {
  detailPayload,
  noSoulmatePayload,
  confirmationPayload,
  pickerPayload,
} from "../lib/affectionPresentation.js";
import {
  scopeMatches,
  rejectControl,
  controlsLifetime,
  retryOwnRewards,
  noMentions,
  normalizedDetail,
} from "./affection.js";

/** @param {string} status @param {any} [state] */
function refusal(status, state = null) {
  const messages = {
    not_owned: "You must currently own that character.",
    busy: "That character is busy. Try again when they are available.",
    cooldown: state?.switchAvailableAt
      ? `You can switch soulmates <t:${Math.floor(state.switchAvailableAt / 1000)}:R>.`
      : "You cannot switch soulmates yet. Check your soulmate status for the switching time.",
    stale:
      "Your soulmate selection changed. Run the command again to confirm the current choice.",
  };
  return (
    messages[status] ??
    "The selection could not be confirmed. Ownership, availability or selection changed. Please try again."
  );
}
export async function run(ctx) {
  const db = ctx.yoshiko.catalogDb;
  if (!hasAffection(db)) {
    await ctx.message.reply({
      content: "Affection is not available in this catalog yet.",
      allowedMentions: noMentions,
    });
    return;
  }
  const guildId = ctx.message.guildId;
  const season = currentSeason(db, guildId)?.season;
  const userId = ctx.message.author.id;
  const options = {
    ownerName: await resolveTargetUsername(ctx.message, userId),
    prefix: ctx.prefix,
    isSelf: true,
  };
  const state = getSoulmateState(db, guildId, userId);
  const query = ctx.args.slice(1).join(" ").trim();
  const profile = () => {
    const current = getSoulmateState(db, guildId, userId);
    return current.characterId == null
      ? noSoulmatePayload(options)
      : detailPayload(
          normalizedDetail(
            getAffectionDetail(db, {
              guildId,
              userId,
              characterId: current.characterId,
              now: Date.now(),
            }),
          ),
          { ...options, state: current },
        );
  };
  if (!query) {
    await retryOwnRewards(ctx, userId);
    await ctx.message.reply(profile());
    return;
  }
  const matches = findCharacters(ctx.yoshiko.characterIndex ?? [], query);
  if (!matches.length) {
    await ctx.message.reply({
      content: "No character found. Try a fuller name or #rank.",
      allowedMentions: noMentions,
    });
    return;
  }
  if (matches.length === 1 && matches[0].id === state.characterId) {
    await retryOwnRewards(ctx, userId);
    await ctx.message.reply(profile());
    return;
  }
  try {
    requireNewGameAction(db);
  } catch (error) {
    await ctx.message.reply({
      content: error.message,
      allowedMentions: noMentions,
    });
    return;
  }
  let selected = matches.length === 1 ? matches[0].id : null;
  let page = 0;
  let finished = false;
  let busy = false;
  let expired = false;
  const render = (disabled = false) => {
    if (selected == null)
      return pickerPayload(matches, { namespace: "soulmate", page, disabled });
    const detail = getAffectionDetail(db, {
      guildId,
      userId,
      characterId: selected,
    });
    if (!detail) throw new Error("Character no longer available");
    const current = getSoulmateState(db, guildId, userId);
    const status = !detail.isOwned
      ? "not_owned"
      : isCharacterBusy(db, guildId, selected, Date.now())
        ? "busy"
        : current.characterId &&
            current.characterId !== selected &&
            Date.now() < current.switchAvailableAt &&
            !seasonSoulmateWaiverAvailable(db, guildId, userId)
          ? "cooldown"
          : null;
    const currentName =
      current.characterId && current.characterId !== selected
        ? getAffectionDetail(db, {
            guildId,
            userId,
            characterId: current.characterId,
          })?.name
        : "";
    return confirmationPayload(
      {
        ...detail,
        benefits: { ...detail.benefits, perks: getPerks(detail.total) },
      },
      { disabled, reason: status ? refusal(status, current) : "", currentName },
    );
  };
  const reply = await ctx.message.reply(render());
  if (!reply?.createMessageComponentCollector) return;
  const collector = reply.createMessageComponentCollector({
    time: controlsLifetime(ctx),
  });
  collector.on("collect", async (interaction) => {
    if (!interaction.customId?.startsWith("soulmate:")) return;
    if (!scopeMatches(interaction, ctx, reply)) {
      await rejectControl(interaction);
      return;
    }
    if (finished || expired || busy) {
      await interaction.deferUpdate().catch(() => {});
      return;
    }
    busy = true;
    try {
      await interaction.deferUpdate();
      const id = interaction.customId;
      if (selected == null) {
        if (id === "soulmate:choose") {
          const choice = matches
            .slice(page * 25, (page + 1) * 25)
            .find((row) => String(row.id) === interaction.values?.[0]);
          if (!choice) return;
          selected = choice.id;
          if (selected === getSoulmateState(db, guildId, userId).characterId) {
            finished = true;
            await reply.edit(profile());
            collector.stop("same");
            return;
          }
        } else if (id === "soulmate:picknext")
          page = Math.min(Math.ceil(matches.length / 25) - 1, page + 1);
        else if (id === "soulmate:pickprev") page = Math.max(0, page - 1);
        else return;
        await reply.edit(render());
        return;
      }
      if (id === "soulmate:cancel") {
        finished = true;
        await reply.edit({
          content: "Soulmate selection cancelled.",
          embeds: [],
          components: [],
          allowedMentions: noMentions,
        });
        collector.stop("cancel");
        return;
      }
      if (id !== "soulmate:confirm") return;
      // Maintenance, ownership, busy state, cooldown and optimistic revision are rechecked at commit.
      requireNewGameAction(db);
      const result = confirmSoulmate(db, {
        guildId,
        userId,
        characterId: selected,
        expectedRevision: state.revision,
        season,
        now: Date.now(),
      });
      finished = true;
      if (["selected", "same", "unchanged"].includes(result.status))
        await reply.edit(profile());
      else
        await reply.edit({
          content: refusal(result.status, result.state),
          embeds: [],
          components: [],
          allowedMentions: noMentions,
        });
      collector.stop("confirmed");
    } catch (error) {
      console.error("Soulmate confirmation failed:", error);
      await interaction
        .followUp({
          content: error.code?.startsWith("SEASON_")
            ? error.message
            : "Could not confirm this selection. Please try again after maintenance or check your current soulmate.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: noMentions,
        })
        .catch(() => {});
    } finally {
      busy = false;
    }
  });
  collector.on("end", () => {
    expired = true;
    if (!finished) reply.edit(render(true)).catch(() => {});
  });
}
