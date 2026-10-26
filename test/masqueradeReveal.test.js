import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { publishMasqueradeReveal } from '../lib/masqueradeReveal.js';

function fixture(t) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  const targets = [1, 2, 3, 4].map((id) => {
    db.prepare('INSERT INTO characters(id,rank,favourites,name_full) VALUES(?,?,10,?)').run(id, id, `Character ${id}`);
    return { characterId: id, ownerId: String(id), rank: id, name: `Character ${id}` };
  });
  const action = { actor_id: '1', message_id: 'header', selections: {}, result: { targets, assignment: [1, 0, 3, 2] } };
  const events = [];
  const serialize = (payload) => JSON.stringify(payload.components.map((c) => c.toJSON()));
  const channel = { send: async (payload) => { events.push(serialize(payload)); return { id: 'header' }; } };
  const message = { id: 'header', edit: async (payload) => events.push(serialize(payload)) };
  const wait = async (ms) => { assert.equal(ms, 3000); events.push('wait'); };
  const saveProgress = (step) => { action.selections._ui = { masqueradeRevealStep: step }; };
  return { db, action, channel, message, events, wait, saveProgress };
}

test('Masquerade reveals header and each recipient in order with a pause between every message', async (t) => {
  const f = fixture(t);
  await publishMasqueradeReveal(f);
  assert.equal(f.events.length, 17);
  assert.match(f.events[0], /# <@1> has used Grand Masquerade! 🎭/);
  for (let i = 1; i < f.events.length; i += 2) assert.equal(f.events[i], 'wait');
  for (let i = 0; i < 4; i++) {
    assert.match(f.events[2 + i * 4], new RegExp(`❓ <@${i + 1}> has received`));
    assert.match(f.events[4 + i * 4], new RegExp(`Character ${[2, 1, 4, 3][i]}`));
    assert.match(f.events[4 + i * 4], new RegExp(`Married by <@${i + 1}>`));
  }
  assert.equal(f.action.selections._ui.masqueradeRevealStep, 9);
});

test('Masquerade delivery resumes after a failed card without repeating header or teaser', async (t) => {
  const f = fixture(t);
  const send = f.channel.send;
  let count = 0;
  f.channel.send = async (payload) => { if (++count === 3) throw Error('offline'); return send(payload); };
  await assert.rejects(publishMasqueradeReveal(f), /offline/);
  assert.equal(f.action.selections._ui.masqueradeRevealStep, 2);
  f.events.length = 0;
  f.channel.send = send;
  await publishMasqueradeReveal(f);
  assert.equal(f.events[0], 'wait');
  assert.match(f.events[1], /Character 2/);
  assert.ok(!f.events.some((event) => event.includes('has used Grand Masquerade')));
  assert.equal(f.action.selections._ui.masqueradeRevealStep, 9);
});
