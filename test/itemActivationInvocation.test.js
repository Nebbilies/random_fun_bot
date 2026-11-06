import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { addItemToInventory } from '../lib/itemStorage.js';
import { activateItem, executeItemUse, executeItemUseById } from '../lib/itemActivation.js';
import { activateItemAction, cancelItemAction, createItemAction, expireItemActions, updateItemSelection } from '../lib/itemActions.js';
import { getItemAction } from '../lib/itemActionStorage.js';
import { startItemAction } from '../lib/itemActionRuntime.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'manual-action-invocation-'));
  const db = createFinalCatalog(join(dir, 'synthetic.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  let serial = 0;
  const sent = [], replies = [], messages = new Map();
  async function send(data) {
    const message = { id: String(++serial), data, edit: async next => { message.data = next; return message; } };
    messages.set(message.id, message); sent.push(message); return message;
  }
  const channel = { id: '10', guildId: '1', send, messages: { fetch: async id => {
    if (!messages.has(id)) throw Object.assign(Error('missing'), { code: 10008 });
    return messages.get(id);
  } } };
  const client = { channels: { fetch: async () => channel } };
  const message = { id: 'M', guildId: '1', channelId: '10', author: { id: '101' }, channel, client,
    reply: async data => { replies.push(data); return send(data); } };
  const now = Date.now();
  function character(index, owner) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(id);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES(?,?,1,?,'generated',?)")
      .run(id, index, index, `Character ${index}`);
    const marriage = db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1',?,?,'2026')").run(id, owner);
    return { characterId: id, ownerId: owner, marriageId: Number(marriage.lastInsertRowid) };
  }
  const own = character(1, '101');
  db.prepare("INSERT INTO character_affection VALUES('1','101',?,2100,0)").run(own.characterId);
  db.prepare("INSERT INTO player_soulmates VALUES('1','101',?,0,0,1)").run(own.characterId);
  const target = character(2, '202');
  const source = addItemToInventory(db, '1', '101', 'severed_fate', 1, { now }).item;
  const launch = (extra = {}) => activateItem({ db, message, inventoryId: source.id, options: { now }, ...extra });
  const count = table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  return { db, message, source, target, now, launch, replies, sent, count };
}
function resolve(f, actionId, random = () => 0) {
  assert.equal(updateItemSelection(f.db, actionId, '1', '101', { targets: [f.target] }, f.now), true);
  return activateItemAction(f.db, { actionId, guildId: '1', actorId: '101', now: f.now, random });
}
function noConfirmation(data) { assert.doesNotMatch(JSON.stringify(data), /:confirm|Confirm activation/); }

test('public activation binds M: conserved resolved attack replay cannot create another action or decision; M2 can', async t => {
  const f = fixture(t);
  const first = await f.launch();
  const action = f.db.prepare('SELECT id FROM item_actions').get();
  const outcome = resolve(f, action.id);
  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.actualDebit, 0);
  assert.equal(f.db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(f.source.id).charges, 1);
  const decisions = f.count('affection_decisions');
  const replay = await f.launch();
  assert.equal(f.count('item_actions'), 1);
  assert.deepEqual(await f.launch({ itemQuery: 'not-an-item', inventoryId: undefined }), first);
  assert.equal(first.actionId, action.id);
  assert.deepEqual(replay, first);
  assert.equal(f.count('affection_decisions'), decisions);
  assert.equal(f.count('item_use_reservations'), 0);
  noConfirmation(f.replies.at(-1));
  f.message.id = 'M2';
  const next = await f.launch();
  assert.notEqual(next.actionId, action.id);
  assert.equal(getItemAction(f.db, next.actionId).state, 'confirming');
  assert.equal(f.count('item_actions'), 2);
  assert.equal(f.count('item_use_reservations'), 1);
});

for (const ending of ['canceled', 'expired']) test(`public activation resumes ${ending} M without changing its outcome or reserving again`, async t => {
  const f = fixture(t);
  await f.launch();
  const original = f.db.prepare('SELECT * FROM item_actions').get();
  if (ending === 'canceled') cancelItemAction(f.db, original.id, '1', '101');
  else expireItemActions(f.db, original.expires_at);
  const before = getItemAction(f.db, original.id);
  await f.launch();
  const after = getItemAction(f.db, original.id);
  assert.equal(f.count('item_actions'), 1);
  assert.equal(f.count('item_use_reservations'), 0);
  assert.equal(after.state, ending);
  assert.deepEqual(after.result, before.result);
  assert.equal(after.expires_at, before.expires_at);
  noConfirmation(f.replies.at(-1));
});

