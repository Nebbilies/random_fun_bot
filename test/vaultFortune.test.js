import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { installEmptyFinalCatalog } from '../lib/catalogFinalSchema.js';
import { getResolvedItemDefinition } from '../lib/itemRoster.js';
import { addItemToInventory, getUsableInventory, removeItemFromInventory, getInventory } from '../lib/itemStorage.js';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { reservePaidVaultSession, bindVaultSessionMessage, drawVaultSessionOutcome } from '../lib/vaultSessions.js';
import { revealVaultReward, decideVaultReward, getVaultReward, reconcileVaultRewards } from '../lib/vaultRewards.js';
import { inspectFortuneRuntime, getRecast, presentRecast, chooseRecast, activateLens, getLens, acknowledgeLens, refundUnpresentedLens, armRecast, getArmedRecast } from '../lib/vaultFortune.js';
import { validateConfigValue } from '../lib/gameConfigSchema.js';

function inspectReadOnly(db) {
  const snapshot = () => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
  const before = snapshot();
  const changes = db.prepare('SELECT total_changes() AS count').get().count;
  db.exec('PRAGMA query_only=ON');
  try {
    const inspection = inspectFortuneRuntime(db);
    assert.deepEqual(snapshot(), before, 'inspection must not change persisted state');
    assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
    return inspection;
  } finally { db.exec('PRAGMA query_only=OFF'); }
}

function recastFixture(db, { full = false, gamble = false } = {}) {
  installEmptyFinalCatalog(db);
  const source = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast').item;
  if (gamble) addItemToInventory(db, 'guild', 'owner', 'double_or_nothing');
  if (full) for (let i = 0; i < 4; i++) addItemToInventory(db, 'guild', 'owner', 'hourglass_of_haste');
  armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: source.id, now: 100 });
  const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100 });
  const scope = { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message' };
  revealVaultReward(db, { ...scope, outcome: drawVaultSessionOutcome(session, () => 0), now: 200 });
  if (gamble) decideVaultReward(db, { ...scope, action: 'gamble', now: 250, random: () => 0 });
  return { scope, source };
}

test('Fortune start refuses sources at their exact inventory deadline', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const recast = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast').item;
    addItemToInventory(db, 'guild', 'owner', 'fortunes_lens');
    db.prepare('UPDATE user_inventory SET expires_at=200').run();
    assert.equal(armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: recast.id, now: 200 }).status, 'missing_item');
    const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100 });
    bindVaultSessionMessage(db, session.vaultId, 'message');
    assert.equal(activateLens(db, { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message', now: 200 }).status, 'missing_item');
    assert.equal(getLens(db, session.vaultId), null);
  } finally { db.close(); }
});

