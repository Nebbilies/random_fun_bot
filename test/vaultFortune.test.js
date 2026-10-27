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
    assert.equal(getInventory(db, 'guild', 'owner').length, 2);
    reconcileVaultRewards(db, { now: deadline + 1 });
    assert.equal(getInventory(db, 'guild', 'owner').length, 2);
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
    assert.equal(getInventory(db, 'guild', 'owner').filter(item => item.item_id === 'fortunes_recast').length, 2);
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
