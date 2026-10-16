import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ComponentType, MessageFlags } from 'discord.js';
import { openCatalog, setMeta } from '../lib/catalogDb.js';
import { runFranchiseCommand } from '../commands/utils/franchiseCommand.js';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'franchise-command-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  setMeta(db, 'published_at', 'snapshot-1');
  setMeta(db, 'franchise_source_published_at', 'snapshot-1');
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES
    (1, 1, 900, 'Kirito'), (2, 2, 800, 'Asuna')`).run();
  db.prepare(`INSERT INTO franchises (id, display_name, created_at) VALUES
    (10, 'Sword Art Online', 'now'), (20, 'Sword Art Online Alternative', 'now')`).run();
  db.prepare(`INSERT INTO franchise_aliases (franchise_id, alias, normalized_alias, source) VALUES
    (10, 'SAO', 'sao', 'manual'), (20, 'SAO', 'sao', 'manual')`).run();
  db.prepare(`INSERT INTO anime (id, title_english, format, popularity, cover_image, fetched_at) VALUES
    (100, 'Sword Art Online', 'TV', 100, 'https://example.com/sao.jpg', 'now'),
    (101, 'Sword Art Online Special', 'SPECIAL', 200, 'https://example.com/special.jpg', 'now'),
    (200, 'Sword Art Online Alternative: Gun Gale Online', 'TV', 50, NULL, 'now')`).run();
  db.prepare(`INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (10, 100), (10, 101), (20, 200)`).run();
  db.prepare(`INSERT INTO character_anime (character_id, anime_id) VALUES (1, 100), (2, 100)`).run();
  db.prepare(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at)
    VALUES ('1', 2, 'owner', 'now')`).run();
  return db;
}

test('!ima shows franchise characters by name without rank metadata', async (t) => {
  const db = setup(t);
  let payload;
  await runFranchiseCommand({
    args: ['ima', 'Sword', 'Art', 'Online'], prefix: '!', showRank: false,
    message: { guildId: '1', reply: async (value) => { payload = value; return {}; } },
    yoshiko: { catalogDb: db },
  });

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  const container = payload.components[0].toJSON();
  assert.equal(container.type, ComponentType.Container);
  assert.equal(container.components[0].type, ComponentType.Section);
  const coverUrl = new URL(container.components[0].accessory.media.url);
  assert.equal(coverUrl.hostname, 'wsrv.nl');
  assert.equal(coverUrl.searchParams.get('url'), 'https://example.com/sao.jpg');
  assert.equal(coverUrl.searchParams.get('fit'), 'contain');
  assert.equal(coverUrl.searchParams.get('w'), coverUrl.searchParams.get('h'));
  const content = container.components[0].components[0].content;
  assert.match(content, /Kirito/);
  assert.match(content, /💞 Asuna/);
  assert.doesNotMatch(content, /💞 Kirito/);
  assert.doesNotMatch(content, /#1|#2/);
});

test('!imar lets the player choose between matching franchises and displays character ranks', async (t) => {
  const db = setup(t);
  const collector = new EventEmitter();
  let payload;
  const sent = {
    edit: async (value) => { payload = value; },
    createMessageComponentCollector: () => collector,
  };
  await runFranchiseCommand({
    args: ['imar', 'SAO'], prefix: '!', showRank: true,
    message: { guildId: '1', author: { id: 'owner' }, reply: async (value) => { payload = value; return sent; } },
    yoshiko: { catalogDb: db },
  });
  assert.match(payload.components[0].toJSON().components[0].content, /Choose a franchise/);

  const interaction = {
    customId: 'franchise:choose', values: ['10'], user: { id: 'owner' },
    deferUpdate: async () => {},
  };
  await collector.listeners('collect')[0](interaction);
  const section = payload.components[0].toJSON().components[0];
  assert.equal(new URL(section.accessory.media.url).searchParams.get('url'), 'https://example.com/sao.jpg');
  const result = section.components[0].content;
  assert.match(result, /#1 - Kirito/);
  assert.match(result, /#2 - 💞 Asuna/);
});

test('franchise character pages show at most 15 names', async (t) => {
  const db = setup(t);
  const addCharacter = db.prepare('INSERT INTO characters (id, rank, favourites, name_full) VALUES (?, ?, 1, ?)');
  const addAppearance = db.prepare('INSERT INTO character_anime (character_id, anime_id) VALUES (?, 100)');
  for (let rank = 3; rank <= 16; rank++) {
    addCharacter.run(rank, rank, `Character ${rank}`);
    addAppearance.run(rank);
  }
  const collector = new EventEmitter();
  let payload;
  const sent = {
    edit: async (value) => { payload = value; },
    createMessageComponentCollector: () => collector,
  };
  await runFranchiseCommand({
    args: ['imar', 'Sword', 'Art', 'Online'], prefix: '!', showRank: true,
    message: { guildId: '1', author: { id: 'owner' }, reply: async (value) => { payload = value; return sent; } },
    yoshiko: { catalogDb: db },
  });
  let content = payload.components[0].toJSON().components[0].components[0].content;
  assert.match(content, /Page 1 of 2/);
  assert.match(content, /#15 - Character 15/);
  assert.doesNotMatch(content, /#16 - Character 16/);

  await collector.listeners('collect')[0]({
    customId: 'franchise:characters:next', user: { id: 'owner' }, deferUpdate: async () => {},
  });
  content = payload.components[0].toJSON().components[0].components[0].content;
  assert.match(content, /Page 2 of 2/);
  assert.match(content, /#16 - Character 16/);
  assert.doesNotMatch(content, /#15 - Character 15/);
});
