import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { addItemToInventory, getInventory } from '../lib/itemStorage.js';
import { getItemAction } from '../lib/itemActionStorage.js';
import { activateItemAction, updateItemSelection, confirmHostageDelivery } from '../lib/itemActions.js';
import { startItemAction, onItemActionInteraction, recoverItemActionRuntime } from '../lib/itemActionRuntime.js';

function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  let serial = 0;
  const sent = [];
  const messages = new Map();
  const channel = { id: '10', messages: { fetch: async (id) => { if (!messages.has(id)) throw Object.assign(Error('missing'), { code: 10008 }); return messages.get(id); } },
    send: async (payload) => {
      const message = { id: String(++serial), channelId: '10', payload, edit: async (next) => { message.payload = next; return message; } };
      sent.push(message); messages.set(message.id, message); return message;
    } };
  const client = { channels: { fetch: async () => channel }, users: { fetch: async () => ({ send: async () => {} }) } };
  const message = { guildId: '1', channelId: '10', author: { id: '101' }, channel, client, reply: channel.send };
  const grant = (id) => addItemToInventory(db, '1', '101', id).item.id;
  function click(customId, msg = sent[0], userId = '101', values = []) {
    const replies = [];
    const interaction = { customId, guildId: '1', channelId: '10', user: { id: userId }, message: msg, values, client,
      reply: async (payload) => { replies.push(payload); interaction.replied = true; return { id: 'private' }; },
      followUp: async (payload) => { replies.push(payload); },
      fetchReply: async () => ({ id: 'private' }),
      deferUpdate: async () => { interaction.deferred = true; },
      editReply: async (payload) => { msg.payload = payload; }, replies };
    return interaction;
  }
  return { db, sent, channel, client, message, grant, click };
}
function components(message) { return message.payload.components.flatMap((c) => c.toJSON ? [c.toJSON()] : [c]); }
function ids(message) {
  const found = [];
  function walk(c) { if (c.custom_id) found.push(c.custom_id); for (const child of c.components ?? []) walk(child); }
  components(message).forEach(walk); return found;
}
function control(message, suffix) { const id = ids(message).find((id) => id.endsWith(`:${suffix}`)); assert.ok(id, `missing ${suffix}`); return id; }
function marry(f, id, ownerId, rank = id, name = `Character ${id}`) {
  f.db.prepare('INSERT INTO characters(id,rank,favourites,name_full) VALUES(?,?,0,?)').run(id, rank, name);
  const marriage = f.db.prepare('INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)').run('1', id, ownerId, new Date().toISOString());
  return { characterId: id, marriageId: Number(marriage.lastInsertRowid), ownerId, rank, name };
}
async function launch(f, item) { return startItemAction({ db: f.db, message: f.message, inventoryId: f.grant(item) }); }
function menus(message) {
  const found = [];
  function walk(c) { if (c.options) found.push(c); for (const child of c.components ?? []) walk(child); }
  components(message).forEach(walk); return found;
}
async function nominate(f, action, own, target) {
  const selections = { own, targets: [target] };
  assert.equal(updateItemSelection(f.db, action.id, '1', '101', selections), true);
}

test('Alchemist selects exact Common entries and confirms once through owner-bound controls', async (t) => {
  const f = fixture(t);
  const source = f.grant('alchemist');
  const costs = [f.grant('hourglass_of_haste'), f.grant('hourglass_of_haste'), f.grant('hourglass_of_haste')];
  const action = await startItemAction({ db: f.db, message: f.message, inventoryId: source });
  assert.equal(getInventory(f.db, '1', '101').length, 4);
  const foreign = f.click(control(f.sent[0], 'costs'), f.sent[0], '202', costs.map(String));
  await onItemActionInteraction(f.db, foreign);
  assert.ok(foreign.replies[0].flags);
  assert.deepEqual(getItemAction(f.db, action.id).selections.inventoryIds ?? [], []);
  const selection = f.click(control(f.sent[0], 'costs'), f.sent[0], '101', costs.map(String));
  await onItemActionInteraction(f.db, selection);
  assert.deepEqual(selection.replies, []);
  assert.deepEqual(getItemAction(f.db, action.id).selections.inventoryIds, costs);
  const confirm = control(f.sent[0], 'confirm');
  await onItemActionInteraction(f.db, f.click(confirm));
  assert.equal(getInventory(f.db, '1', '101').length, 1);
  await onItemActionInteraction(f.db, f.click(confirm));
  assert.equal(getInventory(f.db, '1', '101').length, 1);
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 0);
});


