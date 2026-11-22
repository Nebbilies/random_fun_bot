import { AttachmentBuilder, EmbedBuilder, escapeMarkdown } from 'discord.js';
import { truncate } from '../lib/affectionPresentation.js';
import { loadProfileCardData } from '../lib/profileCardData.js';

const mentions = { parse: [], repliedUser: false };
const filename = 'profile-card.png';
const progress = line => ({ content: `Rendering your profile card...\n-# ${line}`, allowedMentions: mentions });

export function createProfileCommand({
  preparePortraits = async model => (await import('../lib/profileCardRenderer.js')).preparePortraits(model),
  renderProfileCard = async (model, portraits) => (await import('../lib/profileCardRenderer.js')).renderProfileCard(model, portraits),
  reportFailure = error => console.error('Profile card failed:', error),
} = {}) {
  return async function run({ yoshiko, message, args, prefix }) {
    if (!message.guildId) return;
    if (args.length !== 1) {
      await message.reply({ content: `Usage: \`${prefix}profile\``, allowedMentions: mentions });
      return;
    }

    const reply = await message.reply(progress('Loading collection stats...'));
    let failure = 'Couldn’t load collection stats. Please try again.';
    try {
      const model = await loadProfileCardData(yoshiko.catalogDb, message);
      failure = 'Couldn’t prepare portraits. Please try again.';
      await reply.edit(progress('Preparing portraits...'));
      const portraits = await preparePortraits(model);
      failure = 'Couldn’t render your profile card. Please try again.';
      await reply.edit(progress('Rendering image...'));
      const png = await renderProfileCard(model, portraits);
      failure = 'Couldn’t upload your profile card. Please try again.';
      const titleSuffix = "'s Profile Card";
      const title = truncate(escapeMarkdown(model.displayName), 256 - titleSuffix.length) + titleSuffix;
      const embed = new EmbedBuilder().setTitle(title).setImage(`attachment://${filename}`);
      await reply.edit({ content: null, embeds: [embed], files: [new AttachmentBuilder(png, { name: filename })],
        allowedMentions: mentions });
    } catch (error) {
      reportFailure(error);
      await reply.edit(progress(failure)).catch(reportFailure);
    }
  };
}

export const run = createProfileCommand();
