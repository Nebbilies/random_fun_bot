import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import {
  addActiveBuff, addItemToInventory, getActiveBuffs, getGuildBuffs, getInventory, isCharacterLocked,
} from '../lib/itemStorage.js';
import { getItemDefinition } from '../lib/itemRoster.js';
import { executeItemUse, run as useCommand } from '../commands/use.js';
import { setGuildRates } from '../lib/guildRates.js';
import {
  claimRoll, failRoll, getClaimStatus, getRoll, getRollStatus, publishMysteryIntro, publishRoll,
  reserveRoll,
} from '../lib/characterRolls.js';
import { getMarriage, marryCharacter } from '../lib/characterMarriage.js';
import { beginMysteryEvent, reserveMysteryAwareRoll } from '../lib/mysteryCoordinator.js';
import { runRoll } from '../lib/characterRollRuntime.js';

const start = Date.parse('2026-10-18T01:00:00Z');
const HOUR = 3_600_000;
const CLAIM_PERIOD = 3 * HOUR;
const VIETNAM_OFFSET = 7 * HOUR;

const DEFAULT_CHARACTERS = `INSERT INTO characters (id, rank, favourites, name_full, gender, anime_titles, image_url) VALUES
  (1, 1, 5000, 'Alpha', 'Female', '["Show A"]', 'https://example.com/a.png'),
  (2, 2, 4900, 'Beta', 'Female', '["Show A"]', 'https://example.com/b.png'),
  (3, 3000, 10, 'Gamma', 'Female', '["Show B"]', NULL),
  (4, 3, 4800, 'Delta', 'Male', '["Show B"]', NULL)`;

function fixture(t, characters = DEFAULT_CHARACTERS) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  db.exec(characters);
  // Keep pranks and vaults out of the way so rolls are deterministic.
  setGuildRates(db, '1', { vaultRate: 0, prankRate: 0 });
  addActiveBuff(db, '1', '', 'noop', null, null, 1);
  return db;
}