test('character picker pages exact marriage snapshots and rejects foreign server/message and expired controls', async (t) => {
  const f = fixture(t);
  for (let i = 1; i <= 26; i++) marry(f, i, '101');
  const action = await launch(f, 'chaos_exchange');
  assert.equal(menus(f.sent[0])[0].options.length, 25);
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'next')));
  assert.equal(menus(f.sent[0])[0].options.length, 1);
  const choice = menus(f.sent[0])[0].options[0].value;
  const forged = f.click(control(f.sent[0], 'character'), { id: 'wrong', channelId: '10' }, '101', [choice]);
  await onItemActionInteraction(f.db, forged);
  assert.equal(getItemAction(f.db, action.id).selections.own, undefined);
  const cross = f.click(control(f.sent[0], 'character'), f.sent[0], '101', [choice]); cross.guildId = '2';
  await onItemActionInteraction(f.db, cross);
  assert.equal(getItemAction(f.db, action.id).selections.own, undefined);
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'character'), f.sent[0], '101', [choice]));
  assert.equal(getItemAction(f.db, action.id).selections.own.characterId, 26);
  assert.ok(getItemAction(f.db, action.id).selections.own.marriageId);
  f.db.prepare('UPDATE item_actions SET expires_at=? WHERE id=?').run(Date.now() - 1, action.id);
  const expired = f.click(control(f.sent[0], 'confirm'));
  await onItemActionInteraction(f.db, expired);
  assert.match(expired.replies[0].content, /expired/);
  assert.equal(getInventory(f.db, '1', '101').length, 1);
});

test('Crown selection and confirmation stay private, including announcement retry', async (t) => {
  const f = fixture(t);
  marry(f, 1, '101', 1, 'SECRET DECOY');
  const action = await launch(f, 'counterfeit_crown');
  assert.equal(menus(f.sent[0]).length, 0);
  const open = f.click(control(f.sent[0], 'private'));
  await onItemActionInteraction(f.db, open);
  const privateMessage = { id: 'private', channelId: '10', payload: open.replies[0] };
  assert.match(JSON.stringify(privateMessage.payload), /SECRET DECOY/);
  const option = menus(privateMessage)[0].options[0].value;
  await onItemActionInteraction(f.db, f.click(control(privateMessage, 'character'), privateMessage, '101', [option]));
  const confirm = f.click(control(privateMessage, 'confirm'), privateMessage);
  await onItemActionInteraction(f.db, confirm);
  assert.match(JSON.stringify(confirm.replies), /SECRET DECOY/);
  assert.doesNotMatch(JSON.stringify(f.sent.map((m) => m.payload)), /SECRET DECOY/);
  assert.equal(getItemAction(f.db, action.id).state, 'resolved');
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 0);
});

test('Hostage delivers public stakes, binds target controls and resolves Exchange exactly once', async (t) => {
  const f = fixture(t);
  const own = marry(f, 1, '101'); const target = marry(f, 2, '202');
  const action = await launch(f, 'hostage_note');
  await nominate(f, action, own, target);
  await onItemActionInteraction(f.db, f.click(`item:${action.id}:confirm`));
  const active = getItemAction(f.db, action.id);
  assert.equal(active.state, 'active'); assert.ok(active.deadline_at > Date.now());
  const prompt = f.sent.find((m) => m.id === active.message_id);
  assert.match(JSON.stringify(prompt.payload), /equal chances/);
  const attacker = f.click(control(prompt, 'exchange'), prompt);
  await onItemActionInteraction(f.db, attacker);
  assert.equal(getItemAction(f.db, action.id).state, 'active');
  const id = control(prompt, 'exchange');
  await onItemActionInteraction(f.db, f.click(id, prompt, '202'));
  assert.equal(getItemAction(f.db, action.id).result.choice, 'exchange');
  await onItemActionInteraction(f.db, f.click(id, prompt, '202'));
  assert.equal(getItemAction(f.db, action.id).result.choice, 'exchange');
});

test('normal reconciliation preserves an in-flight delivery; startup refunds it', async (t) => {
  const f = fixture(t);
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  const own = marry(f, 1, '101'); const target = marry(f, 2, '202');
  const action = await launch(f, 'hostage_note'); await nominate(f, action, own, target);
  activateItemAction(f.db, { actionId: action.id, guildId: '1', actorId: '101' });
  await runtime.reconcile();
  assert.equal(getItemAction(f.db, action.id).state, 'awaiting_delivery');
  assert.equal(getInventory(f.db, '1', '101').length, 1);
  const restarted = await recoverItemActionRuntime(f.db, f.client); t.after(restarted.stop);
  assert.equal(getItemAction(f.db, action.id).state, 'canceled');
  assert.equal(getInventory(f.db, '1', '101').length, 1);
});

