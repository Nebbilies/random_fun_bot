import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ComponentType, MessageFlags } from 'discord.js';
import { openCatalog, setMeta } from '../lib/catalogDb.js';
import { runFranchiseCommand } from '../commands/utils/franchiseCommand.js';
import { run as runIma } from '../commands/ima.js';
import { parseFranchiseCommand } from '../lib/franchiseModifiers.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { initializeCatalogReleaseSchema } from '../lib/catalogReleaseSchema.js';
import { previewManualCharacterCreation, confirmManualCharacterCreation } from '../lib/manualCharacterMutations.js';
import { isFranchiseCatalogCurrent } from '../lib/franchiseLookup.js';

function staleManualCatalog(t) {
  const db = setup(t);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  initializeCatalogReleaseSchema(db);
  db.exec(`INSERT INTO franchises (id, display_name, name_source, created_at, curated_cover_url)
    VALUES (30, 'Zenless Zone Zero', 'manual', 'now', 'https://example.com/zzz.jpg');
    INSERT INTO franchise_aliases (franchise_id, alias, normalized_alias, source) VALUES
    (30, 'ZZZ', 'zzz', 'manual'), (30, 'Stale Alias', 'stale alias', 'automatic');
    INSERT INTO franchise_anime (franchise_id, anime_id) VALUES (30, 100);`);
  const ids = [];
  for (const name of ['Anby', 'Billy', 'Nicole']) {
    const preview = previewManualCharacterCreation(db, {
      account: 'editor', role: 'moderator', rank: ids.length + 1, now: 1000,
      input: { name, aliases: [], gender: 'unknown', franchiseIds: [30],
        portraitUrl: 'https://example.com/portrait.jpg' },
    });
    const result = confirmManualCharacterCreation(db, {
      account: 'editor', role: 'moderator', previewId: preview.previewId,
      payloadHash: preview.payloadHash, idempotencyKey: name, now: 1001,
    });
    ids.push(result.characterId);
  }
  setMeta(db, 'franchise_source_token', 'source:999');
  assert.ok(db.prepare("SELECT 1 FROM character_sources WHERE source = 'anilist'").get());
  assert.equal(isFranchiseCatalogCurrent(db), false);
  return { db, ids };
}

async function command(db, query, options = {}) {
  const collector = new EventEmitter();
  let payload;
  const sent = { edit: async value => { payload = value; }, createMessageComponentCollector: () => collector };
  await runIma({
    args: [options.command ?? 'imar', query], prefix: '!',
    message: { guildId: '1', author: { id: 'viewer' }, reply: async value => { payload = value; return sent; } },
    yoshiko: { catalogDb: db },
  });
  return { get payload() { return payload; }, collector };
}

function text(payload) {
  if (typeof payload === 'string') return payload;
  const component = payload.components[0].toJSON().components[0];
  return component.content ?? component.components[0].content;
}

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

test('identity migration preserves fresh legacy franchise lookups for !ima and !imar', async (t) => {
  const db = setup(t);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 12 });
  for (const name of ['ima', 'imar']) {
    const result = await command(db, 'Sword Art Online', { command: name });
    assert.match(text(result.payload), /Kirito/);
    assert.doesNotMatch(text(result.payload), /out of date|refresh/i);
    assert.equal(text(result.payload).includes('#1 - Kirito'), name === 'imar');
  }
});

test('manual character publication preserves migrated anime franchise freshness', async (t) => {
  const db = setup(t);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 12 });
  const preview = previewManualCharacterCreation(db, {
    account: 'editor', role: 'moderator', rank: 1, now: 1000,
    input: { name: 'Manual Character', aliases: [], gender: 'unknown', franchiseIds: [10],
      portraitUrl: 'https://example.com/portrait.jpg' },
  });
  confirmManualCharacterCreation(db, {
    account: 'editor', role: 'moderator', previewId: preview.previewId,
    payloadHash: preview.payloadHash, idempotencyKey: 'manual-freshness', now: 1001,
  });
  const content = text((await command(db, 'Sword Art Online')).payload);
  assert.match(content, /Kirito/);
  assert.match(content, /Manual Character/);
  assert.doesNotMatch(content, /Partial results|out of date/);
});

test('migrated legacy freshness fallback rejects stale, missing and changed-source coverage', async (t) => {
  const db = setup(t);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 12 });
  const reject = async () => {
    assert.equal(isFranchiseCatalogCurrent(db), false);
    assert.match(text((await command(db, 'Sword Art Online')).payload), /out of date.*no direct.*refresh/i);
  };
  setMeta(db, 'franchise_source_published_at', 'older');
  await reject();
  db.prepare("DELETE FROM catalog_meta WHERE key = 'franchise_source_published_at'").run();
  await reject();
  setMeta(db, 'franchise_source_published_at', 'snapshot-1');
  setMeta(db, 'franchise_source_token', 'source:999');
  await reject();
  db.prepare("DELETE FROM catalog_meta WHERE key = 'franchise_source_token'").run();
  db.exec('UPDATE catalog_state SET source_revision = 1 WHERE singleton = 1');
  await reject();
});

