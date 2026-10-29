import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';
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

test('Blood Pact opens a V2 sacrifice select instead of requiring typed names', async (t) => {
  const f = fixture(t);
  for (let id = 1; id <= 3; id++) marry(f, id, '101', id, `Multiword Name ${id}`);
  const action = await launch(f, 'blood_pact');
  assert.ok(action.id);
  assert.ok(f.sent[0].payload.flags & 32768);
  const menu = menus(f.sent[0])[0];
  assert.ok(menu.custom_id.endsWith(':sacrifices'));
  assert.equal(menu.max_values, 3);
  assert.equal(menu.options.length, 3);
  assert.equal(getInventory(f.db, '1', '101').length, 1);
});

function pactPool(f) {
  // Duplicate names deliberately exercise exact identity selection.
  const choices = [1, 2, 3].map((id) => marry(f, id, '101', id * 100, 'Same Multiword Name'));
  f.db.exec(`INSERT INTO characters(id,rank,favourites,name_full) VALUES(4,10,0,'Summon');
    INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Shared franchise','2026');
    INSERT INTO anime(id,title_romaji,fetched_at) VALUES(1,'Shared franchise','2026');
    INSERT INTO franchise_anime(franchise_id,anime_id) VALUES(1,1);
    INSERT INTO character_anime(character_id,anime_id) VALUES(1,1),(2,1),(3,1),(4,1);`);
  return choices;
}

test('Blood Pact selects exact duplicate-name sacrifices and activates only once', async (t) => {
  const f = fixture(t);
  const choices = pactPool(f);
  const action = await launch(f, 'blood_pact');
  const menu = control(f.sent[0], 'sacrifices');
  const values = choices.map((c) => `${c.characterId}.${c.marriageId}`);
  await onItemActionInteraction(f.db, f.click(menu, f.sent[0], '202', values));
  assert.equal(getItemAction(f.db, action.id).selections.sacrifices, undefined);
  await onItemActionInteraction(f.db, f.click(menu, f.sent[0], '101', values));
  assert.equal(getItemAction(f.db, action.id).selections.sacrifices.length, 3);
  const confirm = control(f.sent[0], 'confirm');
  await onItemActionInteraction(f.db, f.click(confirm));
  assert.equal(getItemAction(f.db, action.id).state, 'resolved');
  assert.deepEqual(f.db.prepare('SELECT character_id FROM marriages').all().map((r) => r.character_id), [4]);
  assert.equal(getInventory(f.db, '1', '101').length, 0);
  await onItemActionInteraction(f.db, f.click(confirm));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n, 1);
});

for (const changed of ['ownership', 'franchise', 'soulbind', 'no reward', 'cancel']) test(`Blood Pact preserves item and sacrifices on ${changed}`, async (t) => {
  const f = fixture(t);
  const choices = pactPool(f);
  const action = await launch(f, 'blood_pact');
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'sacrifices'), f.sent[0], '101', choices.map((c) => `${c.characterId}.${c.marriageId}`)));
  if (changed === 'ownership') f.db.exec("UPDATE marriages SET owner_id='202' WHERE character_id=1");
  if (changed === 'franchise') f.db.exec('DELETE FROM character_anime WHERE character_id=1');
  if (changed === 'soulbind') f.db.exec("INSERT INTO character_protection_locks(guild_id,character_id,lock_type,protected_until) VALUES('1',1,'soulbound',NULL)");
  if (changed === 'no reward') f.db.exec('DELETE FROM character_anime WHERE character_id=4');
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], changed === 'cancel' ? 'cancel' : 'confirm')));
  assert.equal(getItemAction(f.db, action.id).state, 'canceled');
  assert.equal(getInventory(f.db, '1', '101').length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n, 3);
});

test('Blood Pact rolls back sacrifices and item cost when summoning fails', async (t) => {
  const f = fixture(t);
  const sacrifices = pactPool(f);
  const action = await launch(f, 'blood_pact');
  updateItemSelection(f.db, action.id, '1', '101', { sacrifices });
  f.db.exec(`CREATE TRIGGER reject_pact_summon BEFORE INSERT ON marriages WHEN NEW.character_id=4
    BEGIN SELECT RAISE(ABORT,'test summon failure'); END;`);
  assert.throws(() => activateItemAction(f.db, { actionId: action.id, guildId: '1', actorId: '101' }), /test summon failure/);
  assert.equal(getItemAction(f.db, action.id).state, 'confirming');
  assert.equal(getInventory(f.db, '1', '101').length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n, 3);
});

