import { randomUUID } from 'node:crypto';
import { DanbooruApi } from './danbooruApi.js';
import { validateFinalCatalogSchema } from './catalogFinalSchema.js';
import { projectCharacterRanking, applyCharacterRanking } from './catalogRanking.js';
import { requireRankingTagEvidence } from './catalogRankingEvidence.js';
import { catalogMutationState, catalogMutationTransaction, canonicalCatalogValue, hashCatalogPayload,
  confirmCatalogPreview, publishCatalogMutationRevision, validateCatalogTimestamp } from './catalogMutationProtocol.js';

/** Collect complete fresh evidence before taking a publication lock. Read-only by itself.
 * @param {any} db
 * @param {{refresh?: boolean, ids?: string[] | null, api?: {verifyRankingTag: Function}, expectedRevision?: number}} [options]
 */
export async function projectRankingMaintenance(db, { refresh = false, ids = null, api = new DanbooruApi(), expectedRevision } = {}) {
  validateFinalCatalogSchema(db);
  const state = catalogMutationState(db);
  if (expectedRevision !== undefined && expectedRevision !== state.revision) throw new Error('Stale catalog revision');
  const rows = db.prepare('SELECT * FROM characters ORDER BY rank').all();
  const selected = ids === null ? new Set(rows.map(row => row.id)) : new Set(ids);
  if (ids !== null && (!Array.isArray(ids) || ids.length !== selected.size || selected.size === 0
    || [...selected].some(id => !rows.some(row => row.id === id)))) throw new Error('Invalid maintenance character IDs');
  const changes = [];
  if (refresh) {
    for (const row of rows.filter(row => selected.has(row.id))) {
      const tag = db.prepare("SELECT tag_name FROM tag_decisions WHERE character_id=? AND status='approve'").get(row.id)?.tag_name ?? null;
      const evidence = tag === null ? null : requireRankingTagEvidence(tag, await api.verifyRankingTag(tag));
      changes.push({ id: row.id, tag, evidence, count: evidence?.post_count ?? null });
    }
  }
  const after = projectCharacterRanking(rows.map(row => {
    const change = changes.find(change => change.id === row.id);
    return change ? { ...row, danbooru_post_count: change.count } : row;
  }));
  if (catalogMutationState(db).revision !== state.revision) throw new Error('Stale catalog revision during external refresh');
  return { operation: 'ranking-maintenance', refresh, state, changes, before: rows, after };
}

export async function previewRankingMaintenance(db, options) {
  const { account, role, now: requestedNow, ...projectionOptions } = options;
  if (role !== 'admin' || typeof account !== 'string' || !account.trim() || account.length > 120) throw new Error('Admin maintenance attribution required');
  if (db.isTransaction) throw new Error('Maintenance preview requires an idle connection');
  if (requestedNow !== undefined) validateCatalogTimestamp(requestedNow);
  const payload = await projectRankingMaintenance(db, projectionOptions);
  const now = requestedNow ?? Date.now();
  validateCatalogTimestamp(now);
  return catalogMutationTransaction(db, () => {
    const state = catalogMutationState(db);
    if (Object.keys(state).some(key => state[key] !== payload.state[key])) throw new Error('Stale maintenance preview');
    const previewId = randomUUID(), payloadHash = hashCatalogPayload(payload);
    db.prepare('INSERT INTO catalog_previews VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(previewId, account, role, payload.operation,
      payloadHash, canonicalCatalogValue(payload), state.revision, state.source_revision, state.appearance_revision, now, now + 600000);
    return { previewId, payloadHash, expiresAt: now + 600000, revision: state.revision, changes: payload.changes, ranks: payload.after.map(row => ({ id: row.id, rank: row.rank, efficiency: row.efficiency })) };
  });
}

export function confirmRankingMaintenance(db, options) {
  if (options.role !== 'admin' || typeof options.account !== 'string' || !options.account.trim()
    || typeof options.idempotencyKey !== 'string' || !options.idempotencyKey.trim() || options.idempotencyKey.length > 200) throw new Error('Invalid maintenance confirmation');
  const now = options.now ?? Date.now(); validateCatalogTimestamp(now);
  return confirmCatalogPreview(db, { ...options, now }, ['ranking-maintenance'], ({ payload, revisions }) => {
    for (const change of payload.changes) db.prepare('UPDATE characters SET danbooru_post_count=? WHERE id=?').run(change.count, change.id);
    const after = applyCharacterRanking(db);
    const next = publishCatalogMutationRevision(db, revisions, {}, now);
    validateFinalCatalogSchema(db, { readOnly: false });
    return { before: { characters: payload.before }, after: { characters: after, evidence: payload.changes },
      result: { revision: next.revision, refreshed: payload.changes.length, identities: after.length } };
  });
}
