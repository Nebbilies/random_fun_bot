import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createMessageHandler } from '../app/events/messageCreate.js';
import { createInteractionHandler } from '../app/events/interactionCreate.js';

test('game commands bypass landmines and ingress stays closed before readiness', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE guild_prefixes (guild_id TEXT, prefix TEXT)');
  const replies = [];
  let ready = false, landmines = 0;
  const handle = createMessageHandler({ yoshiko: { catalogDb: db, config: { prefix: '?' } },
    isReady: () => ready, handleLandmine: async () => { landmines++; return false; } });
  const message = { content: '?help', guild: { id: '1' }, author: { id: '2', bot: false },
    reply: async payload => replies.push(payload) };
  await handle(message);
  assert.equal(replies.length, 0);
  ready = true;
  await handle(message);
  assert.equal(replies.length, 1);
  assert.equal(landmines, 0);
  message.content = '?unknown';
  await handle(message);
  assert.equal(landmines, 1);
});

test('retired reward controls receive removal notices only after readiness', async () => {
  let ready = false;
  const replies = [];
  const handle = createInteractionHandler({ yoshiko: {}, isReady: () => ready });
  const interaction = { customId: 'rewards:accept:reward', reply: async value => replies.push(value) };
  await handle(interaction);
  assert.equal(replies.length, 0);
  ready = true;
  await handle(interaction);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /inbox has been removed/);
});
