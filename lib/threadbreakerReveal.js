import { setTimeout as delay } from 'node:timers/promises';
import { MessageFlags, escapeMarkdown } from 'discord.js';
import { itemCharacterCard, itemText, itemNoMentions } from './itemCharacterPresentation.js';
import { itemUseFeedback } from './affectionPresentation.js';

const text = content => ({ flags: MessageFlags.IsComponentsV2, components: [itemText(content)], allowedMentions: itemNoMentions });

export async function publishThreadbreakerReveal({ db, action, channel, saveProgress, wait = delay }) {
  let progress = { index: 0, stage: 'header', ...action.selections._ui?.threadbreakerReveal };
  const save = patch => { progress = { ...progress, ...patch }; saveProgress(progress); };
  if (progress.stage === 'header') {
    await channel.send(text(itemUseFeedback(`# <@${action.actor_id}> has used Threadbreaker! 🥀\n**Franchise:** ${escapeMarkdown(action.result.franchise.name)}`, action.result)));
    save({ stage: 'suspense' });
  }
  while (progress.index < action.result.visited.length) {
    const target = action.result.visited[progress.index];
    const card = verdict => ({ flags: MessageFlags.IsComponentsV2,
      components: [itemCharacterCard(db, { ...target, snapshotRank: true }, `${verdict}\nBond with <@${target.ownerId}>`)], allowedMentions: itemNoMentions });
    if (progress.stage === 'suspense') {
      await wait(3000);
      const message = await channel.send(card('Their bond hangs by a thread…'));
      save({ stage: 'verdict', messageId: message.id });
    }
    if (progress.stage === 'verdict') {
      await wait(3000);
      let message;
      try { message = await channel.messages.fetch(progress.messageId); }
      catch (error) { if (error.code !== 10008) throw error; }
      const data = card(target.divorced ? '💔 Divorced' : '✨ Spared. The chain ends.');
      if (message) await message.edit(data);
      else await channel.send(data);
      save({ index: progress.index + 1, stage: 'suspense', messageId: null });
    }
  }
  if (progress.stage !== 'done') {
    await channel.send(text('## The chain ended!'));
    save({ stage: 'done' });
  }
}
