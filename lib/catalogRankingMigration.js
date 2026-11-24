import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { validateFinalCatalogSchema as validatePredecessor } from './catalogPreRankingSchema.js';
import { PRE_MAIN_FRANCHISE_CATALOG_DDL, MAIN_FRANCHISE_DDL, CHARACTER_RANKING_DDL, hasCharacterRanking,
  installCharacterRankingPolicy, isMainFranchiseColumnCatalogSchema, isPreMainFranchiseCatalogSchema,
  validateFinalCatalogSchema } from './catalogFinalSchema.js';
import { CHARACTER_RANKING_POLICY_JSON, projectCharacterRanking, validateMudaeCharacterUrl } from './catalogRanking.js';
import { canonicalCatalogValue, hashCatalogPayload, catalogMutationState, publishCatalogMutationRevision,
  validateCatalogTimestamp } from './catalogMutationProtocol.js';

const BOOTSTRAP_KEY = 'character_ranking_bootstrap';
const ITEMS = ['four_leaf_clover', 'pinata', 'rolling_fever'];
const quote = value => `"${value.replaceAll('"', '""')}"`;
const CHANGED_TABLES = new Set(['characters', 'tag_decisions', 'catalog_state', 'catalog_meta', 'catalog_previews',
  'catalog_mutations', 'catalog_confirmation_results', 'game_config_overrides', 'game_config_state', 'active_user_buffs',
  'character_main_franchises']);

function preservationInventory(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .filter(row => !CHANGED_TABLES.has(row.name) && row.name !== 'character_ranking_policy')
    .map(({ name }) => {
      const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all().map(row => canonicalCatalogValue(row)).sort();
      return [name, { count: rows.length, hash: hashCatalogPayload(rows) }];
    }));
}

/** Pure inventory: no expiring buff getters or configuration writes. */
export function inventoryRankingRules(db) {
  const overrides = db.prepare('SELECT * FROM game_config_overrides ORDER BY scope_id,key').all();
  const buffs = db.prepare("SELECT * FROM active_user_buffs WHERE buff_id IN ('four_leaf_clover','pinata','rolling_fever') ORDER BY id").all();
  const changes = buffs.map(buff => {
    let data;
    try { data = buff.data_json === null ? {} : JSON.parse(buff.data_json); } catch { throw new Error(`Malformed ranking buff ${buff.id}`); }
    const allowed = ['rolls', 'minFavourites', 'favouritesThreshold', 'maxRank', 'refundRolls', 'claimTokens', 'startingCharges', 'rewardEligible'];
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(k => !allowed.includes(k))) throw new Error(`Malformed ranking buff ${buff.id}`);
    for (const [key, value] of Object.entries(data)) {
      if (key === 'rewardEligible' ? typeof value !== 'boolean' : !Number.isSafeInteger(value) || value < 0) throw new Error(`Malformed ranking buff ${buff.id}`);
    }
    const next = { ...data, maxRank: 1500 };
    delete next.minFavourites; delete next.favouritesThreshold;
    return { id: buff.id, before: buff.data_json, after: JSON.stringify(next) };
  });
  const affected = overrides.filter(row => ITEMS.some(id => [`itemEffects.${id}.minFavourites`, `itemEffects.${id}.favouritesThreshold`, `itemEffects.${id}.maxRank`].includes(row.key)));
  for (const row of affected) {
    let value;
    try { value = JSON.parse(row.value_json); } catch { throw new Error('Malformed ranking configuration'); }
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Malformed ranking configuration');
  }
  return { overrides: affected, buffs: changes };
}

function migrateRules(db, inventory) {
  const insert = db.prepare('INSERT INTO game_config_overrides VALUES(?,?,?) ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json');
  for (const id of ITEMS) {
    const prefix = `itemEffects.${id}.`;
    const scopes = new Set(['', ...inventory.overrides.filter(row => row.key.startsWith(prefix)).map(row => row.scope_id)]);
    for (const scope of scopes) {
      db.prepare('DELETE FROM game_config_overrides WHERE scope_id=? AND key IN (?,?)').run(scope, `${prefix}minFavourites`, `${prefix}favouritesThreshold`);
      insert.run(scope, `${prefix}maxRank`, '1500');
    }
  }
  const revision = db.prepare('SELECT revision FROM game_config_state WHERE singleton=1').get().revision;
  if (!Number.isSafeInteger(revision + 1)) throw new Error('Config revision overflow');
  db.prepare('UPDATE game_config_state SET revision=? WHERE singleton=1').run(revision + 1);
  for (const buff of inventory.buffs) db.prepare('UPDATE active_user_buffs SET data_json=? WHERE id=?').run(buff.after, buff.id);
}