function seq(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function grant(db, itemId, user = '101', guild = '1') {
  const def = getItemDefinition(itemId);
  assert.ok(def, `missing item definition ${itemId}`);
  const result = addItemToInventory(db, guild, user, itemId, def.maxCharges ?? 1);
  assert.equal(result.status, 'added');
  return result.item;
}

function use(db, query, args = [], options = {}, user = '101', guild = '1') {
  return executeItemUse(db, guild, user, query, args, options);
}

function clock(now = start) {
  return { now: () => now, setTimer: () => ({ unref() {} }), clearTimer: () => {} };
}

function reserve(db, { id = '900', user = '101', pool = 'w', random = () => 0, now = start,
  guild = '1' } = {}) {
  return reserveRoll(db, { guildId: guild, channelId: '10', commandMessageId: id, userId: user,
    pool, now, random });
}

function startMystery(db, { id = '900', user = '101', random = seq([0, 0.5, 0.5, 0.9]) } = {}) {
  const reserved = reserveMysteryAwareRoll(db, { guildId: '1', channelId: '10',
    commandMessageId: id, userId: user, pool: 'w', mysteryEnabled: true, now: start, random });
  assert.equal(reserved.status, 'mystery');
  assert.equal(publishMysteryIntro(db, reserved.sessionId, `9${id}`, start), true);
  return beginMysteryEvent(db, reserved.sessionId, start + 5_001, () => 0.9);
}

function chatFixture(db, authorId = '202') {
  const sent = [];
  const channel = { id: '10', send: async (payload) => {
    sent.push(payload);
    return { id: '500', channel, edit: async () => ({ id: '500' }), react: async () => ({}) };
  } };
  const card = { id: '500', channel, edit: async () => card, react: async () => ({}) };
  const message = { id: '800', guildId: '1', channelId: '10', author: { id: authorId }, channel,
    reply: async (payload) => { sent.push(payload); return card; } };
  const yoshiko = { catalogDb: db, mysteryEnabled: false,
    imagePicker: { pick: async () => ({ url: 'https://example.com/a.png' }) } };
  return { sent, channel, card, message, yoshiko };
}

test('Binoculars reveals the correct door of the next mystery minigame and is spent', (t) => {
  const plain = fixture(t);
  const control = startMystery(plain, { id: '901' });
  assert.equal(control.status, 'started');
  assert.equal(control.reveal, null, 'no Binoculars means no reveal');
  const door = Number(JSON.parse(control.session.stateJson).winningDoor);
  assert.ok([1, 2].includes(door));

  const db = fixture(t);
  grant(db, 'binoculars');
  const started = startMystery(db);
  assert.equal(started.status, 'started');
  assert.equal(JSON.parse(started.session.stateJson).winningDoor, door);
  assert.equal(started.reveal, door === 1 ? 'Left' : 'Right',
    'Binoculars must reveal the winning door');
  assert.equal(getInventory(db, '1', '101').filter((row) => row.item_id === 'binoculars').length, 0,
    'the Binoculars charge must be spent on the minigame it revealed');
});

test('Adrenaline Rush doubles the hourly roll allowance for the next hour', (t) => {
  const db = fixture(t);
  grant(db, 'adrenaline_rush');
  assert.equal(use(db, 'adrenaline', [], { now: start }).success, true);

  for (let i = 0; i < 7; i++) {
    const roll = reserve(db, { id: `${i + 10}`, random: () => i / 10 });
    assert.equal(roll.status, 'reserved');
    failRoll(db, roll.rollId);
  }
  assert.equal(getRollStatus(db, '1', '101', start).remaining, 7,
    'Adrenaline Rush must double the 7-roll hourly allowance to 14');
  assert.equal(reserve(db, { id: '20' }).status, 'reserved');

  const later = start + HOUR + 1;
  assert.equal(getRollStatus(db, '1', '101', later).remaining, 7,
    'the doubled allowance expires with its hour');
  assert.equal(reserve(db, { id: '21', now: later }).status, 'reserved');
});

test('Engagement Ring halves the next claim cooldown and is consumed', (t) => {
  // Sit at the start of a claim bucket so a 1.5h wait stays inside it.
  const claimAt = Date.parse('2026-10-18T02:00:00Z');
  const halved = claimAt + CLAIM_PERIOD / 2 + 1;

  const db = fixture(t);
  grant(db, 'engagement_ring');
  assert.equal(use(db, 'ring', [], { now: start }).success, true);
  const first = reserve(db, { id: '31', now: claimAt });
  const second = reserve(db, { id: '32', now: claimAt, random: () => 0.99 });
  assert.equal(publishRoll(db, first.rollId, '5001', claimAt), true);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '5001', userId: '101',
    now: claimAt }).status, 'married');
  assert.equal(publishRoll(db, second.rollId, '5002', halved), true);
  assert.equal(getClaimStatus(db, '1', '101', halved).canClaim, true,
    'the ring must halve the 3h cooldown to 1.5h');
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '5002', userId: '101',
    now: halved }).status, 'married');
  assert.equal(getActiveBuffs(db, '1', '101').some((buff) => buff.buff_id === 'engagement_ring'), false,
    'the ring is consumed by the claim it shortened');

  const control = fixture(t);
  const controlFirst = reserve(control, { id: '33', now: claimAt });
  const controlSecond = reserve(control, { id: '34', now: claimAt, random: () => 0.99 });
  publishRoll(control, controlFirst.rollId, '5003', claimAt);
  claimRoll(control, { guildId: '1', channelId: '10', messageId: '5003', userId: '101', now: claimAt });
  publishRoll(control, controlSecond.rollId, '5004', halved);
  assert.equal(getClaimStatus(control, '1', '101', halved).canClaim, false,
    'without the ring the same window is still on cooldown');
  assert.equal(claimRoll(control, { guildId: '1', channelId: '10', messageId: '5004', userId: '101',
    now: halved }).status, 'exhausted');
});