test('recovery settles due challenges and retries failed result delivery without rerolling', async (t) => {
  const f = fixture(t);
  const own = marry(f, 1, '101'); const target = marry(f, 2, '202');
  const action = await launch(f, 'hostage_note'); await nominate(f, action, own, target);
  activateItemAction(f.db, { actionId: action.id, guildId: '1', actorId: '101' });
  confirmHostageDelivery(f.db, action.id, f.sent[0].id);
  f.db.prepare('UPDATE item_actions SET deadline_at=? WHERE id=?').run(Date.now() - 1, action.id);
  const send = f.channel.send; const edit = f.sent[0].edit;
  f.channel.send = async () => { throw Error('offline'); }; f.sent[0].edit = f.channel.send;
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  const settled = getItemAction(f.db, action.id);
  assert.equal(settled.state, 'resolved'); assert.equal(settled.result.choice, 'gamble'); assert.equal(settled.delivery_pending, 1);
  f.channel.send = send; f.sent[0].edit = edit;
  await runtime.reconcile();
  assert.deepEqual(getItemAction(f.db, action.id).result, settled.result);
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 0);
});


test('Severed Fate selects only another owner and their exact character, with no own contribution', async (t) => {
  const f = fixture(t); marry(f, 2, '202');
  const action = await launch(f, 'severed_fate');
  assert.equal(ids(f.sent[0]).some((id) => id.endsWith(':slot-own')), false);
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'users'), f.sent[0], '101', ['202']));
  const choice = menus(f.sent[0])[0].options[0].value;
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'character'), f.sent[0], '101', [choice]));
  assert.equal(getItemAction(f.db, action.id).selections.own, undefined);
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'confirm')));
  assert.equal(getItemAction(f.db, action.id).state, 'resolved');
});

test('Masquerade requires three distinct other users and snapshots each nominated character', async (t) => {
  const f = fixture(t);
  marry(f, 1, '101'); marry(f, 2, '202'); marry(f, 3, '303'); marry(f, 4, '404');
  const action = await launch(f, 'grand_masquerade');
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'character'), f.sent[0], '101', [menus(f.sent[0])[0].options[0].value]));
  const invalid = f.click(control(f.sent[0], 'users'), f.sent[0], '101', ['202', '202', '404']);
  await onItemActionInteraction(f.db, invalid); assert.ok(invalid.replies.length);
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'users'), f.sent[0], '101', ['202', '303', '404']));
  for (let i = 0; i < 3; i++) {
    if (i) await onItemActionInteraction(f.db, f.click(control(f.sent[0], `slot-target${i}`)));
    await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'character'), f.sent[0], '101', [menus(f.sent[0])[0].options[0].value]));
  }
  assert.deepEqual(getItemAction(f.db, action.id).selections.targets.map((c) => c.ownerId), ['202', '303', '404']);
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'confirm')));
  assert.equal(getItemAction(f.db, action.id).state, 'resolved');
});

test('failed initial Hostage send restores its exact inventory entry', async (t) => {
  const f = fixture(t); const own = marry(f, 1, '101'); const target = marry(f, 2, '202');
  const action = await launch(f, 'hostage_note'); await nominate(f, action, own, target);
  const before = getInventory(f.db, '1', '101');
  f.channel.send = async () => { throw Error('forbidden'); };
  await onItemActionInteraction(f.db, f.click(`item:${action.id}:confirm`));
  assert.equal(getItemAction(f.db, action.id).state, 'canceled');
  assert.deepEqual(getInventory(f.db, '1', '101'), before);
});


test('transient live fetch failures preserve binding and later reconciliation repairs deleted prompts', async (t) => {
  const f = fixture(t);
  const own = marry(f, 1, '101'); const target = marry(f, 2, '202');
  const action = await launch(f, 'hostage_note'); await nominate(f, action, own, target);
  await onItemActionInteraction(f.db, f.click(`item:${action.id}:confirm`));
  const active = getItemAction(f.db, action.id);
  const fetch = f.channel.messages.fetch;
  f.channel.messages.fetch = async () => { throw Error('temporary network failure'); };
  const before = f.sent.length;
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  assert.equal(f.sent.length, before);
  assert.equal(getItemAction(f.db, action.id).message_id, active.message_id);
  f.channel.messages.fetch = async () => { throw Object.assign(Error('deleted'), { code: 10008 }); };
  await runtime.reconcile();
  const repaired = getItemAction(f.db, action.id);
  assert.notEqual(repaired.message_id, active.message_id);
  assert.equal(repaired.deadline_at, active.deadline_at);
  assert.equal(f.sent.length, before + 1);
  f.channel.messages.fetch = fetch;
  const prompt = f.sent.at(-1);
  await onItemActionInteraction(f.db, f.click(control(prompt, 'exchange'), prompt, '202'));
  assert.equal(getItemAction(f.db, action.id).result.choice, 'exchange');
});