test('armed Recast survives expiry and runtime inspection until a later reward is presented', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const source = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast', 2).item;
    db.prepare('UPDATE user_inventory SET expires_at=200 WHERE id=?').run(source.id);
    assert.equal(armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: source.id, now: 199 }).status, 'armed');
    assert.deepEqual(getInventory(db, 'guild', 'owner', 200), []);
    assert.equal(inspectReadOnly(db).blockers.length, 0);
    const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 1000000 });
    const scope = { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message' };
    assert.equal(revealVaultReward(db, { ...scope, outcome: drawVaultSessionOutcome(session, () => 0), now: 1000001 }).state, 'recast');
    assert.equal(presentRecast(db, { ...scope, now: 1000002 }).status, 'presented');
    assert.equal(getArmedRecast(db, 'guild', 'owner'), null);
    assert.equal(getInventory(db, 'guild', 'owner', 199).find(i => i.id === source.id).charges, 1);
    assert.equal(decideVaultReward(db, { ...scope, action: 'recast', choice: -1, now: 1000003 }).reward.state, 'delivered');
    assert.equal(getInventory(db, 'guild', 'owner', 1000003).some(i => i.id === source.id), false);
    assert.equal(inspectReadOnly(db).blockers.length, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

for (const refund of [false, true]) test(`Lens started before expiry completes refund=${refund} without reviving its source`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    const { source, session } = lensFixture(db);
    db.prepare('UPDATE user_inventory SET expires_at=201 WHERE id=?').run(source.id);
    if (refund) assert.equal(refundUnpresentedLens(db, session.vaultId, { absent: true, now: session.deadline }), true);
    else assert.equal(acknowledgeLens(db, session.vaultId, 202), true);
    assert.deepEqual(getInventory(db, 'guild', 'owner', session.deadline), []);
    assert.equal(getLens(db, session.vaultId).state, refund ? 'refunded' : 'presented');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('preflight rejects stranded chosen Recasts and payloads inconsistent with their persisted choice', () => {
  const corruptions = [
    ['chosen reward still recast', 'chosen', db => db.exec("UPDATE vault_rewards SET state='recast'")],
    ['chosen reward still decision', 'chosen', db => db.exec("UPDATE vault_rewards SET state='decision'")],
    ['alternative replaced with original', 'chosen', db => db.exec('UPDATE vault_rewards SET reward_json=(SELECT original_json FROM fortune_recasts)')],
    ['Keep replaced with alternative', 'keep', db => {
      const decision = db.prepare('SELECT alternatives_json FROM fortune_recasts').get();
      const reward = getVaultReward(db, db.prepare('SELECT vault_id FROM fortune_recasts').get().vault_id).reward;
      db.prepare('UPDATE vault_rewards SET reward_json=?').run(JSON.stringify({ ...reward, item: JSON.parse(decision.alternatives_json)[0] }));
    }],
    ['selected terms changed', 'chosen', db => {
      const row = db.prepare('SELECT reward_json FROM vault_rewards').get();
      const reward = JSON.parse(row.reward_json); reward._rules.doubleDecisionMs++;
      db.prepare('UPDATE vault_rewards SET reward_json=?').run(JSON.stringify(reward));
    }],
    ['pending reward payload changed', 'pending', db => db.exec("UPDATE vault_rewards SET reward_json=json_set(reward_json,'$.item.name','corrupt')")],
    ['presented reward payload changed', 'presented', db => db.exec("UPDATE vault_rewards SET reward_json=json_set(reward_json,'$.item.name','corrupt')")],
  ];
  for (const [label, state, corrupt] of corruptions) {
    const db = new DatabaseSync(':memory:');
    try {
      const { scope } = recastFixture(db);
      if (state === 'chosen' || state === 'keep') decideVaultReward(db, { ...scope, action: 'recast', choice: state === 'keep' ? -1 : 0, now: 300 });
      if (state === 'presented') presentRecast(db, { ...scope, now: 300 });
      assert.equal(inspectReadOnly(db).blockers.length, 0, `valid ${label} fixture`);
      corrupt(db);
      assert.ok(inspectReadOnly(db).blockers.some(issue => issue.table === 'fortune_recasts'), label);
    } finally { db.close(); }
  }
});

function lensFixture(db) {
  installEmptyFinalCatalog(db);
  const source = addItemToInventory(db, 'guild', 'owner', 'fortunes_lens').item;
  const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100 });
  bindVaultSessionMessage(db, session.vaultId, 'message');
  activateLens(db, { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message', now: 200, random: () => 0 });
  return { source, session };
}

test('preflight validates held sources in both directions against the effect owner and Lens vault', () => {
  const corruptions = [
    ['armed Recast borrows another owner Lens hold', ({ db, source }) => {
      db.prepare('INSERT INTO fortune_armed VALUES(?,?,?,?)').run('guild', 'intruder', source.id, 200);
    }],
    ['Lens and its source moved to another owner', ({ db, source }) => {
      db.prepare("UPDATE fortune_holds SET user_id='intruder' WHERE inventory_id=?").run(source.id);
      db.prepare("UPDATE user_inventory SET user_id='intruder' WHERE id=?").run(source.id);
    }],
    ['Lens and its source moved to another guild', ({ db, source }) => {
      db.prepare("UPDATE fortune_holds SET guild_id='other' WHERE inventory_id=?").run(source.id);
      db.prepare("UPDATE user_inventory SET guild_id='other' WHERE id=?").run(source.id);
    }],
    ['Lens hold references another vault', ({ db, source }) => {
      db.prepare("UPDATE fortune_holds SET reference_id='other' WHERE inventory_id=?").run(source.id);
    }],
    ['Lens borrows another pending Lens inventory', ({ db, source }) => {
      const second = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100 });
      const lens = getLens(db, db.prepare('SELECT vault_id FROM fortune_lens').get().vault_id);
      db.prepare("INSERT INTO fortune_lens VALUES(?,?,?,'pending',200,NULL)").run(second.vaultId, source.id, JSON.stringify(lens.candidates));
    }],
    ['Lens has no hold', ({ db }) => db.exec('DELETE FROM fortune_holds')],
  ];
  for (const [label, corrupt] of corruptions) {
    const db = new DatabaseSync(':memory:');
    try {
      const fixture = lensFixture(db);
      assert.equal(inspectReadOnly(db).blockers.length, 0);
      corrupt({ db, ...fixture });
      assert.ok(inspectReadOnly(db).blockers.length > 0, label);
    } finally { db.close(); }
  }
});

test('preflight permits terminal Lens and Recast history after exhausted sources are deleted', () => {
  for (const state of ['delivered', 'overflow', 'declined', 'won']) {
    for (const choice of [-1, 0]) {
      const db = new DatabaseSync(':memory:');
      try {
        const { scope, source } = recastFixture(db, { full: ['overflow', 'declined'].includes(state), gamble: state === 'won' });
        assert.equal(inspectReadOnly(db).blockers.length, 0);
        presentRecast(db, { ...scope, now: 275 });
        if (['overflow', 'declined'].includes(state)) addItemToInventory(db, 'guild', 'owner', 'hourglass_of_haste');
        assert.equal(inspectReadOnly(db).blockers.length, 0);
        decideVaultReward(db, { ...scope, action: 'recast', choice, now: 300 });
        if (state === 'declined') decideVaultReward(db, { ...scope, action: 'decline', now: 400 });
        assert.equal(getVaultReward(db, scope.vaultId).state, state === 'won' ? 'delivered' : state);
        assert.equal(db.prepare('SELECT 1 FROM user_inventory WHERE id=?').get(source.id), undefined);
        assert.equal(inspectReadOnly(db).blockers.length, 0, `${state}, choice ${choice}`);
      } finally { db.close(); }
    }
  }
  const db = new DatabaseSync(':memory:');
  try {
    const { source, session } = lensFixture(db);
    acknowledgeLens(db, session.vaultId, 300);
    assert.equal(db.prepare('SELECT 1 FROM user_inventory WHERE id=?').get(source.id), undefined);
    assert.equal(inspectReadOnly(db).blockers.length, 0);
  } finally { db.close(); }
});

test('arming reserves an entry without spending and repeated arming cannot reserve another copy', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const source = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast', 2).item;
    addItemToInventory(db, 'guild', 'owner', 'fortunes_recast');
    assert.equal(armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: source.id, now: 100 }).status, 'armed');
    assert.equal(armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: source.id + 1, now: 101 }).status, 'already_armed');
    assert.equal(getInventory(db, 'guild', 'owner')[0].charges, 2);
    assert.equal(getUsableInventory(db, 'guild', 'owner').length, 1);
    assert.equal(removeItemFromInventory(db, source.id), false);
    assert.equal(getArmedRecast(db, 'guild', 'other'), null);
  } finally { db.close(); }
});

