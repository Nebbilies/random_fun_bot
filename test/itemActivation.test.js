import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, createFinalCatalog } from '../lib/catalogDb.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { run } from '../commands/use.js';
import { onInventoryButton } from '../commands/inv.js';
import { activateItem } from '../lib/itemActivation.js';

function fixture(t, { failSend = false, final = false } = {}) {
  const dir = final ? mkdtempSync(join(tmpdir(), 'activation-merge-')) : null;
  const db = final ? createFinalCatalog(join(dir, 'fixture.sqlite')) : openCatalog(':memory:');
  t.after(() => { db.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const sent = [], feedback = [], edits = [];
  const channel = { id: '10', send: async (payload) => {
    if (failSend) throw new Error('Discord unavailable');
    sent.push(payload);
    return { id: '500', edit: async () => {}, react: async () => {} };
  } };
  const message = { id: '900', guildId: '1', channelId: '10', author: { id: '101' }, channel,
    reply: async (payload) => { feedback.push(payload); return { id: '501' }; } };
  const interaction = { id: '999', guildId: '1', channelId: '10', channel,
    user: { id: '101', username: 'Player' }, isButton: () => true,
    deferUpdate: async () => { interaction.deferred = true; },
    editReply: async (payload) => { edits.push(payload); },
    reply: async (payload) => { feedback.push(payload); },
    followUp: async (payload) => { feedback.push(payload); return { id: '502' }; } };
  return { db, sent, feedback, edits, message, interaction };
}

for (const kind of ['master_key', 'pickpockets_hook']) test(`${kind}: committed character delivery is durable and does not leak during anticipation`, async (t) => {
  const x = fixture(t);
  x.db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,10,20,'Hidden Character'); INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',1,'202','2026')");
  const source = addItemToInventory(x.db, '1', '101', kind).item;
  let pauses = 0;
  const edits = [];
  x.message.channel.send = async (payload) => { x.sent.push(payload); return { id: '500', edit: async (data) => edits.push(data) }; };
  const result = await activateItem({ db: x.db, message: x.message, inventoryId: source.id, args: ['<@202>', 'Hidden Character'],
    options: { wait: async () => { pauses++; assert.equal(x.db.prepare('SELECT owner_id FROM marriages').get().owner_id, '101'); } } });
  assert.equal(result.success, true);
  assert.equal(getInventory(x.db, '1', '101').length, 0);
  const action = x.db.prepare('SELECT * FROM item_actions').get();
  assert.equal(action.delivery_pending, 0);
  assert.equal(action.message_id, '500');
  assert.equal(pauses, kind === 'master_key' ? 0 : 2);
  if (kind === 'pickpockets_hook') {
    assert.ok(!JSON.stringify(x.sent[0]).includes('Hidden Character'));
    assert.match(JSON.stringify(edits.at(-1)), /Hidden Character/);
  } else {
    assert.match(JSON.stringify(x.sent[0]), /Hidden Character/);
    assert.equal(x.sent[0].components[0].toJSON().type, 10);
  }
});

for (const entry of ['command', 'button']) {
  test(`${entry}: ordinary activation consumes once and retains its feedback style`, async (t) => {
    const x = fixture(t);
    const granted = addItemToInventory(x.db, '1', '101', 'love_letter', 2);
    if (entry === 'command') {
      await run({ message: x.message, args: ['use', 'love_letter'], yoshiko: { catalogDb: x.db } });
      assert.equal(typeof x.feedback[0], 'string');
    } else {
      x.interaction.customId = `inv:use:101:${granted.item.id}`;
      await onInventoryButton(x.db, x.interaction);
      assert.equal(x.edits.length, 1);
      assert.equal(x.feedback[0].flags, 64);
    }
    assert.equal(getInventory(x.db, '1', '101')[0].charges, 1);
    assert.equal(x.sent.length, 0);
    assert.equal(x.feedback.length, 1);
  });

  for (const final of [false, true]) for (const failSend of [false, true]) {
    test(`${entry}: Golden Hour completes its vault follow-up; final=${final}; send failure=${failSend}`, async (t) => {
      const x = fixture(t, { failSend, final });
      const granted = addItemToInventory(x.db, '1', '101', 'golden_hour');
      x.db.prepare('INSERT INTO roll_allowances(guild_id,user_id,period,used) VALUES(?,?,?,?)').run('1', '202', 0, 5);
      if (entry === 'command') {
        await run({ message: x.message, args: ['use', 'golden_hour'], yoshiko: { catalogDb: x.db } });
      } else {
        x.interaction.customId = `inv:use:101:${granted.item.id}${final ? ':v12' : ''}`;
        assert.equal(await onInventoryButton(x.db, x.interaction), true);
        assert.equal(x.interaction.deferred, true);
        assert.equal(x.edits.length, 1);
      }
      assert.equal(getInventory(x.db, '1', '101').length, 0);
      if (final) {
        const sessions = x.db.prepare('SELECT command_message_id,state FROM vault_sessions').all();
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].command_message_id, entry === 'button' ? 'interaction:999' : '900');
        assert.equal(sessions[0].state, 'unopened');
      }
      assert.equal(x.db.prepare('SELECT used FROM roll_allowances WHERE user_id=?').get('202').used, 0);
      assert.equal(x.feedback.length, 1);
      if (failSend) {
        assert.match(JSON.stringify(x.feedback), /committed effect and cost remain unchanged/);
        assert.equal(x.sent.length, 0);
      } else {
        assert.equal(x.sent.length, 1);
        if (entry === 'button') assert.equal(x.sent[0].reply, undefined);
        else assert.equal(x.sent[0].reply.messageReference, '900');
      }
    });
  }

  test(`${entry}: invalid argument-based use preserves item and reports requirements`, async (t) => {
    const x = fixture(t);
    const granted = addItemToInventory(x.db, '1', '101', 'franchise_passport');
    if (entry === 'command') {
      await run({ message: x.message, args: ['use', 'franchise_passport'], yoshiko: { catalogDb: x.db } });
    } else {
      x.interaction.customId = `inv:use:101:${granted.item.id}`;
      await onInventoryButton(x.db, x.interaction);
    }
    assert.equal(getInventory(x.db, '1', '101').length, 1);
    assert.equal(x.sent.length, 0);
    assert.match(JSON.stringify(x.feedback), /franchise/i);
  });

  test(`${entry}: durable action opens confirmation without spending its item`, async (t) => {
    const x = fixture(t);
    const granted = addItemToInventory(x.db, '1', '101', 'kaimetsu');
    if (entry === 'command') {
      await run({ message: x.message, args: ['use', 'kaimetsu'], yoshiko: { catalogDb: x.db } });
    } else {
      x.interaction.customId = `inv:use:101:${granted.item.id}`;
      await onInventoryButton(x.db, x.interaction);
    }
    assert.equal(getInventory(x.db, '1', '101').length, 1);
    assert.match(JSON.stringify(x.feedback), /Confirm guild-wide divorce/);
    assert.equal(x.db.prepare('SELECT state FROM item_actions').get().state, 'confirming');
  });
}