export function inventoryCharacterRanking(db, inputs) {
  validatePredecessor(db, { readOnly: true });
  if (!inputs || !Array.isArray(inputs.records) || !inputs.hashes || Object.keys(inputs.hashes).sort().join(',') !== 'danbooru,mudae'
    || Object.values(inputs.hashes).some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) throw new Error('Invalid ranking input provenance');
  const current = db.prepare('SELECT * FROM characters ORDER BY rank').all();
  const tags = db.prepare('SELECT * FROM tag_decisions ORDER BY character_id').all();
  const byId = new Map(inputs.records.map(row => [row.id, row]));
  if (byId.size !== inputs.records.length || byId.size !== current.length || current.some(row => !byId.has(row.id))) throw new Error('CSV UUID coverage must exactly match target catalog');
  const projected = projectCharacterRanking(current.map(row => {
    const input = byId.get(row.id);
    if ((input.tag === null) !== (input.danbooru_post_count === null)
      || input.tag !== null && (typeof input.tag !== 'string' || !/^(?!.*[*,A-Z])[\x21-\x7E]{2,120}$/.test(input.tag))) throw new Error('Invalid ranking tag/count input');
    validateMudaeCharacterUrl(input.mudae_character_url);
    return { ...row, ...input, legacy_rank: row.rank };
  }));
  const byTag = new Map(tags.map(row => [row.character_id, row.tag_name]));
  const changes = projected.map(row => ({ id: row.id,
    before: { rank: row.legacy_rank, tag: byTag.get(row.id) ?? null },
    after: { rank: row.rank, legacy_rank: row.legacy_rank, efficiency: row.efficiency, tag: row.tag,
      danbooru_post_count: row.danbooru_post_count, mudae_claim_rank: row.mudae_claim_rank, mudae_character_url: row.mudae_character_url } }));
  return { state: catalogMutationState(db), current, tags, projected, changes, rules: inventoryRankingRules(db) };
}

/** Dedicated offline connection. Rollback-only by default; never called at startup.
 * @param {any} db
 * @param {{inputs: ReturnType<import('./catalogRankingInputs.js').parseRankingInputs>, actor: string,
 * dryRun?: boolean, now?: number, expectedRevision?: number, beforeCommit?: (db: any, result: any) => void}} options
 */
