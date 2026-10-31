// Portable SQL only: raw administrative connections need no registered JS function.
export const OWNERSHIP_HISTORY_DDL = `CREATE TABLE ownership_history_schema (
  version INTEGER PRIMARY KEY CHECK(version=1)
);
INSERT INTO ownership_history_schema VALUES(1);
CREATE TABLE ownership_operation_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  now_ms INTEGER CHECK(now_ms IS NULL OR (typeof(now_ms)='integer' AND now_ms BETWEEN 0 AND 9007199254740991))
);
INSERT INTO ownership_operation_clock VALUES(1,NULL);
CREATE TABLE character_ownership_losses (
  guild_id TEXT NOT NULL, former_owner_id TEXT NOT NULL,
  character_id TEXT NOT NULL REFERENCES character_identities(id),
  lost_at INTEGER NOT NULL CHECK(typeof(lost_at)='integer' AND lost_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY(guild_id,former_owner_id,character_id)
);
CREATE INDEX character_ownership_losses_picker ON character_ownership_losses(guild_id,former_owner_id,lost_at DESC,character_id);
${['DELETE', 'UPDATE'].map(event => `CREATE TRIGGER marriages_loss_${event.toLowerCase()} AFTER ${event} ON marriages
${event === 'UPDATE' ? 'WHEN OLD.guild_id IS NOT NEW.guild_id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.character_id IS NOT NEW.character_id' : ''}
BEGIN
  INSERT INTO character_ownership_losses(guild_id,former_owner_id,character_id,lost_at)
  VALUES(OLD.guild_id,OLD.owner_id,OLD.character_id,
    COALESCE((SELECT now_ms FROM ownership_operation_clock WHERE singleton=1),CAST(ROUND(unixepoch('subsec')*1000) AS INTEGER)))
  ON CONFLICT(guild_id,former_owner_id,character_id) DO UPDATE SET lost_at=MAX(lost_at,excluded.lost_at);
END;`).join('\n')}
`;
