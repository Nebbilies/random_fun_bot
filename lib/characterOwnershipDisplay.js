import { escapeMarkdown } from 'discord.js';

/** Annotate display rows with live ownership in this server, independent of catalog presence. */
export function markCharacterOwnership(db, guildId, rows) {
  const owners = new Map(guildId == null ? [] : db.prepare(
    'SELECT character_id, owner_id FROM marriages WHERE guild_id = ?',
  ).all(guildId).map((row) => [row.character_id, row.owner_id]));
  return rows.map((row) => {
    const ownerId = owners.get(row.characterId ?? row.id) ?? null;
    return { ...row, married: ownerId !== null, ownerId };
  });
}

/** Format a character name for a list, not a picker or an individual card. */
export function characterListName(name, married) {
  return `${escapeMarkdown(name)}${married ? ' 💞' : ''}`;
}
