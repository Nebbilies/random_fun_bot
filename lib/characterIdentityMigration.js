import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getItemDefinition, ITEM_TIERS } from './itemRoster.js';
import { ITEM_ACTION_CONFIG } from './itemActionConfig.js';
import { validateConfigValue } from './gameConfigSchema.js';
import { ITEM_EFFECT_DEFAULTS } from './itemRuntimeConfig.js';
import { DatabaseSync } from 'node:sqlite';
import { CATALOG_RUNTIME_DDL } from './catalogRuntimeSchema.js';
import { initializeLegacyCatalog } from './catalogDb.js';
import { installCatalogReleaseExtensions } from './catalogReleaseSchema.js';
import { rebuildFinalCatalogSchema, validateFinalCatalogSchema } from './catalogFinalSchema.js';
import { adaptCharacterSnapshot, IDENTITY_JSON_COLUMNS } from './characterIdentitySnapshots.js';
export { IDENTITY_JSON_COLUMNS } from './characterIdentitySnapshots.js';

// Offline foundation only: legacy initializer is used solely on a fresh in-memory
// model. No startup hook, network, or refund logic; catalogDb never imports this module.
export const CHARACTER_REFERENCES = Object.freeze({
  characters: 'id', character_identities: 'id', character_anime: 'character_id',
  marriages: 'character_id', character_rolls: 'character_id', mystery_sessions: 'character_id',
  tag_candidates: 'character_id', tag_match_progress: 'character_id', tag_decisions: 'character_id',
  character_tag_reports: 'character_id', duckduckgo_tag_attempts: 'character_id',
  character_wishes: 'character_id', item_character_reservations: 'character_id',
  counterfeit_crowns: 'character_id', character_protection_locks: 'character_id',
});
export const STAGING_TABLES = Object.freeze([
  'stage_characters', 'stage_anime', 'stage_character_anime', 'stage_anime_relations',
]);
export const RESET_META_KEYS = Object.freeze([
  'import_phase', 'scan_started_at', 'scan_finished_at', 'scan_max_id', 'scan_range_start',
  'scan_page', 'scanned_media', 'scanned_pages', 'scan_scope', 'scan_mode', 'stage_limit',
  'legacy_unfiltered_range_start', 'franchise_character_cursor', 'franchise_import_phase',
  'franchise_import_source_published_at',
]);
// Reviewed non-identity JSON: rules/config and vault item rewards.
// Inventory escrow is validated by its producer-specific snapshot adapter.
export const NON_IDENTITY_JSON_COLUMNS = Object.freeze({
  character_rolls: ['rules_json'],
  vault_rewards: ['original_json', 'reward_json'], game_config_overrides: ['value_json'],
});
const TERMINAL = {
  character_rolls: ['closed', 'failed', 'prank', 'vault'],
  mystery_sessions: ['completed', 'canceled', 'failed'],
  item_actions: ['resolved', 'canceled', 'expired'],
  vault_rewards: ['delivered', 'lost', 'declined'],
};
const q = name => `"${String(name).replaceAll('"', '""')}"`;
const rows = (db, table) => db.prepare(`SELECT * FROM ${q(table)}`).all();
const columns = (db, table) => db.prepare(`PRAGMA table_info(${q(table)})`).all();
const validLegacyId = id => Number.isSafeInteger(id) && id > 0;
const schemaObjects = db => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND substr(name, 1, 7) != 'sqlite_' ORDER BY name`).all();
let legacyDefinition;

/** Final conversion supports only the fully upgraded v10 definitions emitted by
 * the authoritative legacy initializer. No SQL normalization or user-defined DDL
 * variants are accepted: changed CHECKs, indexes and triggers must be reviewed.
 * Never run the initializer on the source: it repairs missing objects. Staging
 * rows and import cursors are still intentionally reset after this schema gate.
 */
export function validateLegacyConversionSchema(db) {
  if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 10) {
    throw new Error('Expected fully upgraded legacy v10 for final schema conversion');
  }
  if (!legacyDefinition) {
    const model = new DatabaseSync(':memory:');
    try {
      initializeLegacyCatalog(model);
      legacyDefinition = schemaObjects(model);
    } finally { model.close(); }
  }
  const actual = schemaObjects(db);
  if (actual.length !== legacyDefinition.length || legacyDefinition.some((row, i) =>
    row.type !== actual[i].type || row.name !== actual[i].name
    || row.tbl_name !== actual[i].tbl_name || row.sql !== actual[i].sql)) {
    throw new Error('Unsupported legacy v10 schema: authoritative fully upgraded definitions required');
  }
}

// Read-only, deliberately narrow provenance gate for the vaultRewards producer.
// These are durable determined rewards, NOT terminal rows. Never acknowledge,
// insert inventory, redraw, or rewrite their JSON during identity conversion.
export function validateRetainedVaultOverflow(row) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const time = value => Number.isSafeInteger(value) && value >= 0;
  const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
  const fail = detail => { throw new Error(`Invalid retained vault_rewards overflow ${row.vault_id}: ${detail}`); };
  if (![row.vault_id, row.guild_id, row.user_id, row.channel_id].every(text)
    || ![row.source_message_id, row.message_id].every(value => value === null || text(value))) fail('unsafe scope/binding');
  if (!time(row.created_at) || !time(row.resolved_at) || row.resolved_at < row.created_at
    || !(row.delivered_at === null || (time(row.delivered_at) && row.delivered_at >= row.resolved_at))
    || !(row.deadline === null || (time(row.deadline) && row.deadline >= row.created_at))) fail('invalid timestamps/deadline');
  const original = JSON.parse(row.original_json), reward = JSON.parse(row.reward_json);
  const itemValid = (item, tier) => {
    const definition = object(item) && getItemDefinition(item.id);
    if (!definition || definition.tier !== tier || item.rewardEligible === false) return false;
    // Validate every serialized producer field, not just the roster definition.
    // Display text and resolved rules may be customized; identity/type/tier may not.
    const allowed = ['id', 'name', 'description', 'tier', 'type', 'maxCharges',
      'startingCharges', 'rewardEligible', 'rules'];
    if (!keys(item, allowed) || !['name', 'description'].every(key => text(item[key]))
      || item.type !== definition.type || item.tier !== tier
      || (Object.hasOwn(item, 'maxCharges') && (!Number.isSafeInteger(item.maxCharges) || item.maxCharges < 1))) return false;
    const charges = item.maxCharges ?? 1;
    if (!Number.isSafeInteger(charges) || charges < 1
      || (item.startingCharges !== undefined && item.startingCharges !== charges)
      || (item.rules === undefined && charges !== (definition.maxCharges ?? 1))
      || (item.rules !== undefined && charges !== (item.rules.startingCharges ?? definition.maxCharges ?? 1))
      || (item.rewardEligible !== undefined && typeof item.rewardEligible !== 'boolean')) return false;
    if (item.rules !== undefined) {
      if (!keys(item.rules, [...Object.keys(ITEM_EFFECT_DEFAULTS[item.id] ?? {}), 'startingCharges', 'rewardEligible'])) return false;
      for (const [key, value] of Object.entries(item.rules)) {
        const section = ['startingCharges', 'rewardEligible'].includes(key) ? 'items' : 'itemEffects';
        try { validateConfigValue(`${section}.${item.id}.${key}`, value); }
        catch { return false; }
      }
      if (item.rules.startingCharges !== undefined && item.rules.startingCharges !== charges) return false;
      if (item.rules.rewardEligible === false
        || (item.rules.rewardEligible !== undefined && item.rewardEligible !== undefined
          && item.rules.rewardEligible !== item.rewardEligible)) return false;
    }
    return true;
  };
  const outcomeValid = (outcome, captured) => keys(outcome, captured
    ? ['tier', 'tierData', 'item', '_rules', '_rewardPools'] : ['tier', 'tierData', 'item'])
    && Object.hasOwn(ITEM_TIERS, outcome.tier) && isDeepStrictEqual(outcome.tierData, ITEM_TIERS[outcome.tier])
    && itemValid(outcome.item, outcome.tier);
  if (!outcomeValid(original, true) || !outcomeValid(reward, true)) fail('unsupported outcome/item/charges');
  if (!keys(original._rules, Object.keys(ITEM_ACTION_CONFIG))
    || !Object.keys(ITEM_ACTION_CONFIG).every(key => Object.hasOwn(original._rules, key))) fail('missing/unknown captured rules');
  for (const [key, value] of Object.entries(original._rules)) {
    if (key.endsWith('Weights')) {
      const tiers = key === 'doubleRewardWeights' ? ['epic', 'legendary'] : ['rare', 'epic', 'legendary'];
      if (!keys(value, tiers) || !tiers.every(tier => Object.hasOwn(value, tier))
        || !Object.values(value).some(n => n > 0)) fail('invalid captured weights');
      for (const tier of tiers) {
        try { validateConfigValue(`itemActions.${key}.${tier}`, value[tier]); }
        catch { fail('invalid captured weights'); }
      }
    } else {
      try { validateConfigValue(`itemActions.${key}`, value); }
      catch { fail('invalid captured rule'); }
    }
  }
  if (original._rules.chaosMinRankMultiplier > original._rules.chaosMaxRankMultiplier) fail('invalid captured rank range');
  if (!keys(original._rewardPools, ['epic', 'legendary'])
    || !['epic', 'legendary'].every(tier => Array.isArray(original._rewardPools[tier])
      && original._rewardPools[tier].every(item => itemValid(item, tier)))) fail('invalid captured reward pools');
  if (row.result === 'kept') {
    if (!isDeepStrictEqual(original, reward) || row.gamble_inventory_id !== null) fail('Keep provenance mismatch');
  } else if (row.result === 'won') {
    if (!['common', 'rare'].includes(original.tier) || row.deadline === null
      || !validLegacyId(row.gamble_inventory_id) || !['epic', 'legendary'].includes(reward.tier)
      || !(original._rules.doubleWinChance > 0) || !(original._rules.doubleRewardWeights[reward.tier] > 0)
      || !outcomeValid(reward, false)
      || !original._rewardPools[reward.tier].some(item => isDeepStrictEqual(item, reward.item))) fail('win provenance mismatch');
  } else fail('undetermined/unknown result');
  if (row.deadline !== null && (!['common', 'rare'].includes(original.tier)
    || row.deadline !== row.created_at + original._rules.doubleDecisionMs)) fail('decision provenance mismatch');
}

/** No mutation. Positive references must resolve to a published or retained identity.
 * Zero is ONLY a non-character sentinel on prank/vault rolls; it is not an identity.
 * Non-character IDs (anime, franchise, marriage, roll, inventory, Discord) stay numeric/text as-is.
 */
export function inventoryCharacterIdentities(db) {
  const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND substr(name, 1, 7) != 'sqlite_'").all();
  const tables = new Map(schema.map(row => [row.name, row.sql]));
  const blockers = [];
  const counts = {};
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version !== 10) blockers.push(`Unsupported legacy user_version ${version}; expected fully upgraded legacy v10. Normalize older schemas using the compatible legacy application on a disposable copy first.`);
  if (!tables.has('characters') || !tables.has('character_identities')) blockers.push('Missing legacy characters/character_identities tables.');
  if (tables.has('character_sources') || tables.has('character_identity_migration')) blockers.push('Identity migration/source tables already exist; refusing repeat migration.');
  const identities = new Map();
  for (const table of ['character_identities', 'characters']) {
    if (!tables.has(table)) continue;
    for (const row of rows(db, table)) {
      if (!validLegacyId(row.id)) blockers.push(`${table}: invalid legacy identity ${row.id}.`);
      else identities.set(row.id, { ...identities.get(row.id), ...row });
    }
  }
  if (tables.has('characters')) for (const row of rows(db, 'characters')) {
    if (!Number.isSafeInteger(row.favourites) || row.favourites < 0
      || !Number.isSafeInteger(row.rank) || row.rank < 1) blockers.push(`Invalid likes/rank for character ${row.id}.`);
  }
  let sentinels = 0;
  for (const [table] of tables) {
    counts[table] = Number(db.prepare(`SELECT count(*) AS n FROM ${q(table)}`).get().n);
    if (STAGING_TABLES.includes(table)) continue;
    for (const col of columns(db, table)) {
      if (col.name.endsWith('_json') && !(IDENTITY_JSON_COLUMNS[table] ?? []).includes(col.name)
        && !(NON_IDENTITY_JSON_COLUMNS[table] ?? []).includes(col.name)) {
        blockers.push(`Unclassified JSON ${table}.${col.name}; add a reviewed shape classification.`);
      }
      if ((col.name === 'character_id' || /character_?id$/i.test(col.name)) && CHARACTER_REFERENCES[table] !== col.name) {
        blockers.push(`Unclassified reference ${table}.${col.name}; add a reviewed reference adapter.`);
      }
    }
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${q(table)})`).all()) {
      if (['characters', 'character_identities'].includes(fk.table) && CHARACTER_REFERENCES[table] !== fk.from) {
        blockers.push(`Unclassified foreign reference ${table}.${fk.from}.`);
      }
    }
    const reference = CHARACTER_REFERENCES[table];
    if (reference) for (const row of rows(db, table)) {
      const id = row[reference];
      if (id === 0 && table === 'character_rolls' && ['prank', 'vault'].includes(row.state)) { sentinels++; continue; }
      if (!validLegacyId(id) || !identities.has(id)) blockers.push(`Unresolved reference ${table}.${reference}=${id}; recover a retained identity or explicitly adjudicate it.`);
    }
    if (TERMINAL[table]) for (const row of rows(db, table)) {
      if (table === 'vault_rewards' && row.state === 'overflow') {
        try { validateRetainedVaultOverflow(row); }
        catch (error) { blockers.push(`vault_rewards ${row.vault_id}: ${error.message}`); }
        continue;
      }
      if (!TERMINAL[table].includes(row.state) || (table === 'item_actions' && row.delivery_pending)) {
        blockers.push(`Live ${table} ${row.id ?? row.vault_id} (${row.state}); settle via domain cancellation/delivery APIs before stopping services. No automatic refunds.`);
      }
    }
    if (['item_character_reservations', 'item_action_costs'].includes(table) && counts[table]) {
      blockers.push(`${table} contains reservations/escrow; use domain settlement, not SQL deletion or generic refunds.`);
    }
    for (const column of IDENTITY_JSON_COLUMNS[table] ?? []) {
      if (!columns(db, table).some(col => col.name === column)) continue;
      for (const row of rows(db, table)) {
        if (row[column] == null) continue;
        try {
          const snapshot = adaptCharacterSnapshot(table, column, row);
          for (const { id, path } of snapshot.references) {
            if (!identities.has(id)) blockers.push(`Unresolved reference ${path}=${id}; recover a retained identity or explicitly adjudicate it.`);
          }
        } catch (error) { blockers.push(error.message); }
      }
    }
  }
  for (const object of db.prepare("SELECT name,sql,tbl_name FROM sqlite_schema WHERE type IN ('trigger','view')").all()) {
    if (Object.keys(CHARACTER_REFERENCES).some(table => object.tbl_name === table
      || new RegExp(`\\b${table}\\b`, 'i').test(object.sql))) {
      blockers.push(`Views/triggers (${object.name}) touching character tables require an explicit schema adapter.`);
    }
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) blockers.push('Legacy foreign_key_check failed.');
  return { version, counts, identities: [...identities.keys()].sort((a, b) => a - b), sentinels,
    blockers: [...new Set(blockers)], tables: [...tables.keys()] };
}

