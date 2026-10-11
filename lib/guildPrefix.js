export function getGuildPrefix(db, guildId, defaultPrefix) {
  return db.prepare('SELECT prefix FROM guild_prefixes WHERE guild_id = ?').get(guildId)?.prefix ?? defaultPrefix;
}

export function setGuildPrefix(db, guildId, prefix) {
  if (!/^\d+$/.test(guildId) || !/^[A-Za-z0-9!?.$%&*+_-]{1,5}$/.test(prefix)) {
    throw new Error('Invalid prefix');
  }
  db.prepare(`INSERT INTO guild_prefixes (guild_id, prefix) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET prefix = excluded.prefix`).run(guildId, prefix);
}
