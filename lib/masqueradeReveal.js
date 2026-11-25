import { setTimeout as delay } from "node:timers/promises";
import {
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  TextDisplayBuilder,
  escapeMarkdown,
} from "discord.js";
import {
  characterSeries,
  hydrateCharacterFranchises,
} from "./characterSeries.js";
import { formatNumber } from "./formatNumber.js";
import { itemUseFeedback } from "./affectionPresentation.js";

const allowedMentions = { parse: [], repliedUser: false };
const text = (content) => ({
  flags: MessageFlags.IsComponentsV2,
  components: [new TextDisplayBuilder().setContent(content)],
  allowedMentions,
});

function characterCard(db, contribution, ownerId) {
  const character = db
    .prepare("SELECT * FROM characters WHERE id=?")
    .get(contribution.characterId);
  if (character) hydrateCharacterFranchises(db, [character]);
  const anime = characterSeries(character).text;
  const name = character?.name_full ?? contribution.name;
  const container = new ContainerBuilder()
    .setAccentColor(0x8b4513)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`# ${escapeMarkdown(name)}`),
      new TextDisplayBuilder().setContent(escapeMarkdown(anime)),
      new TextDisplayBuilder().setContent(
        `**Rank:** #${formatNumber(character?.rank ?? contribution.rank)}`,
      ),
    );
  if (character?.image_url)
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(character.image_url)
          .setDescription(name),
      ),
    );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`Married by <@${ownerId}>`),
  );
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    allowedMentions,
  };
}

/** The committed assignment is the only source of recipients; never reroll during delivery. */
export async function publishMasqueradeReveal({
  db,
  action,
  channel,
  message,
  saveProgress,
  wait = delay,
}) {
  const { targets: pool, assignment } = action.result;
  let step = action.selections._ui?.masqueradeRevealStep ?? 0;
  if (step === 0) {
    const header = text(
      itemUseFeedback(
        `# <@${action.actor_id}> has used Grand Masquerade! 🎭`,
        action.result,
      ),
    );
    message = await channel.send(header);
    saveProgress(++step, message.id);
  }
  // Recipient order: activator, then the three nominated owners.
  while (step <= pool.length * 2) {
    await wait(3000);
    const recipientIndex = Math.floor((step - 1) / 2);
    const ownerId = pool[recipientIndex].ownerId;
    const contribution = pool[assignment.indexOf(recipientIndex)];
    await channel.send(
      step % 2 === 1
        ? text(`❓ <@${ownerId}> has received...`)
        : characterCard(db, contribution, ownerId),
    );
    saveProgress(++step, message?.id ?? action.message_id);
  }
}
