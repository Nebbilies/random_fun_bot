import { ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder, escapeMarkdown } from 'discord.js';
import { characterSeries, hydrateCharacterFranchises } from './characterSeries.js';
import { formatNumber } from './formatNumber.js';

export const itemNoMentions = { parse: [], repliedUser: false };
export const itemText = (content) => new TextDisplayBuilder().setContent(content);

/** Cards describe the committed outcome, never infer current ownership. */
export function itemCharacterCard(db, contribution, footer) {
  const id = contribution.characterId ?? contribution.character_id ?? contribution.id;
  const character = db.prepare('SELECT * FROM characters WHERE id=?').get(id);
  if (character) hydrateCharacterFranchises(db, [character]);
  const name = character?.name_full ?? contribution.name ?? contribution.name_full ?? 'Unknown character';
  const container = new ContainerBuilder().setAccentColor(0x8b4513).addTextDisplayComponents(
    itemText(`# ${escapeMarkdown(name)}`),
    itemText(escapeMarkdown(characterSeries(character).text)),
    itemText(`**Rank:** #${formatNumber(contribution.snapshotRank ? contribution.rank : character?.rank ?? contribution.rank ?? 0)}\n**Likes:** ${formatNumber(character?.favourites ?? 0)}`),
  );
  if (character?.image_url) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(character.image_url).setDescription(name),
  ));
  container.addTextDisplayComponents(itemText(footer));
  return container;
}

/** The item header is a top-level text component ABOVE the card containers. */
export function itemCharacterResult(db, { title, message, cards, ephemeral = false }) {
  return { flags: MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0),
    components: [itemText(`# ${title}`), ...(message ? [itemText(message)] : []),
      ...cards.map(({ character, footer }) => itemCharacterCard(db, character, footer))],
    allowedMentions: itemNoMentions };
}

export function immediateActionCards(action) {
  const result = action.result;
  if (action.state !== 'resolved' || !result || result.blocked || result.noCost) return [];
  if (['blood_pact', 'master_key', 'pickpockets_hook', 'wish_upon_a_star', 'chronicle_of_return'].includes(action.kind)) return [{ character: result.character, footer: `Married by <@${action.actor_id}>` }];
  if (action.kind === 'counterfeit_crown') return [{ character: result.privateCharacter, footer: `Secret decoy for <@${action.actor_id}>` }];
  if (['heart_for_a_heart', 'severed_fate'].includes(action.kind)) {
    const divorced = [...(action.kind === 'heart_for_a_heart' ? [action.selections.own] : []), ...result.targets];
    return divorced.map((character) => ({ character, footer: `Divorced from <@${character.ownerId}> · Nobody receives this character.` }));
  }
  return [];
}
