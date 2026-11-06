import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog, setMeta } from '../lib/catalogDb.js';
import { loadCharacterIndex } from '../lib/gameCharacterLookup.js';
import { getSoulmateState, confirmSoulmate } from '../lib/characterAffection.js';
import { registerPendingTransfer } from '../lib/characterAvailability.js';
import { run } from '../commands/soulmate.js';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'soulmate-command-'));
  const db = createFinalCatalog(join(dir, 'synthetic.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const [id, rank] of [[a, 1], [b, 2]]) {
    db.prepare("INSERT INTO character_identities(id,name_full,creation_method) VALUES(?,?,'manual')").run(id, `Shared ${rank}`);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,?,0,?,'generated',?)").run(id, rank, rank, `Shared ${rank}`);
    db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','date')").run(id);
  }
  return db;
}
function transport(db, args) {
  const collector = Object.assign(new EventEmitter(), { stop: () => collector.emit('end') });
  let payload;
  const reply = { id: '900', edit: async value => { payload = value; return reply; }, createMessageComponentCollector: () => collector };
  const ctx = { args, prefix: '~', yoshiko: { catalogDb: db, characterIndex: loadCharacterIndex(db) },
    message: { id: '100', guildId: '1', channelId: '10', author: { id: '101', username: 'Neb' },
      reply: async value => { payload = value; return reply; } } };
  return { ctx, collector, payload: () => payload };
}
async function click(mock, customId, extras = {}) {
  const errors = [];
  const interaction = { customId, user: { id: '101' }, guildId: '1', channelId: '10', message: { id: '900' },
    deferUpdate: async () => {}, followUp: async value => errors.push(value), reply: async value => errors.push(value), ...extras };
  for (const listener of mock.collector.listeners('collect')) await listener(interaction);
  return errors;
}
const text = value => JSON.stringify(value);

test('unowned and busy candidates explain blockers before confirmation', async t => {
  const db=fixture(t);
  db.prepare("DELETE FROM marriages WHERE character_id=?").run(b);
  const unowned=transport(db,['sm','#2']); await run(unowned.ctx);
  assert.match(text(unowned.payload()),/must currently own/);
  assert.equal(unowned.payload().components[0].toJSON().components[0].disabled,true);
  db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,'101','date')").run(b);
  registerPendingTransfer(db,'test','1',[b]);
  const busy=transport(db,['sm','#2']); await run(busy.ctx);
  assert.match(text(busy.payload()),/character is busy/);
  assert.equal(busy.payload().components[0].toJSON().components[0].disabled,true);
  confirmSoulmate(db,{guildId:'1',userId:'101',characterId:a,now:Date.now()});
  const locked=transport(db,['sm','#1']); await run(locked.ctx);
  assert.match(text(locked.payload()),/Active soulmate perks/);
});

test('switch preview names the replaced soulmate and disables confirm during cooldown', async t => {
  const db=fixture(t);
  confirmSoulmate(db,{guildId:'1',userId:'101',characterId:a,now:Date.now()});
  const mock=transport(db,['sm','#2']); await run(mock.ctx);
  assert.match(text(mock.payload()),/Replaces.*Shared 1.*active soulmate perks/);
  assert.match(text(mock.payload()),/can switch soulmates <t:/);
  assert.equal(mock.payload().components[0].toJSON().components[0].disabled,true);
  assert.equal(mock.payload().components[0].toJSON().components[1].disabled,false);
});

test('no selection gives dynamic-prefix guidance, not an invented meter', async t => {
  const db = fixture(t), mock = transport(db, ['sm']);
  await run(mock.ctx);
  assert.match(text(mock.payload()), /No soulmate selected/);
  assert.match(text(mock.payload()), /~soulmate/);
  assert.doesNotMatch(text(mock.payload()), /▰|▱/);
});

test('selection requires explicit confirmation scoped to actor, guild, channel and message', async t => {
  const db = fixture(t), mock = transport(db, ['soulmate', '#1']);
  await run(mock.ctx);
  assert.equal(getSoulmateState(db, '1', '101').characterId, null);
  assert.match(text(mock.payload()), /12-hour/);
  for (const extras of [{ user: { id: '999' } }, { guildId: '2' }, { channelId: '20' }, { message: { id: '901' } }]) {
    assert.match(text(await click(mock, 'soulmate:confirm', extras)), /Only the command author/);
    assert.equal(getSoulmateState(db, '1', '101').characterId, null);
  }
  await click(mock, 'soulmate:confirm');
  assert.equal(getSoulmateState(db, '1', '101').characterId, a);
  assert.equal(mock.payload().embeds[0].toJSON().color, 0xF2C66D);
  assert.equal(mock.payload().components.length, 0);
  assert.match(text(mock.payload()), /Available <t:/);
  assert.doesNotMatch(mock.payload().embeds[0].toJSON().footer.text, /<t:/);
  const state = getSoulmateState(db, '1', '101');
  await click(mock, 'soulmate:confirm');
  assert.deepEqual(getSoulmateState(db, '1', '101'), state);
});

