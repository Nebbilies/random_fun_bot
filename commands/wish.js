import {
  ActionRowBuilder, ContainerBuilder, escapeMarkdown, MessageFlags, StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { findCharacters } from '../lib/gameCharacterLookup.js';
import { formatNumber } from '../lib/formatNumber.js';
import {
  WISHLIST_LIMIT, addWish, clearWishes, getWishes, matchWishes, removeWish,
} from '../lib/characterWishlist.js';

const CONTROL_LIFETIME_MS = 60 * 60 * 1000;
const CHOOSE_ID = 'wish:choose';

function label(wish) {
  return wish.rank == null ? `#? • ${wish.name}` : `#${formatNumber(wish.rank)} • ${wish.name}`;
}

export function wishlistView(wishes, prefix = '!') {
  const lines = wishes.map((wish) => wish.inCatalog && wish.rank != null
    ? `#${formatNumber(wish.rank)} • ${escapeMarkdown(wish.name)}`
    : `#? • ${escapeMarkdown(wish.name)} (not in catalog)`);
  const body = lines.length ? lines.join('\n') : `No wishes yet. Add one with ${prefix}wish <name>.`;
  return new ContainerBuilder().setAccentColor(0x5865f2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## Wishlist (${wishes.length}/${WISHLIST_LIMIT})`),
      new TextDisplayBuilder().setContent(body),
    );
}

function listPayload(wishes, prefix) {
  return { flags: MessageFlags.IsComponentsV2, components: [wishlistView(wishes, prefix)],
    allowedMentions: { parse: [], repliedUser: false } };
}

function pickerPayload(wishes, mode) {
  const options = wishes.slice(0, 25).map((wish) => ({
    label: escapeMarkdown(label(wish)).slice(0, 100), value: String(wish.characterId),
  }));
  const menu = new StringSelectMenuBuilder().setCustomId(CHOOSE_ID)
    .setPlaceholder(mode === 'remove' ? 'Select a wish to remove' : 'Select a character to wish for')
    .addOptions(options);
  return { flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [], repliedUser: false },
    components: [new ContainerBuilder().setAccentColor(0x5865f2)
      .addTextDisplayComponents(new TextDisplayBuilder()
        .setContent(mode === 'remove' ? '## Remove a wish' : '## Choose a character'))
      .addActionRowComponents(new ActionRowBuilder().addComponents(menu))] };
}

function wishesOf(ctx) {
  return getWishes(ctx.yoshiko.catalogDb, {
    guildId: ctx.message.guildId, userId: ctx.message.author.id,
  });
}

/** Renders the caller's wishlist. The `!wl` and `!wishlist` aliases use this directly. */
export async function listWishes(ctx) {
  await ctx.message.reply(listPayload(wishesOf(ctx), ctx.prefix));
}

function refusal(status, count, name, prefix) {
  if (status === 'full') {
    return `Your wishlist is full (${count}/${WISHLIST_LIMIT}). Remove one with ${prefix}wish remove <name>.`;
  }
  return `**${escapeMarkdown(name)}** is already on your wishlist.`;
}

async function save(ctx, characterId, name, { target }) {
  const result = addWish(ctx.yoshiko.catalogDb, { guildId: ctx.message.guildId,
    userId: ctx.message.author.id, characterId });
  if (result.status !== 'added') {
    const content = refusal(result.status, result.count, name, ctx.prefix);
    if (target) await target.reply({ content, flags: MessageFlags.Ephemeral });
    else await ctx.message.reply(content);
    return;
  }
  if (target) await target.update(listPayload(wishesOf(ctx), ctx.prefix));
  else await ctx.message.reply(listPayload(wishesOf(ctx), ctx.prefix));
}
/**
 * Shows the `!char` style picker and applies the caller's choice to the same message.
 * @param {'add' | 'remove'} mode
 */
async function pick(ctx, wishes, mode) {
  const reply = await ctx.message.reply(pickerPayload(wishes, mode));
  if (!reply?.createMessageComponentCollector) return;
  const collector = reply.createMessageComponentCollector({ time: CONTROL_LIFETIME_MS });
  const ownerId = ctx.message.author.id;
  collector.on('collect', async (interaction) => {
    if (interaction.customId !== CHOOSE_ID) return;
    if (interaction.user.id !== ownerId) {
      await interaction.reply({ content: 'Only the command author can use this picker.',
        flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }
    const characterId = Number(interaction.values?.[0]);
    const wish = wishes.find((entry) => entry.characterId === characterId);
    if (!wish) { await interaction.deferUpdate().catch(() => {}); return; }
    try {
      if (mode === 'remove') {
        removeWish(ctx.yoshiko.catalogDb, { guildId: ctx.message.guildId,
          userId: ownerId, characterId });
        await interaction.update(listPayload(wishesOf(ctx), ctx.prefix));
        return;
      }
      await save(ctx, characterId, wish.name, { target: interaction });
    } catch (error) {
      console.error('Wishlist picker failed:', error);
      await interaction.reply({ content: 'Wishlist update failed. Please try again later.',
        flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
}

async function addCommand(ctx, query) {
  const matches = findCharacters(ctx.yoshiko.characterIndex ?? [], query);
  if (!matches.length) {
    await ctx.message.reply('No character found. Try a fuller name or a rank such as #625.');
    return;
  }
  if (matches.length === 1) {
    await save(ctx, matches[0].id, matches[0].name_full, { target: null });
    return;
  }
  await pick(ctx, matches.map((character) => ({ characterId: character.id,
    name: character.name_full, rank: character.rank })), 'add');
}

async function removeCommand(ctx, query) {
  if (!query) {
    await ctx.message.reply(`Usage: ${ctx.prefix}wish remove <name or #rank>`);
    return;
  }
  const wishes = wishesOf(ctx);
  if (!wishes.length) {
    await ctx.message.reply(`Your wishlist is empty. Add one with ${ctx.prefix}wish <name>.`);
    return;
  }
  const matches = matchWishes(wishes, query);
  if (!matches.length) {
    await ctx.message.reply("That character isn't on your wishlist.");
    return;
  }
  if (matches.length > 1) {
    await pick(ctx, matches, 'remove');
    return;
  }
  removeWish(ctx.yoshiko.catalogDb, { guildId: ctx.message.guildId,
    userId: ctx.message.author.id, characterId: matches[0].characterId });
  await ctx.message.reply(listPayload(wishesOf(ctx), ctx.prefix));
}

export async function run(ctx) {
  const args = ctx.args.slice(1);
  if (!args.length) { await listWishes(ctx); return; }
  const keyword = args[0].toLowerCase();
  if (keyword === 'clear') {
    clearWishes(ctx.yoshiko.catalogDb, { guildId: ctx.message.guildId,
      userId: ctx.message.author.id });
    await ctx.message.reply(listPayload(wishesOf(ctx), ctx.prefix));
    return;
  }
  if (keyword === 'remove') { await removeCommand(ctx, args.slice(1).join(' ').trim()); return; }
  await addCommand(ctx, args.join(' ').trim());
}
