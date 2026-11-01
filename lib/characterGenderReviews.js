import { isCharacterId } from './characterIdentity.js';

export const displayGender = value => ({ female: 'Female', male: 'Male', 'non-binary': 'Non-binary' }[String(value ?? '').trim().toLowerCase()] ?? 'Unknown');
export function reportCharacterGender(db, characterId, reporterId) {
  if (!(isCharacterId(characterId) || Number.isSafeInteger(characterId) && characterId > 0)
    || typeof reporterId !== 'string' || !reporterId) throw new Error('Invalid character gender report');
  // Legacy catalogs cannot publish reviewed overrides; reports are enabled after conversion.
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='character_gender_reports'").get()) return false;
  return db.prepare(`INSERT OR IGNORE INTO character_gender_reports(character_id,reporter_id,reported_at)
    SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM characters WHERE id=?)`)
    .run(characterId, reporterId, Date.now(), characterId).changes === 1;
}
export function genderCase(db, characterId) {
  const row = db.prepare(`SELECT c.id,c.name_full AS name,c.gender,c.image_url AS imageUrl,
    i.creation_method AS creationMethod FROM characters c JOIN character_identities i ON i.id=c.id WHERE c.id=?`).get(characterId);
  if (!row) return null;
  const reports = db.prepare(`SELECT COUNT(*) AS reportCount, MIN(reported_at) AS firstReportedAt,
    COALESCE(MAX(id),0) AS caseId FROM character_gender_reports WHERE character_id=? AND review_id IS NULL`).get(characterId);
  const override = db.prepare('SELECT * FROM character_gender_overrides WHERE character_id=?').get(characterId);
  return { ...row, ...reports, gender: displayGender(row.gender), hasOverride: Boolean(override),
    sourceGender: override ? displayGender(override.source_gender) : null,
    revision: db.prepare('SELECT revision FROM catalog_state WHERE singleton=1').get().revision };
}
export function validateGenderReview(db, input) {
  const current = genderCase(db, input.characterId);
  if (!current || current.caseId !== input.caseId || current.revision !== input.revision
    || (!current.reportCount && input.action !== 'source')) throw new Error('Stale gender review case; reload the queue');
  if (!['correct', 'dismiss', 'source'].includes(input.action)) throw new Error('Invalid gender review action');
  if (input.action === 'correct' && !['Female', 'Male', 'Non-binary', 'Unknown'].includes(input.gender)) throw new Error('Invalid gender');
  if (input.action === 'source' && !current.hasOverride) throw new Error('No gender override to remove');
  return current;
}
export function applyGenderReview(db, input, now, account, role) {
  const current = validateGenderReview(db, input);
  const before = db.prepare('SELECT gender FROM characters WHERE id=?').get(input.characterId).gender;
  let after = before;
  let outcome = 'dismissed';
  if (input.action === 'source') {
    after = db.prepare('SELECT source_gender FROM character_gender_overrides WHERE character_id=?').get(input.characterId).source_gender;
    db.prepare('DELETE FROM character_gender_overrides WHERE character_id=?').run(input.characterId);
    outcome = 'source';
  } else if (input.action === 'correct' && current.gender !== input.gender) {
    after = input.gender === 'Unknown' ? null : input.gender;
    if (current.creationMethod !== 'manual') db.prepare(`INSERT INTO character_gender_overrides(character_id,gender,source_gender)
      VALUES(?,?,?) ON CONFLICT(character_id) DO UPDATE SET gender=excluded.gender`).run(input.characterId, after, before);
    outcome = 'corrected';
  }
  db.prepare('UPDATE characters SET gender=? WHERE id=?').run(after, input.characterId);
  const review = db.prepare(`INSERT INTO character_gender_reviews(character_id,account,role,action,outcome,before_gender,after_gender,resolved_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(input.characterId, account, role, input.action, outcome, before, after, now);
  db.prepare('UPDATE character_gender_reports SET review_id=? WHERE character_id=? AND review_id IS NULL')
    .run(Number(review.lastInsertRowid), input.characterId);
  return { outcome, reviewId: Number(review.lastInsertRowid) };
}
