import { createHash } from 'node:crypto';

export const canonicalCatalogValue = value => Array.isArray(value) ? `[${value.map(canonicalCatalogValue).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalCatalogValue(value[key])}`).join(',')}}`
    : JSON.stringify(value);
export const hashCatalogPayload = value => createHash('sha256').update(canonicalCatalogValue(value)).digest('hex');

export function validateCatalogTimestamp(now) {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15) throw new Error('Invalid timestamp');
}

export function catalogMutationTransaction(db, action) {
  // Outside try: a caller-owned transaction must never be rolled back by this service.
  db.exec('BEGIN IMMEDIATE'); // Never roll back a caller-owned transaction.
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== 12) throw new Error('Catalog mutations require version 12');
    if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw new Error('Catalog mutations require foreign_keys ON');
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function catalogMutationState(db) {
  const state = db.prepare('SELECT revision, source_revision, appearance_revision FROM catalog_state WHERE singleton=1').get();
  if (!state || Object.values(state).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid catalog state');
  return state;
}

/** Called only inside the mutation's write transaction; all three services publish identically. */
export function publishCatalogMutationRevision(db, revisions, { sourceChanged = false, appearanceChanged = false }, now) {
  const next = { revision: revisions.revision + 1,
    source_revision: revisions.source_revision + Number(sourceChanged),
    appearance_revision: revisions.appearance_revision + Number(appearanceChanged) };
  if (Object.values(next).some(value => !Number.isSafeInteger(value))) throw new Error('Catalog revision overflow');
  db.prepare('UPDATE catalog_state SET revision=?, source_revision=?, appearance_revision=? WHERE singleton=1')
    .run(next.revision, next.source_revision, next.appearance_revision);
  const meta = db.prepare('INSERT INTO catalog_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  meta.run('catalog_revision', String(next.revision));
  meta.run('published_at', new Date(now).toISOString());
  return next;
}

/** Shared confirmation boundary. Domain handlers retain validation, effects and result shapes.
 * Exact retries resolve before expiry/staleness. Effects, audit and result commit together.
 */
export function confirmCatalogPreview(db, request, operations, apply) {
  const { account, role, previewId, idempotencyKey, payloadHash, now } = request;
  return catalogMutationTransaction(db, () => {
    const retry = db.prepare('SELECT * FROM catalog_confirmation_results WHERE account=? AND idempotency_key=?').get(account, idempotencyKey);
    if (retry) {
      if (retry.payload_hash !== payloadHash) throw new Error('Idempotency key payload hash mismatch');
      const mutation = db.prepare('SELECT preview_id, account, role, operation FROM catalog_mutations WHERE id=?').get(retry.mutation_id);
      if (!mutation || mutation.account !== account || mutation.preview_id !== previewId || mutation.role !== role
        || !operations.includes(mutation.operation)) throw new Error('Idempotency key request mismatch');
      return JSON.parse(retry.result_json);
    }
    const preview = db.prepare('SELECT * FROM catalog_previews WHERE id=?').get(previewId);
    if (!preview || preview.account !== account || preview.role !== role || !operations.includes(preview.operation)) {
      throw new Error('Preview owner/role/operation mismatch or missing preview');
    }
    if (preview.payload_hash !== payloadHash) throw new Error('Preview payload hash mismatch');
    if (db.prepare('SELECT 1 FROM catalog_mutations WHERE preview_id=?').get(previewId)) throw new Error('Preview already confirmed');
    if (now < preview.created_at || now >= preview.expires_at) throw new Error('Preview expired or invalid timestamp');
    const revisions = catalogMutationState(db);
    if (Object.keys(revisions).some(key => revisions[key] !== preview[key])) throw new Error('Stale catalog preview');
    const payload = JSON.parse(preview.payload_json);
    if (hashCatalogPayload(payload) !== payloadHash || payload.operation !== preview.operation) throw new Error('Stored preview mismatch');
    const change = apply({ preview, payload, revisions });
    const audit = db.prepare(`INSERT INTO catalog_mutations
      (preview_id,character_id,account,role,operation,revision,before_json,after_json,duplicate_override_reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(previewId, change.characterId ?? null, account, role, preview.operation,
      change.result.revision, canonicalCatalogValue(change.before), canonicalCatalogValue(change.after),
      change.duplicateOverrideReason ?? null, now);
    const result = { ...change.result, mutationId: Number(audit.lastInsertRowid) };
    db.prepare('INSERT INTO catalog_confirmation_results VALUES (?,?,?,?,?,?)')
      .run(account, idempotencyKey, payloadHash, result.mutationId, canonicalCatalogValue(result), now);
    return result;
  });
}
