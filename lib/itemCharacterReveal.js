import { setTimeout as delay } from 'node:timers/promises';
import { MessageFlags } from 'discord.js';
import { getItemDefinition } from './itemRoster.js';
import { itemCharacterResult, itemNoMentions, itemText } from './itemCharacterPresentation.js';

const staged = new Set(['chaos_exchange', 'pickpockets_hook', 'wish_upon_a_star']);
export function characterRevealPlan(action) {
  if (action.state !== 'resolved') return null;
  if (action.kind === 'hostage_note' && action.result?.choice === 'gamble') {
    const loser = action.result.loser;
    return { title: 'Hostage Note — the Gamble is decided',
      teaser: '🎲 Will the victim’s nominated character keep their bond? The item user’s character is safe…',
      message: action.result.message, cards: loser ? [{ character: loser,
        footer: `Divorced from <@${loser.ownerId}> · The item user's character remains owned.` }] : [] };
  }
  if (!staged.has(action.kind) || !action.result?.character) return null;
  const title = `${getItemDefinition(action.kind).name} — <@${action.actor_id}>`;
  const teaser = action.kind === 'pickpockets_hook' ? `❓ <@${action.actor_id}> has stolen…`
    : action.kind === 'wish_upon_a_star' ? `❓ <@${action.actor_id}> has summoned…`
    : `❓ <@${action.actor_id}> has received…`;
  return { title, teaser, message: action.result.message,
    cards: [{ character: action.result.character, footer: `Married by <@${action.actor_id}>` }] };
}

/** Edit one durable message: commit first, then reveal. Retrying a step is idempotent. */
export async function publishItemCharacterReveal({ db, action, channel, message, saveProgress, wait = delay }) {
  const plan = characterRevealPlan(action);
  if (!plan) return;
  let step = action.selections._ui?.itemRevealStep ?? 0;
  const text = (body) => ({ flags: MessageFlags.IsComponentsV2,
    components: [itemText(`# ${plan.title}`), itemText(body)], allowedMentions: itemNoMentions });
  const show = async (data, next) => {
    if (message) await message.edit(data);
    else message = await channel.send(data);
    await saveProgress(next, message.id);
    step = next;
  };
  if (!message) {
    // A deleted message is replaced safely at the persisted stage, not rerolled.
    await show(step >= 3 ? itemCharacterResult(db, plan) : text(step >= 2 ? plan.teaser : 'The outcome is sealed…'), Math.max(1, step));
  } else if (step === 0) await show(text('The outcome is sealed…'), 1);
  if (step === 1) { await wait(3000); await show(text(plan.teaser), 2); }
  if (step === 2) { await wait(3000); await show(itemCharacterResult(db, plan), 3); }
}