/** Generate once for the union of published and retained identities, never by rank. */
export function createIdentityMapping(legacyIds, uuid = randomUUID) {
  const mapping = new Map();
  const used = new Set();
  for (const id of legacyIds) {
    const generated = uuid();
    const value = typeof generated === 'string' ? generated.toLowerCase() : generated;
    if (!validLegacyId(id) || mapping.has(id) || typeof value !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) || used.has(value)) {
      throw new Error('Invalid/duplicate legacy ID or UUID mapping.');
    }
    mapping.set(id, value); used.add(value);
  }
  return mapping;
}

/** Rebuild from existing DDL, preserving constraints, indexes and unrelated columns.
 * Only explicitly inventoried reference column types change. Foreign keys are off
 * on this dedicated offline connection until verification and rollback/commit.
 */
function rebuild(db, table, reference, mapping) {
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
  const indexes = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table);
  const temp = `__uuid_${table}`;
  let ddl = sql.replace(/^(CREATE TABLE\s+(?:IF NOT EXISTS\s+)?)(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i, `$1${q(temp)}`);
  const type = new RegExp(`(\\b${reference}\\s+)INTEGER\\b`, 'i');
  if (!type.test(ddl)) throw new Error(`Unsupported DDL for ${table}.${reference}.`);
  const keyColumn = columns(db, table).find(col => col.name === reference);
  // INTEGER PRIMARY KEY implies a usable non-NULL rowid; TEXT PRIMARY KEY does
  // not. Preserve that invariant explicitly when converting single-column keys.
  ddl = ddl.replace(type, keyColumn.pk && !keyColumn.notnull ? '$1TEXT NOT NULL' : '$1TEXT');
  db.exec(ddl);
  const names = columns(db, table).map(col => col.name);
  const insert = db.prepare(`INSERT INTO ${q(temp)} (${names.map(q).join(',')}) VALUES (${names.map(() => '?').join(',')})`);
  for (const row of rows(db, table)) {
    for (const column of IDENTITY_JSON_COLUMNS[table] ?? []) {
      if (names.includes(column)) row[column] = adaptCharacterSnapshot(table, column, row, mapping).json;
    }
    const id = row[reference];
    row[reference] = id === 0 ? '0' : mapping.get(id);
    if (row[reference] === undefined) throw new Error(`Unmapped ${table}.${reference}=${id}`);
    insert.run(...names.map(name => row[name]));
  }
  db.exec(`DROP TABLE ${q(table)}; ALTER TABLE ${q(temp)} RENAME TO ${q(table)};`);
  for (const index of indexes) db.exec(index.sql);
}