test('result fetch failures retry without replacing an existing message', async (t) => {
  const f = fixture(t);
  const action = await launch(f, 'chaos_exchange');
  const original = f.sent[0];
  const fetch = f.channel.messages.fetch;
  f.channel.messages.fetch = async () => { throw Error('offline'); };
  await onItemActionInteraction(f.db, f.click(control(original, 'cancel')));
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 1);
  assert.equal(getItemAction(f.db, action.id).message_id, original.id);
  assert.equal(f.sent.length, 1);
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  f.channel.messages.fetch = fetch;
  await runtime.reconcile();
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 0);
  assert.equal(f.sent.length, 1);
  assert.match(JSON.stringify(original.payload), /cancel/i);
});

test('live repair skips an in-flight initial confirmation send', async (t) => {
  const f = fixture(t);
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  const reply = f.message.reply;
  let release;
  f.message.reply = async (data) => {
    await new Promise((resolve) => { release = resolve; });
    return reply(data);
  };
  const launching = launch(f, 'chaos_exchange');
  assert.equal(typeof release, 'function');
  await runtime.reconcile();
  assert.equal(f.sent.length, 0);
  release();
  const action = await launching;
  await runtime.reconcile();
  assert.equal(f.sent.length, 1);
  assert.equal(getItemAction(f.db, action.id).message_id, f.sent[0].id);
});

test('live repair holds the busy guard across replacement sends', async (t) => {
  const f = fixture(t);
  const action = await launch(f, 'chaos_exchange');
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  f.channel.messages.fetch = async () => { throw Object.assign(Error('deleted'), { code: 10008 }); };
  const send = f.channel.send;
  let release;
  let started;
  const sending = new Promise((resolve) => { started = resolve; });
  f.channel.send = async (data) => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return send(data);
  };
  const repairing = runtime.reconcile();
  await sending;
  await runtime.reconcile();
  const click = f.click(control(f.sent[0], 'cancel'));
  await onItemActionInteraction(f.db, click);
  assert.match(click.replies[0].content, /already being processed/);
  release();
  await repairing;
  assert.equal(getItemAction(f.db, action.id).state, 'confirming');
  assert.equal(f.sent.length, 2);
});

test('live reconciliation rotates through more than 100 confirmations despite inaccessible older prompts', async (t) => {
  const f = fixture(t);
  const first = await launch(f, 'chaos_exchange');
  // Durable confirmations need not share inventory entries or owners to exercise the runtime.
  const insert = f.db.prepare(`INSERT INTO item_actions(id,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at,message_id)
    SELECT ?,kind,guild_id,actor_id,channel_id,inventory_id,state,selections_json,created_at,expires_at,? FROM item_actions WHERE id=?`);
  const ids = Array.from({ length: 257 }, (_, i) => `confirmation-${String(i).padStart(4, '0')}`);
  for (const id of ids) insert.run(id, `missing-${id}`, first.id);
  const visited = new Set();
  f.channel.messages.fetch = async (id) => {
    visited.add(id);
    if (id.includes('confirmation-000')) throw Error('temporarily forbidden');
    throw Object.assign(Error('deleted'), { code: 10008 });
  };
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  for (let attempt = 0; attempt < ids.length && visited.size < ids.length + 1; attempt++) await runtime.reconcile();
  for (const id of ids) assert.ok(visited.has(`missing-${id}`), `${id} was starved`);
  // A previously inaccessible entry must still be revisited after its turn passed.
  f.channel.messages.fetch = async () => { throw Object.assign(Error('deleted'), { code: 10008 }); };
  for (let attempt = 0; attempt < ids.length && getItemAction(f.db, ids[0]).message_id.startsWith('missing-'); attempt++) await runtime.reconcile();
  assert.ok(!getItemAction(f.db, ids[0]).message_id.startsWith('missing-'));
});

test('failed private Crown confirmation never blocks its public announcement and retries privately', async (t) => {
  const f = fixture(t); const own = marry(f, 1, '101', 1, 'HIDDEN CROWN');
  const action = await launch(f, 'counterfeit_crown');
  updateItemSelection(f.db, action.id, '1', '101', { own });
  activateItemAction(f.db, { actionId: action.id, guildId: '1', actorId: '101' });
  f.client.users.fetch = async () => { throw Error('DM closed'); };
  const runtime = await recoverItemActionRuntime(f.db, f.client); t.after(runtime.stop);
  assert.match(JSON.stringify(f.sent[0].payload), /is active/);
  assert.doesNotMatch(JSON.stringify(f.sent.map((m) => m.payload)), /HIDDEN CROWN/);
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 1);
  const privateMessages = [];
  f.client.users.fetch = async () => ({ send: async (data) => privateMessages.push(data) });
  await runtime.reconcile();
  assert.match(JSON.stringify(privateMessages), /HIDDEN CROWN/);
  assert.equal(getItemAction(f.db, action.id).delivery_pending, 0);
});
