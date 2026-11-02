import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ComponentType, MessageFlags } from 'discord.js';
import { openCatalog } from '../lib/catalogDb.js';
import { topCharacters, topPageCount } from '../lib/topCharacters.js';
import { run as topCommand } from '../commands/top.js';
import { run as topoCommand } from '../commands/topo.js';
import { parseTopCommand } from '../lib/topModifiers.js';

test('top suffixes support gender and owners in either order, rejecting conflicting or unknown flags', () => {
  assert.deepEqual(parseTopCommand('top'), { showOwner: false, gender: null });
  assert.deepEqual(parseTopCommand('topo'), { showOwner: true, gender: null });
  for (const command of ['topw', 'topww', 'TOPW']) {
    assert.deepEqual(parseTopCommand(command), { showOwner: false, gender: 'female' });
  }
  for (const command of ['topwo', 'topow', 'topowwo']) {
    assert.deepEqual(parseTopCommand(command), { showOwner: true, gender: 'female' });
  }
  for (const command of ['topho', 'topoh']) {
    assert.deepEqual(parseTopCommand(command), { showOwner: true, gender: 'male' });
  }
  for (const command of ['topwh', 'tophw', 'topowh', 'topx', 'top w', 'stoph']) {
    assert.equal(parseTopCommand(command), null);
  }
});

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'top-command-'));
  const db = openCatalog(join(directory, 'bot.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return db;
}

function seed(db, count) {
  const insert = db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, anime_titles)
    VALUES (?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  for (let index = 1; index <= count; index += 1) {
    insert.run(index, index, 1000 - index, `Character ${index}`, JSON.stringify([`Anime ${index}`]));
  }
  db.exec('COMMIT');
}

function collectorFixture() {
  const collector = new EventEmitter();
  const state = { payload: null, edits: 0 };
  const sent = {
    edit: async (value) => { state.payload = value; state.edits += 1; },
    createMessageComponentCollector: () => collector,
  };
  return { collector, sent, state };
}

function container(payload) {
  const card = payload.components[0].toJSON();
  assert.equal(card.type, ComponentType.Container);
  return card;
}

test('the top list shows the highest ranked characters, 15 per page', async (t) => {
  const db = fixture(t);
  seed(db, 20);
  const harness = collectorFixture();
  const ctx = {
    args: ['top'], prefix: '!',
    message: {
      author: { id: 'owner' }, guildId: '1',
      reply: async (value) => { harness.state.payload = value; return harness.sent; },
    },
    yoshiko: { catalogDb: db },
  };

  await topCommand(ctx);

  assert.equal(harness.state.payload.flags, MessageFlags.IsComponentsV2);
  const card = container(harness.state.payload);
  assert.match(card.components[0].content, /:trophy: TOP 1000/);
  const rows = card.components[1].content.split('\n');
  assert.equal(rows.length, 15);
  assert.equal(rows[0], '**#1 - Character 1** - Anime 1');
  assert.equal(rows[14], '**#15 - Character 15** - Anime 15');
  assert.match(card.components[2].content, /Page 1 of 2/);
  assert.equal(card.components[3].components[0].custom_id, 'top:prev');
  assert.equal(card.components[3].components[0].disabled, true);
  assert.equal(card.components[3].components[1].custom_id, 'top:next');
  assert.equal(card.components[3].components[1].disabled, false);
});

test('the top list pages through the catalog with the navigation buttons', async (t) => {
  const db = fixture(t);
  seed(db, 20);
  const harness = collectorFixture();
  const ctx = {
    args: ['top'], prefix: '!',
    message: {
      author: { id: 'owner' }, guildId: '1',
      reply: async (value) => { harness.state.payload = value; return harness.sent; },
    },
    yoshiko: { catalogDb: db },
  };

  await topCommand(ctx);

  const collect = async (customId) => {
    const interaction = { customId, user: { id: 'owner' }, deferUpdate: async () => {} };
    await harness.collector.listeners('collect')[0](interaction);
  };

  await collect('top:next');
  let card = container(harness.state.payload);
  const rows = card.components[1].content.split('\n');
  assert.equal(rows.length, 5);
  assert.equal(rows[0], '**#16 - Character 16** - Anime 16');
  assert.equal(rows[4], '**#20 - Character 20** - Anime 20');
  assert.match(card.components[2].content, /Page 2 of 2/);
  assert.equal(card.components[3].components[1].disabled, true);

  await collect('top:prev');
  card = container(harness.state.payload);
  assert.equal(card.components[1].content.split('\n')[0], '**#1 - Character 1** - Anime 1');
  assert.match(card.components[2].content, /Page 1 of 2/);

  harness.collector.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  card = container(harness.state.payload);
  assert.equal(card.components[3].components[0].disabled, true);
  assert.equal(card.components[3].components[1].disabled, true);
});

test('the top list can open a requested page', async (t) => {
  const db = fixture(t);
  seed(db, 40);
  const harness = collectorFixture();
  const ctx = {
    args: ['top', '3'], prefix: '!',
    message: {
      author: { id: 'owner' }, guildId: '1',
      reply: async (value) => { harness.state.payload = value; return harness.sent; },
    },
    yoshiko: { catalogDb: db },
  };

  await topCommand(ctx);

  const card = container(harness.state.payload);
  assert.equal(card.components[1].content.split('\n')[0], '**#31 - Character 31** - Anime 31');
  assert.match(card.components[2].content, /Page 3 of 3/);
});

test('the top list never covers more than the top 1000 characters', async (t) => {
  const db = fixture(t);
  seed(db, 1005);
  const rows = topCharacters(db);
  assert.equal(rows.length, 1000);
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[999].rank, 1000);
  assert.equal(topPageCount(rows), 67);
});


