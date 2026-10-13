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
  db.prepare(`INSERT INTO anime (id, title_english, fetched_at) VALUES
    (100, 'Sword Art Online', 'now'), (200, 'Sword Art Online Alternative: Gun Gale Online', 'now')`).run();
  db.prepare(`INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (10, 100), (20, 200)`).run();
  db.prepare(`INSERT INTO character_anime (character_id, anime_id) VALUES (1, 100), (2, 100)`).run();
  return db;
}

test('!ima shows franchise characters by name without rank metadata', async (t) => {
  const db = setup(t);
  let payload;
  await runFranchiseCommand({
    args: ['ima', 'Sword', 'Art', 'Online'], prefix: '!', showRank: false,
    message: { reply: async (value) => { payload = value; return {}; } },
    yoshiko: { catalogDb: db },
  });

  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  const container = payload.components[0].toJSON();
  assert.equal(container.type, ComponentType.Container);
  assert.match(container.components[0].content, /Kirito/);
  assert.match(container.components[0].content, /Asuna/);
  assert.doesNotMatch(container.components[0].content, /#1|#2/);
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
    message: { author: { id: 'owner' }, reply: async (value) => { payload = value; return sent; } },
    yoshiko: { catalogDb: db },
  });
  assert.match(payload.components[0].toJSON().components[0].content, /Choose a franchise/);

  const interaction = {
    customId: 'franchise:choose', values: ['10'], user: { id: 'owner' },
    deferUpdate: async () => {},
  };
  await collector.listeners('collect')[0](interaction);
  const result = payload.components[0].toJSON().components[0].content;
  assert.match(result, /#1 - Kirito/);
  assert.match(result, /#2 - Asuna/);
});
