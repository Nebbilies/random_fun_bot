import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installEmptyFinalCatalog } from '../lib/catalogFinalSchema.js';
import { cleanupRolls, reserveRoll } from '../lib/characterRolls.js';
import { confirmSoulmate, getAffectionTotal } from '../lib/characterAffection.js';
import { reservePaidVaultSession, drawVaultSessionOutcome } from '../lib/vaultSessions.js';
import { revealVaultReward, getItemRewardSource } from '../lib/vaultRewards.js';
import { deliverReservedRoll } from '../lib/rollDelivery.js';
import { inspectCatalogRuntimeRestart } from '../lib/catalogRuntimeRecovery.js';
import { createVaultAbandonmentEntry, inspectLegacyVaultAbandonment,
  LEGACY_VAULT_ABANDONMENT_KEY } from '../lib/legacyVaultAbandonment.js';

const now = Date.parse('2026-11-06T02:00:00Z');
const characterId = '11111111-1111-4111-8111-111111111111';

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  installEmptyFinalCatalog(db);
  db.prepare(`INSERT INTO character_rolls
    (id,guild_id,channel_id,command_message_id,character_id,character_name,state,published_at)
    VALUES(17317,'1','10','117317','0','vault','vault',100)`).run();
  const abandoned = db.prepare('SELECT * FROM character_rolls WHERE id=17317').get();
  const entry = createVaultAbandonmentEntry(db, abandoned, {
    reason: 'Explicit abandonment without compensation', operator: 'synthetic',
    operationId: '12345678-1234-4123-8123-123456789abc', sourceSha256: 'a'.repeat(64),
    acknowledgedAt: 1000,
  });
  const evidence = JSON.stringify({ version: 1, entries: [entry] });
  db.prepare('INSERT INTO catalog_meta(key,value) VALUES(?,?)').run(LEGACY_VAULT_ABANDONMENT_KEY, evidence);
  db.prepare("INSERT INTO affection_legacy_sources VALUES('roll','117317',0)").run();
  const initialRestart = inspectCatalogRuntimeRestart(db);
  assert.equal(initialRestart.ready, true, JSON.stringify(initialRestart.blockers));
  db.prepare("INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')").run(characterId);
  db.prepare(`INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender)
    VALUES(?,1,0,1,'generated','Owned','Female')`).run(characterId);
  db.prepare('INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)')
    .run('1', characterId, '101', new Date(now).toISOString());
  const roll = reserveRoll(db, { guildId: '1', channelId: '10', userId: '101', commandMessageId: '100',
    pool: 'w', now, random: () => 0.99 });
  const message = { id: '500', components: [], edit: async () => {}, react: async () => {} };
  const channel = { id: '10', guildId: '1', messages: { fetch: async () => message },
    send: async payload => { message.components = payload.components; return message; } };
  const result = await deliverReservedRoll(db, { channels: { fetch: async () => channel } },
    { rollId: roll.rollId, channel, now: () => now + 1 });
  assert.equal(result.status, 'published');
  assert.equal(getAffectionTotal(db, '1', '101', characterId), 100);
  const rewards = db.prepare('SELECT * FROM vault_rewards ORDER BY vault_id').all();
  assert.equal(rewards.length, 3);
  assert.ok(rewards.every(row => row.source_message_id === null && row.state === 'delivered'));
  return { db, abandoned, evidence, rewards };
}

test('own-character milestone rewards preserve legacy abandonment and allow subsequent rolls and restart', async t => {
  const { db, abandoned, evidence } = await fixture(t);
  assert.doesNotThrow(() => cleanupRolls(db, now + 2));
  assert.deepEqual(inspectLegacyVaultAbandonment(db), { ids: new Set([17317]), blockers: [] });
  assert.deepEqual(db.prepare('SELECT * FROM character_rolls WHERE id=17317').get(), abandoned);
  assert.equal(db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(LEGACY_VAULT_ABANDONMENT_KEY).value, evidence);
  const restart = inspectCatalogRuntimeRestart(db);
  assert.equal(restart.ready, true, JSON.stringify(restart.blockers));
  assert.equal(reserveRoll(db, { guildId: '1', channelId: '10', userId: '101', commandMessageId: '101',
    pool: 'w', now: now + 3, random: () => 0.99 }).status, 'reserved');
});

test('verified Echo reward in the same channel preserves legacy abandonment and restart readiness', async t => {
  const { db, abandoned, evidence } = await fixture(t);
  db.prepare('UPDATE character_affection SET total=2100 WHERE guild_id=? AND user_id=? AND character_id=?')
    .run('1', '101', characterId);
  confirmSoulmate(db, { guildId: '1', userId: '101', characterId, now: now + 2 });
  const session = reservePaidVaultSession(db, { guildId: '1', userId: '101', channelId: '10', now: now + 3 });
  const parent = revealVaultReward(db, { vaultId: session.vaultId, guildId: '1', userId: '101', channelId: '10',
    sourceMessageId: '600', outcome: drawVaultSessionOutcome(session, () => 0), now: now + 4, random: () => 0 });
  assert.equal(parent.state, 'delivered');
  const echo = db.prepare(`SELECT r.* FROM vault_rewards r JOIN reward_sources s ON s.reward_id=r.vault_id
    WHERE s.source_kind='affection_echo'`).get();
  assert.ok(echo);
  assert.equal(echo.source_message_id, null);
  assert.equal(echo.state, 'delivered');
  assert.equal(getItemRewardSource(db, echo.vault_id).kind, 'affection_echo');
  assert.doesNotThrow(() => cleanupRolls(db, now + 5));
  assert.deepEqual(db.prepare('SELECT * FROM character_rolls WHERE id=17317').get(), abandoned);
  assert.equal(db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(LEGACY_VAULT_ABANDONMENT_KEY).value, evidence);
  const restart = inspectCatalogRuntimeRestart(db);
  assert.equal(restart.ready, true, JSON.stringify(restart.blockers));
});

for (const damage of ['missing-source', 'malformed-source', 'missing-copy']) {
  test(`same-channel milestone reward with ${damage} still blocks cleanup`, async t => {
    const { db, rewards } = await fixture(t);
    const rewardId = rewards[0].vault_id;
    if (damage === 'missing-source') db.prepare('DELETE FROM reward_sources WHERE reward_id=?').run(rewardId);
    if (damage === 'malformed-source') db.prepare("UPDATE reward_sources SET metadata_json='{}' WHERE reward_id=?").run(rewardId);
    if (damage === 'missing-copy') db.prepare('DELETE FROM reward_copies WHERE reward_id=?').run(rewardId);
    assert.throws(() => cleanupRolls(db, now + 2), /Invalid legacy vault abandonment evidence/);
    assert.equal(inspectCatalogRuntimeRestart(db).ready, false);
  });
}

for (const column of ['source_message_id', 'message_id']) {
  test(`verified milestone reward with ${column} legacy token collision still blocks cleanup`, async t => {
    const { db, rewards } = await fixture(t);
    db.prepare(`UPDATE vault_rewards SET ${column}='117317' WHERE vault_id=?`).run(rewards[0].vault_id);
    assert.throws(() => cleanupRolls(db, now + 2), /Invalid legacy vault abandonment evidence/);
    assert.equal(inspectCatalogRuntimeRestart(db).ready, false);
  });
}