test('same-active status does not reset cooldown, even during maintenance', async t => {
  const db = fixture(t);
  confirmSoulmate(db, { guildId: '1', userId: '101', characterId: a, expectedRevision: 0, now: 100 });
  setMeta(db, 'game_maintenance', 'drain');
  const before = getSoulmateState(db, '1', '101');
  const mock = transport(db, ['sm', '#1']);
  await run(mock.ctx);
  assert.equal(mock.payload().embeds[0].toJSON().color, 0xF2C66D);
  assert.deepEqual(getSoulmateState(db, '1', '101'), before);
});

test('ambiguous choice stays fixed to UUID despite rank change, then still needs confirmation', async t => {
  const db = fixture(t), mock = transport(db, ['sm', 'Shared']);
  await run(mock.ctx);
  db.prepare('UPDATE characters SET rank=50 WHERE id=?').run(a);
  await click(mock, 'soulmate:choose', { values: [a] });
  assert.match(text(mock.payload()), /Choose Shared 1/);
  assert.equal(getSoulmateState(db, '1', '101').characterId, null);
  await click(mock, 'soulmate:confirm');
  assert.equal(getSoulmateState(db, '1', '101').characterId, a);
});

test('two racing prompts cannot overwrite selection using a stale revision', async t => {
  const db = fixture(t), first = transport(db, ['sm', '#1']), second = transport(db, ['sm', '#2']);
  await run(first.ctx); await run(second.ctx);
  await click(first, 'soulmate:confirm');
  await click(second, 'soulmate:confirm');
  assert.equal(getSoulmateState(db, '1', '101').characterId, a);
  assert.match(text(second.payload()), /selection changed/);
});

test('switch cooldown refuses a different candidate without resetting the saved deadline', async t => {
  const db = fixture(t);
  confirmSoulmate(db, { guildId: '1', userId: '101', characterId: a, expectedRevision: 0, now: Date.now() });
  const before = getSoulmateState(db, '1', '101');
  const mock = transport(db, ['sm', '#2']);
  await run(mock.ctx); await click(mock, 'soulmate:confirm');
  assert.match(text(mock.payload()), /can switch soulmates <t:/);
  assert.deepEqual(getSoulmateState(db, '1', '101'), before);
});

test('commit rechecks transferred ownership and busy characters', async t => {
  const db = fixture(t), ownership = transport(db, ['sm', '#1']);
  await run(ownership.ctx);
  db.prepare("UPDATE marriages SET owner_id='202' WHERE character_id=?").run(a);
  await click(ownership, 'soulmate:confirm');
  assert.match(text(ownership.payload()), /must currently own/);
  assert.equal(getSoulmateState(db, '1', '101').characterId, null);
  const busy = transport(db, ['sm', '#2']);
  await run(busy.ctx);
  registerPendingTransfer(db, 'gift', '1', [b], Date.now() + 60000);
  await click(busy, 'soulmate:confirm');
  assert.match(text(busy.payload()), /character is busy/);
  assert.equal(getSoulmateState(db, '1', '101').characterId, null);
});

test('maintenance is checked on opening and again at confirmation; status stays available', async t => {
  const db = fixture(t), mock = transport(db, ['sm', '#1']);
  await run(mock.ctx);
  setMeta(db, 'game_maintenance', 'drain');
  const errors = await click(mock, 'soulmate:confirm');
  assert.match(text(errors), /maintenance/);
  assert.equal(getSoulmateState(db, '1', '101').characterId, null);
  const blocked = transport(db, ['sm', '#2']);
  await run(blocked.ctx);
  assert.match(text(blocked.payload()), /draining for maintenance/);
  const status = transport(db, ['sm']);
  await run(status.ctx);
  assert.match(text(status.payload()), /No soulmate selected/);
});

test('cancel and timeout disable selection authority without changing state', async t => {
  const db = fixture(t), cancel = transport(db, ['sm', '#1']);
  await run(cancel.ctx); await click(cancel, 'soulmate:cancel');
  assert.match(text(cancel.payload()), /cancelled/);
  await click(cancel, 'soulmate:confirm');
  assert.equal(getSoulmateState(db, '1', '101').characterId, null);
  const timeout = transport(db, ['sm', '#2']);
  await run(timeout.ctx); timeout.collector.emit('end'); await Promise.resolve();
  assert.ok(timeout.payload().components[0].toJSON().components.every(button => button.disabled));
  await click(timeout, 'soulmate:confirm');
  assert.equal(getSoulmateState(db, '1', '101').characterId, null);
});
