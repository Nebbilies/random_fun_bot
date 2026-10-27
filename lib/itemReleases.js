import { escapeMarkdown } from 'discord.js';
import { ITEM_TIERS, getResolvedItemDefinitions } from './itemRoster.js';
import { getDiscoveredItemIds } from './itemDiscovery.js';

// Add a dated record for each release; catalog edits alone are not announcements.
export const ITEM_RELEASES = [
  { date: '2026-10-28', itemIds: ['fortunes_lens', 'fortunes_recast'] },
];

function releaseDate(release) {
  const date = release?.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid item release date');
  }
  return date;
}

export function latestItemRelease(releases = ITEM_RELEASES) {
  return releases.reduce((latest, release) => {
    const date = releaseDate(release);
    return !latest || date > latest.date ? release : latest;
  }, null);
}

const counts = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const join = names => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;

export function formatItemRelease(release, definitions, discovered) {
  const date = releaseDate(release);
  if (!Array.isArray(release.itemIds) || !release.itemIds.length ||
      new Set(release.itemIds).size !== release.itemIds.length) throw new Error('Invalid item release IDs');
  const groups = new Map();
  for (const id of release.itemIds) {
    const item = definitions.find(definition => definition.id === id);
    if (!item || !ITEM_TIERS[item.tier]) throw new Error(`Unknown released item: ${id}`);
    if (!groups.has(item.tier)) groups.set(item.tier, []);
    groups.get(item.tier).push(discovered.has(id) ? item.name : '???');
  }
  // Budget each tier separately: even unusually large future catalogs cannot
  // exceed a TextDisplay's limit or crowd out the catalog's current page.
  const budget = Math.floor(2400 / groups.size);
  const clauses = [...groups].map(([tier, names]) => {
    const shown = [];
    for (const name of names) {
      const escaped = `**${escapeMarkdown(name)}**`;
      if (join([...shown, escaped]).length > budget) break;
      shown.push(escaped);
    }
    if (shown.length < names.length) shown.push(`**${names.length - shown.length} more** (see the item list)`);
    return `**${counts[names.length] ?? names.length}** new *${escapeMarkdown(ITEM_TIERS[tier].name)}* ` +
      `${names.length === 1 ? 'item' : 'items'}: ${join(shown)}`;
  });
  return `**Changelog ${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}**: Added ${clauses.join('; ')}.`;
}

export function guildItemChangelog(db, guildId) {
  const release = latestItemRelease();
  return release ? formatItemRelease(release, getResolvedItemDefinitions(db, guildId), getDiscoveredItemIds(db, guildId)) : null;
}