test('Blood Pact preserves selections across pages and supports clearing a page', async (t) => {
  const f = fixture(t);
  for (let id = 1; id <= 26; id++) marry(f, id, '101');
  const action = await launch(f, 'blood_pact');
  const choose = async (values) => onItemActionInteraction(f.db, f.click(control(f.sent[0], 'sacrifices'), f.sent[0], '101', values));
  await choose(menus(f.sent[0])[0].options.slice(0, 2).map((o) => o.value));
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'next')));
  await choose([menus(f.sent[0])[0].options[0].value]);
  assert.equal(getItemAction(f.db, action.id).selections.sacrifices.length, 3);
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'prev')));
  assert.equal(menus(f.sent[0])[0].options.filter((o) => o.default).length, 2);
  await choose([]);
  assert.equal(getItemAction(f.db, action.id).selections.sacrifices.length, 1);
});

test('Grand Masquerade use prompt explains rank constraint and lasts 180 seconds', async (t) => {
  const f = fixture(t);
  const action = await launch(f, 'grand_masquerade');
  assert.equal(action.expires_at - action.created_at, 180_000);
  const text = JSON.stringify(components(f.sent[0]));
  assert.match(text, /Rank constraint/);
  assert.match(text, /0\.4×/);
  assert.match(text, /rounded up/);
  assert.match(text, /no upper limit/);
  assert.match(text, /top 100, any top-100 target/);
  const other = await launch(f, 'severed_fate');
  assert.equal(other.expires_at - other.created_at, 60_000);
});

test('Kaimetsu warns about all harems and confirms without character selection', async (t) => {
  const f = fixture(t);
  marry(f, 1, '101'); marry(f, 2, '101');
  marry(f, 3, '202'); marry(f, 4, '202');
  const action = await launch(f, 'kaimetsu');
  assert.equal(menus(f.sent[0]).length, 0);
  const text = JSON.stringify(components(f.sent[0]));
  assert.match(text, /including your own/);
  assert.match(text, /Only soulbound characters are immune/);
  assert.deepEqual(f.sent[0].payload.allowedMentions.parse, []);
  const confirm = control(f.sent[0], 'confirm');
  await onItemActionInteraction(f.db, f.click(confirm, f.sent[0], '202'));
  assert.equal(getItemAction(f.db, action.id).state, 'confirming');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n, 4);
  await onItemActionInteraction(f.db, f.click(confirm));
  assert.equal(getItemAction(f.db, action.id).state, 'resolved');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n, 2);
  assert.equal(getInventory(f.db, '1', '101').length, 0);
  await onItemActionInteraction(f.db, f.click(confirm));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n, 2);
});

test('Kaimetsu cancellation leaves the item and ownership intact', async (t) => {
  const f = fixture(t);
  marry(f, 1, '101'); marry(f, 2, '101');
  const action = await launch(f, 'kaimetsu');
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'cancel')));
  assert.equal(getItemAction(f.db, action.id).state, 'canceled');
  assert.equal(getInventory(f.db, '1', '101').length, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM marriages').get().n, 2);
});

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


test('Alchemist controls honor the snapshotted configured material cost', async (t) => {
  const f = fixture(t);
  const saveCost = (cost) => saveConfigSection(f.db, { guildId: '1', section: 'itemActions', values: { 'itemActions.alchemistCost': cost }, expectedRevision: getConfigView(f.db).revision });
  saveCost(2);
  const source = f.grant('alchemist');
  const costs = [f.grant('hourglass_of_haste'), f.grant('hourglass_of_haste')];
  const action = await startItemAction({ db: f.db, message: f.message, inventoryId: source });
  assert.equal(menus(f.sent[0])[0].max_values, 2);
  saveCost(3);
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'costs'), f.sent[0], '101', costs.map(String)));
  await onItemActionInteraction(f.db, f.click(control(f.sent[0], 'confirm')));
  assert.equal(getItemAction(f.db, action.id).state, 'resolved');
  assert.equal(getInventory(f.db, '1', '101').length, 1);
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