test('stale source still exposes three confirmed manual ZZZ characters, ranks, owners and curated cover', async (t) => {
  const { db, ids } = staleManualCatalog(t);
  db.prepare(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at)
    VALUES ('1', ?, 'zzz-owner', 'now')`).run(ids[0]);
  const result = await command(db, 'ZZZ', { command: 'imaro' });
  const content = text(result.payload);
  assert.match(content, /3 characters/);
  assert.match(content, /#1 - Anby 💞 => <@zzz-owner>/);
  assert.match(content, /#2 - Billy/);
  assert.match(content, /#3 - Nicole/);
  assert.match(content, /Partial results.*direct.*out of date/i);
  assert.doesNotMatch(content, /Kirito|Asuna/);
  assert.equal(result.payload.components[0].toJSON().components[0].accessory.media.url, 'https://example.com/zzz.jpg');
  assert.deepEqual(result.payload.allowedMentions, { parse: [] });
  await result.collector.listeners('end')[0]();
  assert.match(text(result.payload), /Partial results/);
});

test('stale lookup hides derived-only franchises, automatic aliases and member anime titles', async (t) => {
  const { db } = staleManualCatalog(t);
  for (const query of ['Sword Art Online', 'Stale Alias', 'Sword Art Online Special', 'missing']) {
    const result = await command(db, query);
    assert.match(text(result.payload), /out of date.*no direct.*refresh/i);
  }
  db.exec("UPDATE franchises SET name_source = 'automatic', display_name = 'Stale Generated Name' WHERE id = 30");
  assert.match(text((await command(db, 'Stale Generated Name')).payload), /out of date.*no direct/i);
  const result = await command(db, 'ZZZ');
  assert.match(text(result.payload), /ZZZ/);
  assert.doesNotMatch(text(result.payload), /Stale Generated Name/);
  db.exec('UPDATE franchises SET curated_cover_url = NULL WHERE id = 30');
  assert.equal((await command(db, 'ZZZ')).payload.components[0].toJSON().components[0].type, ComponentType.TextDisplay);
});

test('fresh mixed membership deduplicates and restores anime search, members and cover', async (t) => {
  const { db, ids } = staleManualCatalog(t);
  db.prepare('INSERT INTO character_anime (character_id, anime_id) VALUES (?, 100)').run(ids[0]);
  assert.match(text((await command(db, 'ZZZ')).payload), /3 characters/);
  setMeta(db, 'franchise_source_token', 'source:0');
  assert.equal(isFranchiseCatalogCurrent(db), true);
  const result = await command(db, 'Stale Alias');
  assert.match(text(result.payload), /5 characters/);
  assert.match(text(result.payload), /Kirito/);
  assert.equal((text(result.payload).match(/Anby/g) ?? []).length, 1);
  assert.doesNotMatch(text(result.payload), /Partial results/);
  assert.equal(result.payload.components[0].toJSON().components[0].accessory.media.url, 'https://example.com/sao.jpg');
});

test('stale direct chooser keeps paging, requester controls and warning after selection', async (t) => {
  const { db, ids } = staleManualCatalog(t);
  for (let id = 40; id < 66; id++) {
    db.prepare(`INSERT INTO franchises (id, display_name, name_source, created_at)
      VALUES (?, ?, 'manual', 'now')`).run(id, `Direct Group ${id}`);
    db.prepare('INSERT INTO character_franchise_memberships (character_id, franchise_id) VALUES (?, ?)').run(ids[0], id);
  }
  const result = await command(db, 'Direct Group');
  assert.match(text(result.payload), /26 matches • Page 1 of 2/);
  assert.match(text(result.payload), /Partial results/);
  const collect = result.collector.listeners('collect')[0];
  let rejection;
  await collect({ customId: 'franchise:franchise:next', user: { id: 'other' }, reply: async value => { rejection = value; } });
  assert.equal(rejection.flags, MessageFlags.Ephemeral);
  assert.match(text(result.payload), /Page 1 of 2/);
  await collect({ customId: 'franchise:franchise:next', user: { id: 'viewer' }, deferUpdate: async () => {} });
  assert.match(text(result.payload), /Page 2 of 2/);
  const menu = result.payload.components[0].toJSON().components[1].components[0];
  assert.equal(menu.options.length, 1);
  await collect({ customId: 'franchise:choose', values: ['65'], user: { id: 'viewer' }, deferUpdate: async () => {} });
  assert.match(text(result.payload), /Direct Group 65/);
  assert.match(text(result.payload), /1 characters/);
  assert.match(text(result.payload), /#1 - Anby/);
  assert.match(text(result.payload), /Partial results/);
});

test('stale release catalog without direct memberships retains refresh protection', async (t) => {
  const db = setup(t);
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  initializeCatalogReleaseSchema(db);
  setMeta(db, 'franchise_source_token', 'source:999');
  assert.equal(isFranchiseCatalogCurrent(db), false);
  assert.match(text((await command(db, 'SAO')).payload), /out of date.*no direct.*refresh/i);
});

test('stale legacy catalog retains refresh guard', async (t) => {
  const db = setup(t);
  setMeta(db, 'franchise_source_published_at', 'older');
  assert.match(text((await command(db, 'SAO')).payload), /out of date.*refresh/i);
});

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
  assert.equal(container.components[0].accessory.media.url, 'https://example.com/sao.jpg');
  const content = container.components[0].components[0].content;
  assert.match(content, /Kirito/);
  assert.match(content, /Asuna 💞/);
  assert.doesNotMatch(content, /Kirito 💞/);
  assert.doesNotMatch(content, /#1|#2|=>|<@/);
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
  assert.equal(section.accessory.media.url, 'https://example.com/sao.jpg');
  const result = section.components[0].content;
  assert.match(result, /#1 - Kirito/);
  assert.match(result, /#2 - Asuna 💞/);
});

test('franchise character pages show at most 15 names', async (t) => {
  const db = setup(t);
  const addCharacter = db.prepare('INSERT INTO characters (id, rank, favourites, name_full) VALUES (?, ?, 1, ?)');
  const addAppearance = db.prepare('INSERT INTO character_anime (character_id, anime_id) VALUES (?, 100)');
  for (let rank = 3; rank <= 16; rank++) {
    addCharacter.run(rank, rank === 16 ? 1234 : rank, `Character ${rank}`);
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

  db.exec(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at)
    VALUES ('1', 16, 'another-owner', 'now'), ('2', 15, 'owner', 'now')`);
  await collector.listeners('collect')[0]({
    customId: 'franchise:characters:next', user: { id: 'owner' }, deferUpdate: async () => {},
  });
  content = payload.components[0].toJSON().components[0].components[0].content;
  assert.match(content, /Page 2 of 2/);
  assert.match(content, /#1,234 - Character 16 💞/);
  assert.doesNotMatch(content, /#15 - Character 15/);
  db.exec(`DELETE FROM marriages WHERE guild_id = '1'`);
  await collector.listeners('collect')[0]({
    customId: 'franchise:characters:prev', user: { id: 'owner' }, deferUpdate: async () => {},
  });
  content = payload.components[0].toJSON().components[0].components[0].content;
  assert.doesNotMatch(content, /💞/);
});


test('franchise flags require a and support order-independent ownership and rank', () => {
  for (const command of ['imao', 'imoa', 'imaoo']) {
    assert.deepEqual(parseFranchiseCommand(command), { showRank: false, showOwner: true });
  }
  for (const command of ['imaro', 'imora', 'imrao', 'imoar']) {
    assert.deepEqual(parseFranchiseCommand(command), { showRank: true, showOwner: true });
  }
  assert.deepEqual(parseFranchiseCommand('ima'), { showRank: false, showOwner: false });
  assert.deepEqual(parseFranchiseCommand('imar'), { showRank: true, showOwner: false });
  for (const command of ['im', 'imo', 'imro', 'charo', 'mmo', 'imax']) {
    assert.equal(parseFranchiseCommand(command), null);
  }
});

test('franchise owner modifier uses current guild and refreshes owners without pinging', async (t) => {
  const db = setup(t);
  db.exec(`INSERT INTO marriages (guild_id, character_id, owner_id, married_at)
    VALUES ('2', 1, 'foreign-owner', 'now'), ('2', 2, 'other-owner', 'now')`);
  for (const command of ['imao', 'imoa', 'imaro', 'imora']) {
    const collector = new EventEmitter();
    let payload;
    const sent = {
      edit: async (value) => { payload = value; },
      createMessageComponentCollector: () => collector,
    };
    db.exec("UPDATE marriages SET owner_id = 'owner' WHERE guild_id = '1'");
    await runIma({
      args: [command, 'Sword Art Online'], prefix: '!',
      message: { guildId: '1', author: { id: 'viewer' }, reply: async (value) => { payload = value; return sent; } },
      yoshiko: { catalogDb: db },
    });
    const content = () => payload.components[0].toJSON().components[0].components[0].content;
    assert.match(content(), /Asuna 💞 => <@owner>/);
    assert.doesNotMatch(content(), /Kirito 💞|foreign-owner|other-owner/);
    assert.equal(content().includes('#2 - Asuna'), command.includes('r'));
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    db.exec("UPDATE marriages SET owner_id = 'new-owner' WHERE guild_id = '1'");
    await collector.listeners('collect')[0]({
      customId: 'franchise:characters:prev', user: { id: 'viewer' }, deferUpdate: async () => {},
    });
    assert.match(content(), /Asuna 💞 => <@new-owner>/);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    db.exec("UPDATE marriages SET guild_id = '3' WHERE guild_id = '1'");
    await collector.listeners('end')[0]();
    assert.doesNotMatch(content(), /💞|=>|<@/);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    db.exec("UPDATE marriages SET guild_id = '1' WHERE guild_id = '3'");
  }
});
