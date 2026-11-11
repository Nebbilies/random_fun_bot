// Inspect each time: explicit schema upgrades may occur on the same connection.
export function hasRollCharacterSnapshot(db) {
  return db.prepare('PRAGMA table_info(character_rolls)').all()
    .some((column) => column.name === 'character_snapshot_json');
}

export function readRollSnapshot(db, rollId) {
  return db.prepare(`SELECT character_id AS characterId, character_name AS characterName,
    mystery_session_id AS mysterySessionId,
    ${hasRollCharacterSnapshot(db) ? 'character_snapshot_json' : 'NULL'} AS snapshotJson
    FROM character_rolls WHERE id = ?`).get(rollId);
}