test('Golden Whistle seals an escape attempt and keeps the marriage', async (t) => {
  const db = fixture(t);
  const original = marryCharacter(db, '1', 1, '101');
  assert.equal(original.status, 'married');
  const whistle = grant(db, 'golden_whistle');
  const x = chatFixture(db);

  await runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w', () => 0, clock());

  const roll = getRoll(db, '1', '10', '500');
  assert.ok(roll, 'an escape card must be registered for the roll message');
  assert.equal(roll.escapeOutcome, 'reclaimed', 'the whistle must reclaim the character immediately');
  assert.equal(getMarriage(db, '1', 1).ownerId, '101');
  assert.equal(getInventory(db, '1', '101').find((row) => row.item_id === 'golden_whistle')?.charges,
    whistle.charges - 1);
  assert.ok(x.sent.some((payload) => JSON.stringify(payload).includes('Golden Whistle')),
    'the whistle must announce itself');

  // Without the whistle the same roll stays an open escape attempt.
  const control = fixture(t);
  marryCharacter(control, '1', 1, '101');
  const y = chatFixture(control);
  await runRoll({ message: y.message, yoshiko: y.yoshiko }, 'w', () => 0, clock());
  const escaped = getRoll(control, '1', '10', '500');
  assert.equal(escaped.escapeOutcome, null);
  assert.equal(escaped.state, 'open');
});

test("Siren's Call forces a real escape attempt from the target's harem", async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 2, '303');
  grant(db, 'sirens_call');
  const x = chatFixture(db, '101');

  await useCommand({ message: x.message, args: ['use', 'siren', '<@303>'], yoshiko: x.yoshiko });

  const row = db.prepare('SELECT * FROM character_rolls ORDER BY id DESC LIMIT 1').get();
  assert.ok(row, "Siren's Call must open an escape attempt");
  assert.equal(row.character_id, 2);
  assert.equal(row.escape_owner_id, '303');
  assert.equal(row.state, 'open');
  assert.equal(getInventory(db, '1', '101').find((item) => item.item_id === 'sirens_call'), undefined,
    'the charge must be spent');
});

test('Golden Hour resets every hourly allowance in the guild and grants a vault', async (t) => {
  const db = fixture(t);
  const period = Math.floor(start / HOUR);
  for (const user of ['101', '202', '303']) {
    db.prepare('INSERT INTO roll_allowances (guild_id, user_id, period, used) VALUES (?, ?, ?, 7)')
      .run('1', user, period);
  }
  grant(db, 'golden_hour');
  const x = chatFixture(db, '101');

  await useCommand({ message: x.message, args: ['use', 'goldenhour'], yoshiko: x.yoshiko,
    options: { now: start } });

  for (const user of ['101', '202', '303']) {
    assert.equal(getRollStatus(db, '1', user, start).remaining, 7, `Golden Hour must refill ${user}`);
  }
  assert.ok(x.sent.some((payload) => JSON.stringify(payload).toLowerCase().includes('vault')),
    'Golden Hour must open a vault for the host');
});

