import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { inspectMysteryConsolation } from './mysteryConsolation.js';

export const LEGACY_VAULT_ABANDONMENT_KEY = 'legacy_vault_abandonment_v1';
export const ABANDONABLE_VAULT_ROLL_IDS = Object.freeze([16994, 17061, 17073, 17087, 17137, 17168, 17317, 17358]);
const fields = ['id', 'guild_id', 'channel_id', 'command_message_id', 'message_id', 'character_id',
  'character_name', 'state', 'published_at', 'expires_at', 'mystery_session_id', 'exclusive_user_id',
  'escape_marriage_id', 'escape_owner_id', 'protected_until', 'escape_outcome', 'escape_winner_id',
  'escape_resolved_at', 'rules_json'];
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && isDeepStrictEqual(Object.keys(v).sort(), [...keys].sort());
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 1000;
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fingerprint = e => hash({ contract: 'legacy_vault_abandonment_v1', version: 1,
  rollId: e.rollId, snapshot: Object.fromEntries(fields.map(k => [k, e.snapshot[k]])),
  reason: e.reason, operator: e.operator, operationId: e.operationId, sourceSha256: e.sourceSha256,
  acknowledgedAt: e.acknowledgedAt, acknowledgement: e.acknowledgement, sourceVersion: e.sourceVersion });
const exists = (db, table) => db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);

// Canonical original v10 binding; only the documented numeric -> text zero
// conversion is normalized. No UUIDs or mutable catalog metadata enter the hash.
export function vaultAbandonmentSnapshot(row) {
  return Object.fromEntries(fields.map(key => [key, key === 'character_id' && row[key] === '0' ? 0 : row[key]]));
}
export function assertUnboundLegacyVault(db, row) {
  if (!row || !ABANDONABLE_VAULT_ROLL_IDS.includes(row.id) || row.state !== 'vault'
    || ![0, '0'].includes(row.character_id)
    || !['guild_id', 'channel_id', 'command_message_id'].every(k => /^\d+$/.test(row[k]))
    || !(row.message_id === null || /^\d+$/.test(row.message_id))
    || !text(row.character_name)
    || !fields.slice(10).every(k => row[k] === null)
    || !['published_at', 'expires_at'].every(k => row[k] === null || (Number.isSafeInteger(row[k]) && row[k] >= 0))
    || (row.character_snapshot_json !== undefined && row.character_snapshot_json !== null)) {
    throw new Error('Not an authorized unbound legacy vault row');
  }
  const tokens = [String(row.id), row.command_message_id, row.message_id].filter(v => v !== null);
  if (db.prepare('SELECT 1 FROM mystery_sessions WHERE origin_roll_id=?').get(row.id)) throw new Error('Vault has mystery binding');
  if (exists(db, 'roll_delivery') && db.prepare('SELECT 1 FROM roll_delivery WHERE roll_id=?').get(row.id)) throw new Error('Vault has delivery binding');
  if (exists(db, 'vault_sessions')) for (const s of db.prepare('SELECT * FROM vault_sessions').all()) {
    if ([s.vault_id, s.command_message_id, s.paid_roll_id, s.message_id].some(v => v !== null && tokens.includes(String(v)))) {
      throw new Error('Vault has durable session binding');
    }
  }
  for (const r of db.prepare('SELECT * FROM vault_rewards').all()) {
    let verifiedDirect = false;
    if (exists(db, 'reward_sources')) {
      const source = db.prepare('SELECT source_id FROM reward_sources WHERE reward_id=?').get(r.vault_id);
      if (source) {
        const session = db.prepare(`SELECT id,guild_id AS guildId,winner_id AS winnerId,
          event_channel_id AS eventChannelId,state_json AS stateJson FROM mystery_sessions WHERE id=?`).get(Number(source.source_id));
        if (session) {
          const decision = inspectMysteryConsolation(db, session);
          verifiedDirect = decision?.status === 'activated' && decision.rewardId === r.vault_id;
        }
      }
    }
    if ([r.vault_id, r.source_message_id, r.message_id].some(v => v !== null && tokens.includes(String(v)))
      || (!verifiedDirect && r.guild_id === row.guild_id && r.channel_id === row.channel_id && r.source_message_id === null)) {
      throw new Error('Vault has reward evidence or ambiguous same-channel reward');
    }
  }
}
export function createVaultAbandonmentEntry(db, row, { reason, operator, operationId, sourceSha256, acknowledgedAt }) {
  assertUnboundLegacyVault(db, row);
  const snapshot = vaultAbandonmentSnapshot(row);
  const entry = { rollId: row.id, snapshot, reason, operator, operationId,
    sourceSha256, acknowledgedAt, acknowledgement: 'abandon-without-refund-or-replacement', sourceVersion: 10 };
  return { ...entry, fingerprint: fingerprint(entry) };
}

/** Always re-read and validate ALL evidence. No cache or arbitrary blocker waiver.
 * Hashes detect stale/corrupt bindings, not authenticate a malicious DB editor.
 * Operator provenance is an assertion backed by the external operation report.
 */
export function inspectLegacyVaultAbandonment(db) {
  const raw = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(LEGACY_VAULT_ABANDONMENT_KEY)?.value;
  const ids = new Set(), blockers = [];
  if (raw === undefined) return { ids, blockers };
  try {
    const contract = JSON.parse(raw);
    if (!exact(contract, ['version', 'entries']) || contract.version !== 1 || !Array.isArray(contract.entries)
      || !contract.entries.length || contract.entries.length > ABANDONABLE_VAULT_ROLL_IDS.length) throw Error('Invalid contract');
    for (const e of contract.entries) {
      if (!exact(e, ['rollId', 'snapshot', 'fingerprint', 'reason', 'operator', 'operationId', 'sourceSha256',
        'acknowledgedAt', 'acknowledgement', 'sourceVersion']) || ids.has(e.rollId)
        || !ABANDONABLE_VAULT_ROLL_IDS.includes(e.rollId) || !text(e.reason) || !text(e.operator)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(e.operationId) || !/^[0-9a-f]{64}$/.test(e.sourceSha256)
        || !Number.isSafeInteger(e.acknowledgedAt) || e.acknowledgedAt < 0 || e.sourceVersion !== 10
        || e.acknowledgement !== 'abandon-without-refund-or-replacement') throw Error('Invalid entry/provenance');
      const row = db.prepare('SELECT * FROM character_rolls WHERE id=?').get(e.rollId);
      assertUnboundLegacyVault(db, row);
      const snapshot = vaultAbandonmentSnapshot(row);
      if (!exact(e.snapshot, fields) || !isDeepStrictEqual(e.snapshot, snapshot) || e.fingerprint !== fingerprint(e)) throw Error('Stale/forged binding fingerprint');
      ids.add(e.rollId);
    }
  } catch (error) { ids.clear(); blockers.push(`Invalid legacy vault abandonment evidence: ${error.message}`); }
  return { ids, blockers };
}
