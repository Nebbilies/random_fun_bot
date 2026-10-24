import { escapeMarkdown } from 'discord.js';

/** Annotate display rows with live ownership in this server, independent of catalog presence. */
export function markCharacterOwnership(db, guildId, rows) {
  const owned = new Set(guildId == null ? [] : db.prepare(
    'SELECT character_id FROM marriages WHERE guild_id = ?',
  ).all(guildId).map((row) => row.character_id));
  return rows.map((row) => ({ ...row, married: owned.has(row.characterId ?? row.id) }));
}

/** Format a character name for a list, not a picker or an individual card. */
export function characterListName(name, married) {
  return `${escapeMarkdown(name)}${married ? ' 💞' : ''}`;
}