test('Blood Pact trades three owned characters for a better-ranked one of the franchise', (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO franchises (id, display_name, created_at) VALUES (1, 'Show A', '2026');
    INSERT INTO anime (id, title_english, title_romaji, fetched_at) VALUES (1, 'Show A', 'Show A', '2026');
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (1, 1);
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 1), (2, 1), (3, 1), (4, 1);
    UPDATE characters SET rank = 700 WHERE id = 1;
    UPDATE characters SET rank = 800 WHERE id = 2;
    UPDATE characters SET rank = 900 WHERE id = 3;
    UPDATE characters SET rank = 10 WHERE id = 4;`);
  for (const id of [1, 2, 3]) marryCharacter(db, '1', id, '101');
  grant(db, 'blood_pact');

  const result = use(db, 'blood', ['Alpha', 'Beta', 'Gamma']);
  assert.equal(result.success, true);
  for (const id of [1, 2, 3]) assert.equal(getMarriage(db, '1', id), null, `character ${id} is sacrificed`);
  const summoned = getMarriage(db, '1', 4);
  assert.ok(summoned, 'the pact must summon the better-ranked franchise character');
  assert.equal(summoned.ownerId, '101');
});

test('Four-Leaf Clover keeps its charges while a Franchise Passport is the active filter', (t) => {
  const db = fixture(t);
  db.exec(`INSERT INTO franchises (id, display_name, created_at) VALUES (1, 'Show A', '2026');
    INSERT INTO anime (id, title_english, title_romaji, fetched_at) VALUES (1, 'Show A', 'Show A', '2026');
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (1, 1);
    INSERT INTO character_anime (character_id, anime_id) VALUES (1, 1), (2, 1);`);
  addActiveBuff(db, '1', '101', 'four_leaf_clover', null, null, 5);
  addActiveBuff(db, '1', '101', 'franchise_passport', JSON.stringify({ franchiseId: 1 }), null, 5);

  assert.equal(reserve(db, { random: () => 0 }).status, 'reserved');

  const buffs = getActiveBuffs(db, '1', '101');
  assert.equal(buffs.find((buff) => buff.buff_id === 'four_leaf_clover')?.remaining_rolls, 5,
    'a shadowed Clover must not be consumed');
  assert.equal(buffs.find((buff) => buff.buff_id === 'franchise_passport')?.remaining_rolls, 4);
});

test('Aegis of Fidelity soulbind keeps a character out of escape attempts', (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 1, '101');
  marryCharacter(db, '1', 2, '101');
  grant(db, 'aegis_of_fidelity');
  assert.equal(use(db, 'aegis', ['Alpha'], { now: start }).success, true);
  assert.deepEqual(isCharacterLocked(db, '1', 1, start),
    { locked: true, lockType: 'soulbind', permanent: true });

  const roll = reserve(db, { random: () => 0, user: '202' });
  assert.equal(roll.status, 'reserved');
  assert.notEqual(roll.character.id, 1, 'a soulbound character must never attempt an escape');
  assert.equal(roll.character.id, 2, 'the next owned character still escapes');
  assert.equal(roll.escapeOwnerId, '101');
});

test('Piñata boosts high-favorite rates guild-wide and grants a claim token', (t) => {
  const db = fixture(t, `INSERT INTO characters (id, rank, favourites, name_full, gender, anime_titles) VALUES
    (1, 3000, 10, 'Gamma', 'Female', '["Show B"]'),
    (2, 1, 5000, 'Alpha', 'Female', '["Show A"]')`);
  assert.equal(reserve(db, { user: '202', random: () => 0 }).character.id, 1,
    'without the Piñata the pool starts with the low-favorite character');

  grant(db, 'pinata');
  assert.equal(use(db, 'pinata', [], { now: start }).success, true);
  assert.equal(getGuildBuffs(db, '1', start).find((buff) => buff.buff_id === 'pinata')?.remaining_rolls, 10);

  const boosted = reserve(db, { user: '202', random: () => 0, id: '35' });
  assert.equal(boosted.status, 'reserved');
  assert.equal(boosted.character.id, 2, 'the Piñata must weight high-favorite characters');
  failRoll(db, boosted.rollId);

  const period = Math.floor((start + VIETNAM_OFFSET) / CLAIM_PERIOD);
  db.prepare('INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)')
    .run('1', '101', period);
  db.prepare('INSERT INTO claim_events (guild_id, user_id, claimed_at) VALUES (?, ?, ?)')
    .run('1', '101', start - 60_000);
  assert.equal(getClaimStatus(db, '1', '101', start).canClaim, false);

  const claimable = reserve(db, { id: '36', random: () => 0.99 });
  publishRoll(db, claimable.rollId, '5003', start);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '5003', userId: '101',
    now: start }).status, 'married', 'the Piñata token must fund a free claim');
});

test('Hourglass of Haste and Crown of the Sovereign keep working', (t) => {
  const db = fixture(t);
  const period = Math.floor(start / HOUR);
  db.prepare('INSERT INTO roll_allowances (guild_id, user_id, period, used) VALUES (?, ?, ?, 7)')
    .run('1', '101', period);
  grant(db, 'hourglass_of_haste');
  assert.equal(use(db, 'hourglass', [], { now: start }).success, true);
  assert.equal(getRollStatus(db, '1', '101', start).remaining, 7);

  db.prepare('INSERT INTO claim_allowances (guild_id, user_id, period) VALUES (?, ?, ?)')
    .run('1', '101', Math.floor((start + VIETNAM_OFFSET) / CLAIM_PERIOD));
  db.prepare('INSERT INTO claim_events (guild_id, user_id, claimed_at) VALUES (?, ?, ?)')
    .run('1', '101', start - 60_000);
  grant(db, 'crown_of_the_sovereign');
  assert.equal(use(db, 'crown', [], { now: start }).success, true);
  const roll = reserve(db, { id: '37', random: () => 0.99 });
  publishRoll(db, roll.rollId, '5009', start);
  assert.equal(claimRoll(db, { guildId: '1', channelId: '10', messageId: '5009', userId: '101',
    now: start }).status, 'married');
});