export function migrateCharacterRanking(db, { inputs, actor, dryRun = true, now = Date.now(), expectedRevision,
  beforeCommit = () => {} }) {
  if (db.isTransaction) throw new Error('Ranking migration requires an idle dedicated connection');
  if (typeof actor !== 'string' || !actor.trim() || actor.length > 120 || /[\u0000-\u001f]/.test(actor)) throw new Error('Invalid migration actor');
  validateCatalogTimestamp(now);
  const identity = hashCatalogPayload({ hashes: inputs?.hashes, policy: CHARACTER_RANKING_POLICY_JSON });
  const prior = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(BOOTSTRAP_KEY);
  if (prior) {
    validateFinalCatalogSchema(db, { readOnly: true, mainFranchise: !isPreMainFranchiseCatalogSchema(db),
      mainFranchiseColumn: isMainFranchiseColumnCatalogSchema(db) });
    const saved = JSON.parse(prior.value);
    if (saved.identity !== identity) throw new Error('Different bootstrap inputs: use a later ranking publication');
    return { ...saved.result, committed: false, noOp: true };
  }
  if (hasCharacterRanking(db)) throw new Error('Ranked catalog has no matching bootstrap record');
  const fk = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys=OFF');
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    const inventory = inventoryCharacterRanking(db, inputs);
    const preservedBefore = preservationInventory(db);
    if (expectedRevision !== undefined && expectedRevision !== inventory.state.revision) throw new Error('Stale catalog revision');
    const model = new DatabaseSync(':memory:');
    let characterDDL;
    try { model.exec(PRE_MAIN_FRANCHISE_CATALOG_DDL); characterDDL = String(model.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='characters'").get()?.sql); }
    finally { model.close(); }
    // Follow SQLite's create/copy/drop/rename sequence; do not rename the parent first.
    const dependent = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE type IN ('trigger','view') ORDER BY name").all();
    const indexes = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='characters' AND sql IS NOT NULL ORDER BY name").all();
    for (const row of dependent) db.exec(`DROP ${row.type} ${quote(row.name)}`);
    db.exec(characterDDL.replace(/^CREATE TABLE "characters"/, 'CREATE TABLE "characters_ranking_next"'));
    const names = db.prepare('PRAGMA table_info(characters_ranking_next)').all().map(row => row.name);
    const insertCharacter = db.prepare(`INSERT INTO characters_ranking_next (${names.map(quote).join(',')}) VALUES(${names.map(() => '?').join(',')})`);
    for (const row of inventory.projected) {
      insertCharacter.run(...names.map(name => row[name]));
    }
    db.exec('DROP TABLE characters; ALTER TABLE characters_ranking_next RENAME TO characters');
    for (const row of indexes) db.exec(row.sql);
    for (const row of dependent) db.exec(row.sql);
    db.exec(CHARACTER_RANKING_DDL);
    db.exec(MAIN_FRANCHISE_DDL);
    if (db.prepare('SELECT 1 FROM character_main_franchises LIMIT 1').get()) {
      throw new Error('Ranking cutover must start with no main franchise assignments');
    }
    installCharacterRankingPolicy(db, now);
    const tags = db.prepare(`INSERT INTO tag_decisions VALUES(?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET
      status=excluded.status,tag_name=excluded.tag_name,source=excluded.source,updated_at=excluded.updated_at`);
    for (const row of inputs.records) tags.run(row.id, row.tag === null ? 'no_match' : 'approve', row.tag, 'manual', new Date(now).toISOString());
    migrateRules(db, inventory.rules);
    const payload = { operation: 'ranking-bootstrap', hashes: inputs.hashes, policy: CHARACTER_RANKING_POLICY_JSON };
    const previewId = randomUUID(), payloadHash = hashCatalogPayload(payload);
    const next = publishCatalogMutationRevision(db, inventory.state, {}, now);
    db.prepare('INSERT INTO catalog_previews VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(previewId, actor, 'admin', payload.operation,
      payloadHash, canonicalCatalogValue(payload), inventory.state.revision, inventory.state.source_revision, inventory.state.appearance_revision, now, now + 600000);
    const before = { characters: inventory.current, tags: inventory.tags, rules: inventory.rules };
    const after = { characters: db.prepare('SELECT * FROM characters ORDER BY rank').all(),
      tags: db.prepare('SELECT * FROM tag_decisions ORDER BY character_id').all(), rules: inventoryRankingRules(db), hashes: inputs.hashes };
    const mutationId = Number(db.prepare(`INSERT INTO catalog_mutations(preview_id,account,role,operation,revision,before_json,after_json,created_at)
      VALUES(?,?,'admin',?,?,?,?,?)`).run(previewId, actor, payload.operation, next.revision, JSON.stringify(before), JSON.stringify(after), now).lastInsertRowid);
    const result = { identities: inventory.current.length, revision: next.revision, mutationId, hashes: inputs.hashes,
      changes: inventory.changes, targetedRules: inventory.rules,
      preservation: { before: preservedBefore, after: preservationInventory(db) } };
    if (canonicalCatalogValue(result.preservation.before) !== canonicalCatalogValue(result.preservation.after)) throw new Error('Ranking cutover changed unrelated state');
    db.prepare('INSERT INTO catalog_confirmation_results VALUES(?,?,?,?,?,?)').run(actor, `ranking-bootstrap:${identity}`, payloadHash, mutationId, JSON.stringify(result), now);
    db.prepare('INSERT INTO catalog_meta VALUES(?,?)').run(BOOTSTRAP_KEY, JSON.stringify({ identity, result }));
    validateFinalCatalogSchema(db, { readOnly: false });
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Ranking migration foreign-key failure');
    beforeCommit(db, result);
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT'); begun = false;
    return { ...result, committed: !dryRun, noOp: false };
  } catch (error) { if (begun) db.exec('ROLLBACK'); throw error; }
  finally { db.exec(`PRAGMA foreign_keys=${fk}`); }
}
