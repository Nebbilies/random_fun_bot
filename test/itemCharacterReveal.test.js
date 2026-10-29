import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { characterRevealPlan, publishItemCharacterReveal } from '../lib/itemCharacterReveal.js';

function fixture(t, kind = 'chaos_exchange') {
  const db = openCatalog(':memory:'); t.after(() => db.close());
  db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,10,20,'Secret Reward')");
  const action = { kind, state: 'resolved', actor_id: '101', selections: {},
    result: { character: { id: 1 }, message: 'Received Secret Reward.' } };
  const events = [];
  const message = { id: '10', edit: async (data) => { events.push(JSON.stringify(data)); } };
  const channel = { send: async (data) => { events.push(JSON.stringify(data)); return message; } };
  const saveProgress = (step) => { action.selections._ui = { characterRevealStep: step }; };
  const wait = async (ms) => { assert.equal(ms, 3000); events.push('wait'); };
  return { db, action, events, message, channel, saveProgress, wait };
}
for (const kind of ['chaos_exchange', 'pickpockets_hook', 'wish_upon_a_star']) test(`${kind} hides identity until final card`, async (t) => {
  const f = fixture(t, kind);
  await publishItemCharacterReveal(f);
  assert.equal(f.events.length, 5);
  assert.ok(!f.events[0].includes('Secret Reward'));
  assert.equal(f.events[1], 'wait');
  assert.ok(!f.events[2].includes('Secret Reward'));
  assert.equal(f.events[3], 'wait');
  assert.match(f.events[4], /Secret Reward/);
  assert.equal(f.action.selections._ui.characterRevealStep, 3);
});
test('failed final card resumes without rerolling or repeating teaser', async (t) => {
  const f = fixture(t);
  const edit = f.message.edit;
  f.message.edit = async (data) => { if (JSON.stringify(data).includes('Secret Reward')) throw Error('offline'); return edit(data); };
  await assert.rejects(publishItemCharacterReveal(f), /offline/);
  assert.equal(f.action.selections._ui.characterRevealStep, 2);
  f.events.length = 0; f.message.edit = edit;
  await publishItemCharacterReveal(f);
  assert.equal(f.events.length, 2);
  assert.match(f.events[1], /Secret Reward/);
});
test('deleted completed reveal restores final card without suspense', async (t) => {
  const f = fixture(t); f.message = null;
  f.action.selections._ui = { characterRevealStep: 3 };
  await publishItemCharacterReveal(f);
  assert.equal(f.events.length, 1);
  assert.match(f.events[0], /Secret Reward/);
});
test('Siren and deterministic activations have no staged reveal', () => {
  for (const kind of ['sirens_call', 'blood_pact', 'master_key', 'heart_for_a_heart', 'severed_fate', 'counterfeit_crown']) {
    assert.equal(characterRevealPlan({ kind, state: 'resolved', result: { character: { id: 1 } } }), null);
  }
});