/** Dedicated offline connection only. Default is rollback-only rehearsal.
 * Committing requires a coordinated targetVersion >10; legacy consumers cannot
 * read the output. No production orchestration or settlement.
 * No cancellation callback is accepted: domain settlement must finish beforehand.
 */
export function migrateCharacterIdentities(db, { dryRun = true, targetVersion, uuid = randomUUID, finalSchema = false,
  requireDrain = false, validateFinalBeforeCommit } = {}) {
  if ((requireDrain || validateFinalBeforeCommit) && !(finalSchema && targetVersion === 12)) {
    throw new Error('Final conversion validation options require authoritative v12 conversion');
  }
  if (validateFinalBeforeCommit !== undefined && typeof validateFinalBeforeCommit !== 'function') {
    throw new Error('validateFinalBeforeCommit must be a synchronous validation function');
  }
  if (!dryRun && (!Number.isInteger(targetVersion) || targetVersion <= 10 || targetVersion > 2147483647)) {
    throw new Error('Commit requires a coordinated targetVersion >10; legacy consumers are incompatible.');
  }
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys);
  db.exec('PRAGMA foreign_keys=OFF');
  if (Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys)) throw new Error('Use an idle dedicated connection, outside a transaction.');
  let begun = false;
  try {
    db.exec('BEGIN IMMEDIATE'); begun = true;
    if (finalSchema || targetVersion === 12) validateLegacyConversionSchema(db);
    if (requireDrain && db.prepare("SELECT value FROM catalog_meta WHERE key='game_maintenance'").get()?.value !== 'drain') {
      throw new Error('Persisted game_maintenance=drain required inside conversion transaction');
    }
    const inventory = inventoryCharacterIdentities(db);
    if (inventory.blockers.length) throw new Error(`Migration preflight refused:\n${inventory.blockers.join('\n')}`);
    const mapping = createIdentityMapping(inventory.identities, uuid);
    // Save before rebuilding: rank captures the legacy tied order, not UUID sorting.
    const published = rows(db, 'characters');
    const sequences = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()
      ? rows(db, 'sqlite_sequence') : [];
    for (const [table, reference] of Object.entries(CHARACTER_REFERENCES)) {
      if (inventory.tables.includes(table)) rebuild(db, table, reference, mapping);
    }
    // Snapshot-only tables are not rebuilt, but must use the same mapping.
    for (const [table, jsonColumns] of Object.entries(IDENTITY_JSON_COLUMNS)) {
      if (!inventory.tables.includes(table) || CHARACTER_REFERENCES[table]) continue;
      const names = columns(db, table).map(col => col.name);
      for (const row of db.prepare(`SELECT rowid AS __migration_rowid, * FROM ${q(table)}`).all()) {
        for (const column of jsonColumns.filter(name => names.includes(name))) {
          const { json } = adaptCharacterSnapshot(table, column, row, mapping);
          if (json !== row[column]) db.prepare(`UPDATE ${q(table)} SET ${q(column)}=? WHERE rowid=?`).run(json, row.__migration_rowid);
        }
      }
    }
    // Rebuild must not lower historical AUTOINCREMENT high-water marks.
    for (const row of sequences) {
      const existing = db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(row.name);
      if (existing) db.prepare('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?').run(row.seq, row.name);
      else db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(row.name, row.seq);
    }
    const addIdentity = db.prepare('INSERT OR IGNORE INTO character_identities(id,name_full,image_url) VALUES(?,?,?)');
    for (const row of published) addIdentity.run(mapping.get(row.id), row.name_full ?? null, row.image_url ?? null);
    db.exec(`CREATE TABLE character_sources (
      source TEXT NOT NULL, external_id TEXT NOT NULL, character_id TEXT NOT NULL REFERENCES character_identities(id),
      PRIMARY KEY(source,external_id), UNIQUE(source,character_id));
      ALTER TABLE character_identities ADD COLUMN creation_method TEXT NOT NULL DEFAULT 'imported';
      ALTER TABLE characters ADD COLUMN likes_source TEXT NOT NULL DEFAULT 'anilist';
      ALTER TABLE characters ADD COLUMN tie_order INTEGER;
      CREATE UNIQUE INDEX character_tie_order ON characters(tie_order);
      CREATE TABLE character_identity_migration (legacy_id INTEGER PRIMARY KEY, character_id TEXT NOT NULL UNIQUE REFERENCES character_identities(id));`);
    for (const [legacy, id] of mapping) {
      db.prepare('INSERT INTO character_sources VALUES(?,?,?)').run('anilist', String(legacy), id);
      db.prepare('INSERT INTO character_identity_migration VALUES(?,?)').run(legacy, id);
    }
    for (const row of published) db.prepare('UPDATE characters SET tie_order=? WHERE id=?').run(row.rank, mapping.get(row.id));
    for (const table of STAGING_TABLES) if (inventory.tables.includes(table)) db.exec(`DELETE FROM ${q(table)}`);
    if (inventory.tables.includes('catalog_meta')) {
      for (const key of RESET_META_KEYS) db.prepare('DELETE FROM catalog_meta WHERE key=?').run(key);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Post-migration foreign_key_check failed.');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Post-migration integrity_check failed.');
    for (const [table, reference] of Object.entries(CHARACTER_REFERENCES)) {
      if (!inventory.tables.includes(table)) continue;
      const actual = Number(db.prepare(`SELECT count(*) AS n FROM ${q(table)}`).get().n);
      const expected = table === 'character_identities' ? mapping.size : inventory.counts[table];
      if (actual !== expected) throw new Error(`Row loss in ${table}.`);
      for (const row of rows(db, table)) {
        if (table === 'character_rolls' && row[reference] === '0' && ['vault', 'prank'].includes(row.state)) continue;
        if (!db.prepare('SELECT 1 FROM character_identities WHERE id=?').get(row[reference])) throw new Error(`Broken reference in ${table}.`);
      }
    }
    if (finalSchema || targetVersion === 12) {
      db.exec('PRAGMA user_version=11');
      installCatalogReleaseExtensions(db);
      db.exec(CATALOG_RUNTIME_DDL);
      rebuildFinalCatalogSchema(db);
      validateFinalCatalogSchema(db);
    } else if (!dryRun) db.exec(`PRAGMA user_version=${targetVersion}`);
    if (validateFinalBeforeCommit) {
      const result = validateFinalBeforeCommit(db, { countsBefore: inventory.counts, sequencesBefore: sequences });
      if (result && typeof result.then === 'function') throw new Error('Final precommit validation must be synchronous');
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT'); begun = false;
    return { dryRun, committed: !dryRun, identities: mapping.size, published: published.length,
      retainedOnly: mapping.size - published.length, sentinels: inventory.sentinels,
      counts: inventory.counts, stagingReset: STAGING_TABLES.filter(t => inventory.tables.includes(t)),
      limitations: ['Unknown historical snapshot shapes require reviewed adapters.', 'Live actions require domain settlement.',
        'Complete consumer acceptance and authorized backup/recovery rehearsal remain required; no production rollout.'] };
  } catch (error) {
    if (begun) db.exec('ROLLBACK');
    throw error;
  } finally { db.exec(`PRAGMA foreign_keys=${foreignKeys}`); }
}

/** Explicit offline v10 -> authoritative v12 conversion on a dedicated connection.
 * Rollback-only by default. Never called by startup. No network or settlement. */
export function convertLegacyCatalogToFinal(db, { dryRun = true, uuid = randomUUID,
  requireDrain = false, validateFinalBeforeCommit } = {}) {
  return migrateCharacterIdentities(db, { dryRun, uuid, targetVersion: 12, finalSchema: true,
    requireDrain, validateFinalBeforeCommit });
}