test('last-charge terminal replay looks up the receipt before inventory, even with a different selection', async t => {
  const f = fixture(t);
  await f.launch();
  const { id } = f.db.prepare('SELECT id FROM item_actions').get();
  assert.equal(resolve(f, id, () => .99).actualDebit, 1);
  assert.equal(f.db.prepare('SELECT id FROM user_inventory WHERE id=?').get(f.source.id), undefined);
  // Trap inventory reads, not just the visible item-not-found error.
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = sql => {
    if (/user_inventory/i.test(sql)) throw Error('replay looked up inventory');
    return prepare(sql);
  };
  t.after(() => { f.db.prepare = prepare; });
  const receipt = executeItemUseById(f.db, '1', '101', 999, [], { commandMessageId: 'M', channelId: '10' });
  assert.equal(receipt.actionId, id);
  assert.equal(executeItemUse(f.db, '1', '101', 'missing', [], { commandMessageId: 'M', channelId: '10' }).actionId, id);
  const replay = await f.launch();
  assert.equal(replay.actionId, id);
  assert.equal(f.count('item_actions'), 1);
  noConfirmation(f.replies.at(-1));
});

test('manual invocation rejects changed actor, guild or channel and direct action-ID scope mismatches', async t => {
  const f = fixture(t);
  await f.launch();
  const { id } = f.db.prepare('SELECT id FROM item_actions').get();
  for (const patch of [{ author: { id: '202' } }, { guildId: '2' }, { channelId: '11' }]) {
    const message = { ...f.message, ...patch };
    await assert.rejects(f.launch({ message }), /scope/i);
    await assert.rejects(startItemAction({ db: f.db, message, options: { actionId: id } }), /scope/i);
  }
  assert.equal(f.count('item_actions'), 1);
  assert.equal(f.count('item_use_reservations'), 1);
});

test('overlapping public M deliveries share one held action and one confirmation prompt', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.launch(), f.launch()]);
  assert.equal(f.count('item_actions'), 1);
  assert.equal(results[0].actionId, results[1].actionId);
  assert.equal(f.count('item_action_costs'), 1);
  assert.equal(f.count('item_use_reservations'), 1);
  assert.equal(f.replies.length, 1);
  const before = getItemAction(f.db, results[0].actionId);
  await f.launch();
  assert.equal(f.replies.length, 1); // repair the original prompt, don't replace its binding
  assert.equal(getItemAction(f.db, before.id).message_id, before.message_id);
});

test('a new explicit inventory interaction ID is independent, while its own replay remains bound', async t => {
  const f = fixture(t);
  f.message.activationId = 'interaction:I';
  const first = await f.launch();
  cancelItemAction(f.db, first.actionId, '1', '101');
  assert.deepEqual(await f.launch(), first);
  f.message.activationId = 'interaction:I2';
  const next = await f.launch();
  assert.notEqual(next.actionId, first.actionId);
  assert.equal(f.count('item_actions'), 2);
  assert.equal(f.count('item_use_reservations'), 1);
});

test('replaying an overdue but unswept confirmation expires only the original action', async t => {
  const f = fixture(t);
  const first = await f.launch();
  const original = getItemAction(f.db, first.actionId);
  const replay = await f.launch({ options: { now: original.expires_at } });
  assert.deepEqual(replay, first);
  assert.equal(getItemAction(f.db, first.actionId).state, 'expired');
  assert.equal(f.count('item_actions'), 1);
  assert.equal(f.count('item_use_reservations'), 0);
  assert.equal(f.count('affection_decisions'), 0);
  noConfirmation(f.replies.at(-1));
});

test('direct runtime invocation option shares its durable action instead of creating another hold', async t => {
  const f = fixture(t);
  const request = { db: f.db, message: f.message, inventoryId: f.source.id,
    options: { invocationId: 'item-use:direct', now: f.now } };
  const first = await startItemAction(request);
  cancelItemAction(f.db, first.id, '1', '101');
  const replay = await startItemAction({ ...request, inventoryId: 999 });
  assert.equal(replay.id, first.id);
  assert.equal(replay.state, 'canceled');
  assert.equal(f.count('item_actions'), 1);
  assert.equal(f.count('item_use_reservations'), 0);
  noConfirmation(f.replies.at(-1));
});

test('receipt failure atomically rolls back action creation and both source holds', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER fail_manual_receipt BEFORE INSERT ON affection_invocations WHEN NEW.kind='manual_item' BEGIN SELECT RAISE(ABORT,'receipt failed'); END");
  const request = { guildId: '1', actorId: '101', channelId: '10', inventoryId: f.source.id, invocationId: 'item-use:M', now: f.now };
  assert.throws(() => createItemAction(f.db, request), /receipt failed/);
  assert.equal(f.count('item_actions'), 0);
  assert.equal(f.count('item_action_costs'), 0);
  assert.equal(f.count('item_use_reservations'), 0);
  assert.equal(f.count('affection_invocations'), 0);
  f.db.exec('DROP TRIGGER fail_manual_receipt');
  const action = createItemAction(f.db, request);
  assert.equal(createItemAction(f.db, { ...request, inventoryId: 999 }).id, action.id);
  assert.equal(f.count('item_actions'), 1);
});