test('Lens commits three draws once, holds the exhausted source, and refunds the same entry only once', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const entry = addItemToInventory(db, 'guild', 'owner', 'fortunes_lens').item;
    const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100, timeoutMs: 1000 });
    bindVaultSessionMessage(db, session.vaultId, 'message');
    const request = { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message', now: 200, random: () => 0 };
    assert.equal(activateLens(db, { ...request, userId: 'intruder' }).status, 'forbidden');
    assert.equal(activateLens(db, request).status, 'revealed');
    assert.equal(getInventory(db, 'guild', 'owner')[0].charges, 0);
    assert.equal(getUsableInventory(db, 'guild', 'owner').length, 0);
    assert.equal(getLens(db, session.vaultId).candidates.length, 3);
    assert.equal(activateLens(db, { ...request, random: () => { throw new Error('redraw'); } }).status, 'existing');
    assert.equal(refundUnpresentedLens(db, session.vaultId, { absent: true, now: 500 }), false);
    assert.equal(refundUnpresentedLens(db, session.vaultId, { absent: true, now: 1100 }), true);
    assert.equal(refundUnpresentedLens(db, session.vaultId, { absent: true, now: 1200 }), false);
    assert.equal(getInventory(db, 'guild', 'owner')[0].id, entry.id);
    assert.equal(getInventory(db, 'guild', 'owner')[0].charges, 1);
  } finally { db.close(); }
});