test('shared activation opens a forced escape and consumes its source once', async (t) => {
  const x = fixture(t);
  x.db.exec(`INSERT INTO characters(id,rank,favourites,name_full,gender,anime_titles) VALUES(1,1,100,'Alpha','Female','[]');
    INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',1,'202','now');`);
  addItemToInventory(x.db, '1', '101', 'sirens_call');
  await activateItem({ db: x.db, message: x.message, itemQuery: 'sirens_call', args: ['202'] });
  assert.equal(x.sent.length, 1);
  assert.equal(x.feedback.length, 0);
  assert.equal(getInventory(x.db, '1', '101').length, 0);
  assert.equal(x.db.prepare('SELECT state FROM character_rolls').get().state, 'open');
});

test('failed inventory refresh still delivers private feedback without replay', async (t) => {
  const x = fixture(t);
  const granted = addItemToInventory(x.db, '1', '101', 'golden_hour');
  x.interaction.customId = `inv:use:101:${granted.item.id}`;
  x.interaction.editReply = async () => { throw new Error('Inventory deleted'); };
  await onInventoryButton(x.db, x.interaction);
  assert.equal(x.sent.length, 1);
  assert.equal(x.feedback.length, 1);
  assert.equal(x.feedback[0].flags, 64);
  assert.equal(getInventory(x.db, '1', '101').length, 0);
});

test('failed escape send preserves committed cost and pending recovery without replay', async (t) => {
  const x = fixture(t, { failSend: true });
  x.db.exec(`INSERT INTO characters(id,rank,favourites,name_full,gender,anime_titles) VALUES(1,1,100,'Alpha','Female','[]');
    INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',1,'202','now');`);
  addItemToInventory(x.db, '1', '101', 'sirens_call');
  const result = await activateItem({ db: x.db, message: x.message, itemQuery: 'sirens_call', args: ['202'] });
  assert.equal(result.deliveryFailed, true);
  assert.equal(x.feedback.length, 1);
  assert.equal(getInventory(x.db, '1', '101').length, 0);
  assert.equal(x.db.prepare('SELECT state FROM character_rolls').get().state, 'pending');
});

test('stale inventory button reports failure without activating anything', async (t) => {
  const x = fixture(t);
  x.interaction.customId = 'inv:use:101:999';
  await onInventoryButton(x.db, x.interaction);
  assert.equal(x.sent.length, 0);
  assert.equal(x.edits.length, 0);
  assert.match(x.feedback[0].content, /Item not found/);
});

test('inventory ownership check rejects another player before activation', async (t) => {
  const x = fixture(t);
  const granted = addItemToInventory(x.db, '1', '101', 'golden_hour');
  x.interaction.customId = `inv:use:101:${granted.item.id}`;
  x.interaction.user.id = '202';
  await onInventoryButton(x.db, x.interaction);
  assert.equal(x.interaction.deferred, undefined);
  assert.equal(getInventory(x.db, '1', '101').length, 1);
  assert.equal(x.sent.length, 0);
});
