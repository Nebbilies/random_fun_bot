import { EmbedBuilder, escapeMarkdown } from 'discord.js';

export async function run(ctx) {
  const prefix = ctx.prefix ?? '!';
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('PLAYER HELP')
    .setDescription(`Prefix: **${escapeMarkdown(prefix)}** • Example: **${escapeMarkdown(`${prefix}w`)}**\n`
      + '`<argument>` = required • `[argument]` = optional')
    .addFields(
      { name: 'MARRIAGE', value: [
        '**w** — Roll a waifu.',
        '**h** — Roll a husband.',
        '**ru [@user]** — Check remaining rolls and reset time.',
        '**mu [@user]** — Check claim availability and reset time.',
        '**daily** — Claim your daily roll refill.',
        '**divorce <character>** — Divorce one of your married characters.',
      ].join('\n') },
      { name: 'HAREM', value: [
        '**mm [@user]** — View married characters. Alias: **mymarry**.',
        '**mmr [@user]** — Sort married characters by rank.',
        '**mma [@user]** — Group married characters by franchise.',
        '**mmi [@user]** — Browse individual character cards.',
        '',
        'Combine modifiers: **mmar** groups by franchise and sorts by rank; **mmir** shows cards in rank order.',
      ].join('\n') },
      { name: 'CHARACTERS & FRANCHISES', value: [
        '**im <name or #rank>** — Look up a character. Alias: **char**.',
        '**ima <franchise>** — List a franchise’s characters.',
        '**imar <franchise>** — Include character ranks.',
        '**imao <franchise>** — Include current server owners.',
        '**imaro <franchise>** — Include ranks and owners.',
      ].join('\n') },
      { name: 'AFFECTION & SOULMATE', value: [
        '**affection [@user]** — View affection and normal harem bonuses. Alias: **aff**.',
        '**affection <name or #rank> [@user]** — View one relationship’s saved progress.',
        '**soulmate** — View your current soulmate and active perks. Alias: **sm**.',
        '**soulmate <name or #rank>** — Choose an owned character, then confirm.',
      ].join('\n') },
      { name: 'WISHLIST', value: [
        '**wish <name or #rank>** — Add a character to your wishlist.',
        '**wl** — View your wishlist. Aliases: **wishlist**, **wish** without arguments.',
        '**wish remove <name or #rank>** — Remove a wish.',
        '**wish clear** — Clear your wishlist.',
      ].join('\n') },
      { name: 'TRADING & GIFTS', value: [
        '**me @user** — Start a character trade. Alias: **trade**.',
        '**give @user** — Offer a character as a gift.',
        '**cancel** — Cancel your pending trade or gift.',
      ].join('\n') },
      { name: 'ITEMS', value: [
        '**rewards** — Browse pending item rewards; accept, replace an inventory item, or decline.',
        '**inv [@user]** — View inventory and active effects.',
        '**inv help [@user]** — Explain items in that inventory.',
        '**itemlist** — Browse the server’s item catalog and rarity filters. Alias: **il**.',
        '**use <item> [arguments]** — Use an item from your inventory.',
      ].join('\n') },
      { name: 'RANKINGS', value: [
        '**top [page]** — Browse the highest-ranked characters.',
        '**topo [page]** — Include current server owners.',
        '**topw [page]** — Show female characters only.',
        '**toph [page]** — Show male characters only.',
        '',
        'Combine modifiers: **topow** or **topoh** includes owners with a gender filter.',
        '',
        '**ts [page]** — Show server leaderboard by top ten best character ranks',
        '**tsl [page]** — Show server leaderboard by most characters claimed',
      ].join('\n') },
      { name: 'HELP', value: '**help** — Show this command guide.' },
    )
    .setFooter({ text: 'Omit [@user] to view your own information.' });

  await ctx.message.reply({ embeds: [embed], allowedMentions: { parse: [], repliedUser: false } });
}