test('Recast gates delivery, consumes only on private presentation, persists alternatives and times out to Keep once', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const entry = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast', 2).item;
    armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: entry.id, now: 100 });
    const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100 });
    const outcome = drawVaultSessionOutcome(session, () => 0);
    const scope = { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message' };
    const reward = revealVaultReward(db, { ...scope, outcome, now: 200 });
    assert.equal(reward.state, 'recast');
    const decision = getRecast(db, session.vaultId);
    assert.equal(decision.alternatives.length, 2);
    assert.equal(getInventory(db, 'guild', 'owner')[0].charges, 2);
    assert.equal(presentRecast(db, { ...scope, now: 300 }).status, 'presented');
    const deadline = getRecast(db, session.vaultId).deadline;
    assert.equal(getInventory(db, 'guild', 'owner')[0].charges, 1);
    presentRecast(db, { ...scope, now: 400 });
    assert.equal(getRecast(db, session.vaultId).deadline, deadline);
    assert.equal(getArmedRecast(db, 'guild', 'owner'), null);
    reconcileVaultRewards(db, { now: deadline });
    assert.equal(getVaultReward(db, session.vaultId).state, 'delivered');
    assert.equal(getInventory(db, 'guild', 'owner', deadline).length, 2);
    reconcileVaultRewards(db, { now: deadline + 1 });
    assert.equal(getInventory(db, 'guild', 'owner', deadline + 1).length, 2);
  } finally { db.close(); }
});

test('gamble loss preserves arming, upgraded win recasts the upgraded captured tier without another gamble', () => {
  for (const won of [false, true]) {
    const db = new DatabaseSync(':memory:');
    try {
      installEmptyFinalCatalog(db);
      const source = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast').item;
      addItemToInventory(db, 'guild', 'owner', 'double_or_nothing');
      armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: source.id, now: 100 });
      const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100 });
      const scope = { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message' };
      assert.equal(revealVaultReward(db, { ...scope, outcome: drawVaultSessionOutcome(session, () => 0), now: 200 }).state, 'decision');
      const result = decideVaultReward(db, { ...scope, action: 'gamble', now: 300, random: () => won ? 0 : 0.99 });
      if (!won) {
        assert.equal(result.reward.state, 'lost');
        assert.ok(getArmedRecast(db, 'guild', 'owner'));
        assert.equal(getRecast(db, session.vaultId), null);
      } else {
        assert.equal(result.reward.state, 'recast');
        const decision = getRecast(db, session.vaultId);
        assert.equal(decision.original.tier, 'epic');
        assert.ok(decision.alternatives.every(item => item.tier === 'epic'));
        const chosen = decideVaultReward(db, { ...scope, action: 'recast', choice: 0, now: 400 });
        assert.equal(chosen.reward.state, 'delivered');
        assert.equal(chosen.reward.reward.item.id, decision.alternatives[0].id);
        assert.equal(decideVaultReward(db, { ...scope, action: 'gamble', now: 500 }).status, 'stale');
        assert.equal(decideVaultReward(db, { ...scope, action: 'recast', choice: 1, now: 500 }).status, 'stale');
      }
    } finally { db.close(); }
  }
});

test('no alternatives and legacy snapshots keep Recast armed; first eligible resolution wins across sessions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const source = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast').item;
    const first = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 10 });
    const second = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 20 });
    armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: source.id, now: 100 });
    const scope = { guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message' };
    const legacy = drawVaultSessionOutcome(first, () => 0); delete legacy._fortuneVersion;
    assert.equal(revealVaultReward(db, { ...scope, vaultId: 'legacy', outcome: legacy, now: 200 }).state, 'delivered');
    const empty = drawVaultSessionOutcome(first, () => 0); empty._rewardPools.common = [empty.item];
    assert.equal(revealVaultReward(db, { ...scope, vaultId: 'empty', outcome: empty, now: 201 }).state, 'delivered');
    assert.ok(getArmedRecast(db, 'guild', 'owner'));
    assert.equal(revealVaultReward(db, { ...scope, vaultId: second.vaultId, outcome: drawVaultSessionOutcome(second, () => 0), now: 202 }).state, 'recast');
    assert.equal(revealVaultReward(db, { ...scope, vaultId: first.vaultId, outcome: drawVaultSessionOutcome(first, () => 0), now: 203 }).state, 'delivered');
    assert.equal(getRecast(db, first.vaultId), null);
  } finally { db.close(); }
});

test('held sources block replacement, and later arming cannot recast an already determined overflow reward', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const source = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast').item;
    for (let i = 0; i < 4; i++) addItemToInventory(db, 'guild', 'owner', 'hourglass_of_haste');
    const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100 });
    const scope = { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message' };
    assert.equal(revealVaultReward(db, { ...scope, outcome: drawVaultSessionOutcome(session, () => 0), now: 200 }).state, 'overflow');
    armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: source.id, now: 300 });
    assert.equal(decideVaultReward(db, { ...scope, action: 'replace', inventoryId: source.id, now: 400 }).status, 'invalid_inventory');
    const other = getUsableInventory(db, 'guild', 'owner')[0];
    assert.equal(decideVaultReward(db, { ...scope, action: 'replace', inventoryId: other.id, now: 500 }).reward.state, 'delivered');
    assert.ok(getArmedRecast(db, 'guild', 'owner'));
    assert.equal(getRecast(db, session.vaultId), null);
    assert.equal(inspectFortuneRuntime(db).blockers.length, 0);
    db.prepare("UPDATE fortune_holds SET user_id='intruder' WHERE inventory_id=?").run(source.id);
    assert.ok(inspectFortuneRuntime(db).blockers.length > 0);
  } finally { db.close(); }
});

