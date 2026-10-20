import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { openCatalog, saveDecision } from '../lib/catalogDb.js';
import { loadCharacterIndex } from '../lib/gameCharacterLookup.js';
import { run as characterCommand } from '../commands/char.js';
import { run as imCommand } from '../commands/im.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'game-command-'));
  const db = openCatalog(join(directory, 'bot.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return db;
}

test('character command shows catalog metadata and approved image', async (t) => {
  const db = fixture(t);
  db.prepare(`INSERT INTO characters
    (id, rank, favourites, name_full, name_native, name_alternatives, anime_titles, image_url, site_url)
    VALUES (1, 1234, 999, 'Satoru Gojou', '五条悟', '["Satoru Gojo"]', '["JUJUTSU KAISEN"]',
    'https://anilist.co/portrait.jpg', 'https://anilist.co/character/1')`).run();
  saveDecision(db, 1, 'approve', 'gojou_satoru');
  let reply;
  const ctx = {
    args: ['char', 'Satoru', 'Gojo'], prefix: '!',
    message: { guildId: '1', reply: async (value) => { reply = value; } },
    yoshiko: {
      catalogDb: db, characterIndex: loadCharacterIndex(db),
      imagePicker: { pick: async (_guild, _id, tag) => {
        assert.equal(tag, 'gojou_satoru');
        return { url: 'https://cdn.donmai.us/image.jpg', source: 'danbooru', postId: 9 };
      } },
    },
  };
  await characterCommand(ctx);
  const card = reply.components[0].toJSON();
  assert.equal(reply.flags, MessageFlags.IsComponentsV2);
  assert.equal(card.type, ComponentType.Container);
  assert.match(card.components[0].content, /Satoru Gojou/);
  assert.match(card.components[1].content, /JUJUTSU KAISEN/);
  assert.match(card.components[1].content, /\*\*Other names:\*\*\n• 五条悟\n• Satoru Gojo/);
  assert.match(card.components[1].content, /\*\*Rank:\*\* #1,234/);
  assert.match(card.components[1].content, /\*\*Favorites:\*\* 999/);
  assert.doesNotMatch(card.components[1].content, /Gender|Birthday|Age|Description/);
  assert.equal(card.components[2].items[0].media.url, 'https://cdn.donmai.us/image.jpg');
  assert.match(card.components[3].content, /safebooru.donmai.us\/posts\/9/);
  assert.equal(reply.allowedMentions.parse.length, 0);
});

test('ambiguous lookup pages through matches, selects a character, and returns to the same page', async () => {
  const characters = Array.from({ length: 27 }, (_, index) => ({
    id: index + 1, rank: index + 1, favourites: 100 - index,
    name_full: `Sora ${index + 1}`, name_native: null, name_alternatives: '[]',
    anime_titles: `["Anime ${index + 1}"]`, image_url: null, site_url: null,
  }));
  characters[26].rank = 1234;
  const collector = new EventEmitter();
  let resets = 0;
  collector.resetTimer = () => { resets++; };
  let payload;
  let edits = 0;
  const sent = {
    edit: async (value) => { payload = value; edits++; },
    createMessageComponentCollector: () => collector,
  };
  const ctx = {
    args: ['char', 'Sora'], prefix: '!',
    message: { author: { id: 'owner' }, guildId: '1', reply: async (value) => { payload = value; return sent; } },
    yoshiko: {
      characterIndex: characters,
      catalogDb: { prepare: () => ({ get: () => null }) },
      imagePicker: { pick: async () => ({ url: null, source: 'none', poolSize: 0 }) },
    },
  };
  await characterCommand(ctx);
  const act = (id, user = 'owner', values) => ({
    customId: id, user: { id: user }, values,
    deferUpdate: async () => {},
  });
  const collect = async (interaction) => collector.listeners('collect')[0](interaction);
  const chooser = () => payload.components[0].toJSON();
  assert.equal(chooser().components[1].components[0].options.length, 25);
  assert.match(chooser().components[0].content, /Page 1 of 2/);

  let modal;
  const jump = { ...act('char:page:jump'), id: 'interaction-1' };
  jump.showModal = async (value) => { modal = value; };
  jump.awaitModalSubmit = async () => ({
    fields: { getTextInputValue: () => '2' },
    deferUpdate: async () => {},
  });
  await collect(jump);
  assert.equal(modal.toJSON().custom_id, 'char:jump:interaction-1');
  assert.match(chooser().components[0].content, /Page 2 of 2/);
  assert.equal(chooser().components[1].components[0].options.length, 2);
  assert.equal(chooser().components[1].components[0].options[0].label, '#26 • Sora 26 (Anime 26)');
  assert.equal(chooser().components[1].components[0].options[1].label, '#1,234 • Sora 27 (Anime 27)');

  await collect(act('char:page:prev'));
  assert.match(chooser().components[0].content, /Page 1 of 2/);
  await collect(act('char:page:next'));
  assert.match(chooser().components[0].content, /Page 2 of 2/);

  await collect(act('char:choose', 'someone-else', ['26']));
  assert.equal(edits, 3);
  await collect(act('char:choose', 'owner', ['26']));
  assert.match(payload.components[0].toJSON().components[0].content, /Sora 26/);
  assert.equal(resets, 1);

  await collect(act('char:back'));
  assert.match(chooser().components[0].content, /Page 2 of 2/);
  assert.equal(resets, 2);
  collector.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chooser().components[1].components[0].disabled, true);
});

test('rank lookup uses the V2 card and shared image navigation', async () => {
  const collector = new EventEmitter();
  let payload;
  const sent = {
    edit: async (value) => { payload = value; },
    createMessageComponentCollector: () => collector,
  };
  const character = {
    id: 7, rank: 7, favourites: 500, name_full: 'Rem', name_native: null,
    name_alternatives: '[]', anime_titles: '["Re:ZERO"]', image_url: null, site_url: null,
  };
  let imageNumber = 0;
  await characterCommand({
    args: ['char', '#7'], prefix: '!',
    message: { author: { id: 'owner' }, guildId: '1', reply: async (value) => { payload = value; return sent; } },
    yoshiko: {
      characterIndex: [character],
      catalogDb: { prepare: () => ({ get: () => ({ tag_name: 'rem' }) }) },
      imagePicker: { pick: async () => ({
        url: `https://cdn.donmai.us/${++imageNumber}.jpg`, source: 'danbooru',
        postId: imageNumber, poolSize: 2,
      }) },
    },
  });
  const card = () => payload.components[0].toJSON();
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  assert.equal(card().components[2].items[0].media.url, 'https://cdn.donmai.us/1.jpg');
  const imageButtons = card().components.at(-1).components;
  assert.deepEqual(imageButtons.slice(1).map((button) => button.emoji.name), ['⬅️', '➡️']);
  assert.deepEqual(imageButtons.slice(1).map((button) => button.style), [ButtonStyle.Primary, ButtonStyle.Success]);
  assert.equal(imageButtons[0].disabled, false);
  assert.equal(imageButtons[1].disabled, true);
  assert.equal(imageButtons[2].disabled, false);
  const collect = async (id) => collector.listeners('collect')[0]({
    customId: id, user: { id: 'other-user' }, deferUpdate: async () => {},
  });
  await collect('char:image:next');
  assert.equal(card().components[2].items[0].media.url, 'https://cdn.donmai.us/2.jpg');
  await collect('char:image:prev');
  assert.equal(card().components[2].items[0].media.url, 'https://cdn.donmai.us/1.jpg');
  collector.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(card().components.at(-1).components[2].disabled, true);
});

test('every character card lets viewers privately report a tag once', async (t) => {
  const db = fixture(t);
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (8, 1, 1, 'No Tag')`).run();
  const collector = new EventEmitter();
  let payload;
  const sent = {
    edit: async (value) => { payload = value; },
    createMessageComponentCollector: () => collector,
  };
  await characterCommand({
    args: ['char', '#1'], prefix: '!',
    message: { author: { id: 'owner' }, guildId: '1', reply: async (value) => { payload = value; return sent; } },
    yoshiko: {
      characterIndex: loadCharacterIndex(db), catalogDb: db,
      imagePicker: { pick: async () => ({ url: null, source: 'none', poolSize: 0 }) },
    },
  });
  const controls = () => payload.components[0].toJSON().components.at(-1).components;
  assert.equal(controls()[0].custom_id, 'char:report');
  const confirmations = [];
  const report = async (user) => collector.listeners('collect')[0]({
    customId: 'char:report', user: { id: user },
    reply: async (value) => { confirmations.push(value); },
  });
  await report('viewer');
  await report('viewer');
  await report('another-viewer');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_tag_reports WHERE resolved_at IS NULL').get().n, 2);
  assert.match(confirmations[0].content, /saved/);
  assert.match(confirmations[1].content, /already reported/);
  assert.equal(confirmations[0].flags, MessageFlags.Ephemeral);
  collector.emit('end');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controls()[0].disabled, true);
});

test('im command acts as an exact alias for char command and formats usage appropriately', async (t) => {
  let replyUsage;
  await imCommand({
    args: ['im'],
    prefix: '!',
    message: { reply: async (msg) => { replyUsage = msg; } },
  });
  assert.equal(replyUsage, 'Usage: !im <name or #rank>');

  let replyChar;
  await characterCommand({
    args: ['char'],
    prefix: '$',
    message: { reply: async (msg) => { replyChar = msg; } },
  });
  assert.equal(replyChar, 'Usage: $char <name or #rank>');

  const db = fixture(t);
  db.prepare(`INSERT INTO characters
    (id, rank, favourites, name_full, name_native, name_alternatives, anime_titles, image_url, site_url)
    VALUES (1, 10, 500, 'Rem', null, '[]', '["Re:Zero"]', 'https://example.com/rem.jpg', null)`).run();
  let replyResult;
  await imCommand({
    args: ['im', 'Rem'],
    prefix: '!',
    message: { guildId: '1', reply: async (value) => { replyResult = value; } },
    yoshiko: {
      catalogDb: db,
      characterIndex: loadCharacterIndex(db),
      imagePicker: { pick: async () => ({ url: 'https://example.com/rem.jpg', source: 'anilist' }) },
    },
  });
  const card = replyResult.components[0].toJSON();
  assert.match(card.components[0].content, /Rem/);
});