test('topo displays server-local owners without pinging and refreshes them on navigation', async (t) => {
  const db = fixture(t);
  seed(db, 20);
  db.exec(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at) VALUES
    ('1', 1, '123', 'now'), ('2', 2, '456', 'now')`);
  const harness = collectorFixture();
  await topoCommand({ args: ['topo'], message: { guildId: '1',
    reply: async (value) => { harness.state.payload = value; return harness.sent; } },
    yoshiko: { catalogDb: db } });
  const text = container(harness.state.payload).components[1].content;
  assert.match(text, /Character 1 💞\*\* - Anime 1 => <@123>/);
  assert.doesNotMatch(text, /<@456>/);
  assert.deepEqual(harness.state.payload.allowedMentions, { parse: [], repliedUser: false });
  db.exec(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at) VALUES ('1', 16, '789', 'now')`);
  await harness.collector.listeners('collect')[0]({ customId: 'top:next', deferUpdate: async () => {} });
  assert.match(container(harness.state.payload).components[1].content, /Character 16 💞\*\* - Anime 16 => <@789>/);
});

test('top markers use current server ownership and refresh on navigation', async (t) => {
  const db = fixture(t);
  seed(db, 20);
  db.exec(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at) VALUES
    ('1', 1, 'another-player', 'now'), ('2', 2, 'owner', 'now')`);
  const harness = collectorFixture();
  await topCommand({ args: ['top'], message: { guildId: '1',
    reply: async (value) => { harness.state.payload = value; return harness.sent; } },
    yoshiko: { catalogDb: db } });
  let text = container(harness.state.payload).components[1].content;
  assert.match(text, /Character 1 💞/);
  assert.doesNotMatch(text, /Character 2 💞/);
  db.exec(`DELETE FROM marriages WHERE guild_id = '1';
    INSERT INTO marriages (guild_id, character_id, owner_id, married_at)
    VALUES ('1', 16, 'other', 'now')`);
  const collect = harness.collector.listeners('collect')[0];
  await collect({ customId: 'top:next', deferUpdate: async () => {} });
  text = container(harness.state.payload).components[1].content;
  assert.match(text, /Character 16 💞/);
  await collect({ customId: 'top:prev', deferUpdate: async () => {} });
  assert.doesNotMatch(container(harness.state.payload).components[1].content, /💞/);
});


test('gender pools include other and unknown genders with normalized matching', (t) => {
  const db = fixture(t);
  seed(db, 8);
  const genders = ['Female', 'Male', 'Non-binary', null, '', ' female ', ' MALE ', 'Other'];
  const update = db.prepare('UPDATE characters SET gender = ? WHERE id = ?');
  genders.forEach((gender, index) => update.run(gender, index + 1));
  assert.deepEqual(topCharacters(db, 1000, 'female').map((row) => row.id), [1, 3, 4, 5, 6, 8]);
  assert.deepEqual(topCharacters(db, 1000, 'male').map((row) => row.id), [2, 3, 4, 5, 7, 8]);
  assert.equal(topCharacters(db).length, 8);
});

test('gender filtering happens before the 1000-entry limit, retaining global ranks', (t) => {
  const db = fixture(t);
  seed(db, 2100);
  db.exec("UPDATE characters SET gender = CASE WHEN id % 2 = 0 THEN 'Female' ELSE 'Male' END");
  for (const gender of ['female', 'male']) {
    const rows = topCharacters(db, 1000, gender);
    assert.equal(rows.length, 1000);
    assert.equal(rows[999].rank, gender === 'female' ? 2000 : 1999);
    assert.equal(topPageCount(rows), 67);
  }
});

test('filtered owner lists retain gender and owners through paging and expiration', async (t) => {
  const db = fixture(t);
  seed(db, 40);
  db.exec("UPDATE characters SET gender = CASE WHEN id % 2 = 0 THEN 'Female' ELSE 'Male' END");
  db.exec("INSERT INTO marriages (guild_id, character_id, owner_id, married_at) VALUES ('1', 32, '123', 'now')");
  for (const command of ['topwo', 'topow', 'topho', 'topoh']) {
    const harness = collectorFixture();
    await topCommand({ args: [command, '999'], message: { guildId: '1',
      reply: async (value) => { harness.state.payload = value; return harness.sent; } },
      yoshiko: { catalogDb: db } });
    let card = container(harness.state.payload);
    const female = command.includes('w');
    assert.match(card.components[0].content, female ? /Female \/ Other/ : /Male \/ Other/);
    assert.match(card.components[2].content, /Page 2 of 2 • Entries 16–20/);
    assert.match(card.components[1].content, female ? /#32 - Character 32/ : /#31 - Character 31/);
    if (female) assert.match(card.components[1].content, /<@123>/);
    assert.deepEqual(harness.state.payload.allowedMentions, { parse: [], repliedUser: false });
    await harness.collector.listeners('collect')[0]({ customId: 'top:prev', deferUpdate: async () => {} });
    card = container(harness.state.payload);
    assert.match(card.components[2].content, /Page 1 of 2/);
    assert.match(card.components[1].content, female ? /#2 - Character 2/ : /#1 - Character 1/);
    harness.collector.emit('end');
    await new Promise((resolve) => setImmediate(resolve));
    card = container(harness.state.payload);
    assert.equal(card.components[3].components[1].disabled, true);
  }
});

test('empty filtered lists explain the filter and disable navigation', async (t) => {
  const db = fixture(t);
  seed(db, 2);
  db.exec("UPDATE characters SET gender = 'Male'");
  let payload;
  await topCommand({ args: ['topw'], message: { guildId: '1', reply: async (value) => { payload = value; } },
    yoshiko: { catalogDb: db } });
  const card = container(payload);
  assert.equal(card.components[1].content, 'No characters match this gender filter.');
  assert.equal(card.components[2].content, 'Page 1 of 1');
  assert.ok(card.components[3].components.every((button) => button.disabled));
});
