import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, escapeMarkdown,
  SectionBuilder, TextDisplayBuilder, ThumbnailBuilder,
} from 'discord.js';

export const SERVER_TOP_PAGE_SIZE = 10;
export const serverTopPageCount = (rows) => Math.max(1, Math.ceil(rows.length / SERVER_TOP_PAGE_SIZE));

export function serverLeaderboardComponents(rows, page = 0, disabled = false) {
  const pages = serverTopPageCount(rows);
  const start = page * SERVER_TOP_PAGE_SIZE;
  const heading = new TextDisplayBuilder().setContent('## 🏆SERVER TOP 10');
  const container = new ContainerBuilder().setAccentColor(0xf1c40f);
  if (rows[0]?.avatarUrl) {
    container.addSectionComponents(new SectionBuilder().addTextDisplayComponents(heading)
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(rows[0].avatarUrl)
        .setDescription('Server leaderboard leader avatar')));
  } else {
    container.addTextDisplayComponents(heading);
  }
  const lines = rows.slice(start, start + SERVER_TOP_PAGE_SIZE).map((row, index) =>
    `${start + index + 1}. ${escapeMarkdown(row.username)} - ${row.score}`);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    lines.join('\n') || 'No eligible members. Own at least 10 ranked characters to appear.'));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `Page ${page + 1} of ${pages} • Sum of 10 best ranks • Lower is better`));
  if (pages > 1) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('topserv:prev').setLabel('Previous')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled || page === 0),
      new ButtonBuilder().setCustomId('topserv:next').setLabel('Next')
        .setStyle(ButtonStyle.Secondary).setDisabled(disabled || page >= pages - 1),
    ));
  }
  return [container];
}