test('single alternative can be Recast itself and overflow remains downstream of a terminal private choice', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const source = addItemToInventory(db, 'guild', 'owner', 'fortunes_recast', 2).item;
    for (let i = 0; i < 4; i++) addItemToInventory(db, 'guild', 'owner', 'hourglass_of_haste');
    armRecast(db, { guildId: 'guild', userId: 'owner', inventoryId: source.id, now: 100 });
    const session = reservePaidVaultSession(db, { guildId: 'guild', userId: 'owner', channelId: 'channel', now: 100 });
    const original = getResolvedItemDefinition(db, 'guild', 'love_letter');
    const outcome = { ...drawVaultSessionOutcome(session, () => 0), tier: 'rare', tierData: { name: 'Rare' }, item: original };
    outcome._rewardPools.rare = [original, getResolvedItemDefinition(db, 'guild', 'fortunes_recast')];
    const scope = { vaultId: session.vaultId, guildId: 'guild', userId: 'owner', channelId: 'channel', messageId: 'message' };
    assert.equal(revealVaultReward(db, { ...scope, outcome, now: 200 }).state, 'recast');
    assert.equal(getRecast(db, session.vaultId).alternatives.length, 1);
    assert.equal(decideVaultReward(db, { ...scope, action: 'recast', choice: 0, now: 300 }).reward.state, 'overflow');
    assert.equal(getArmedRecast(db, 'guild', 'owner'), null);
    const discard = getUsableInventory(db, 'guild', 'owner').find(item => item.item_id !== 'fortunes_recast');
    assert.equal(decideVaultReward(db, { ...scope, action: 'replace', inventoryId: discard.id, now: 400 }).reward.state, 'delivered');
    assert.equal(getInventory(db, 'guild', 'owner', 400).filter(item => item.item_id === 'fortunes_recast').length, 2);
    assert.equal(getArmedRecast(db, 'guild', 'owner'), null);
  } finally { db.close(); }
});

test('Fortune registry settings inherit globally, override per guild, and captured charge terms do not drift', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    const save = (guildId, values) => saveConfigSection(db, { guildId, section: 'items', values, expectedRevision: getConfigView(db, guildId).revision });
    save(null, { 'items.fortunes_lens.startingCharges': 3 });
    assert.equal(getResolvedItemDefinition(db, '123', 'fortunes_lens').maxCharges, 3);
    save('123', { 'items.fortunes_lens.startingCharges': 2, 'items.fortunes_recast.rewardEligible': false });
    assert.equal(getResolvedItemDefinition(db, '123', 'fortunes_lens').maxCharges, 2);
    assert.equal(getResolvedItemDefinition(db, '456', 'fortunes_lens').maxCharges, 3);
    const session = reservePaidVaultSession(db, { guildId: '123', userId: 'owner', channelId: 'channel', now: 100 });
    save('123', { 'items.fortunes_lens.startingCharges': 4 });
    assert.equal(session.captured.rewardPools.rare.find(item => item.id === 'fortunes_lens').maxCharges, 2);
    assert.ok(!session.captured.rewardPools.rare.some(item => item.id === 'fortunes_recast'));
    assert.throws(() => save('123', { 'items.fortunes_lens.startingCharges': 0 }));
  } finally { db.close(); }
});

test('Fortune items are Rare rewards with validated configurable charges', () => {
  const db = new DatabaseSync(':memory:');
  try {
    installEmptyFinalCatalog(db);
    for (const id of ['fortunes_lens', 'fortunes_recast']) {
      const item = getResolvedItemDefinition(db, 'guild', id);
      assert.equal(item?.tier, 'rare');
      assert.equal(item.rewardEligible, true);
      assert.equal(item.maxCharges, 1);
      assert.equal(validateConfigValue(`items.${id}.startingCharges`, 3), 3);
      assert.throws(() => validateConfigValue(`items.${id}.startingCharges`, 0));
    }
  } finally { db.close(); }
});
