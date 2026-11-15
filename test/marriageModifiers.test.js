import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { escapeMarkdown } from 'discord.js';
import { haremListComponents } from '../lib/haremView.js';
import { marryCharacter } from '../lib/characterMarriage.js';
import { parseMarriageCommand, run as mmCommand } from '../commands/mm.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'marriage-mod-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

  db.prepare(`INSERT INTO anime (id, title_romaji, title_english, fetched_at) VALUES
    (101, 'Bleach Romaji', 'BLEACH', '2026-01-01'),
    (102, 'Berserk Romaji', 'Berserk', '2026-01-01'),
    (103, 'Another Romaji', 'Another', '2026-01-01')`).run();

  db.prepare(`INSERT INTO franchises (id, display_name, created_at) VALUES
    (1, 'BLEACH', '2026-01-01'),
    (2, 'Berserk', '2026-01-01'),
    (3, 'Another', '2026-01-01')`).run();

  db.prepare(`INSERT INTO franchise_anime (franchise_id, anime_id) VALUES
    (1, 101),
    (2, 102),
    (3, 103)`).run();

  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, anime_titles, site_url, image_url) VALUES
    (1, 253, 500, 'Rangiku Matsumoto', '["BLEACH"]', 'https://anilist.co/character/1', 'https://example.com/rangiku.png'),
    (2, 247, 600, 'Casca', '["Berserk"]', 'https://anilist.co/character/2', 'https://example.com/casca.png'),
    (3, 351, 300, 'Mei Misaki', '["Another"]', 'https://anilist.co/character/3', 'https://example.com/mei.png'),
    (4, 9999, 10, 'Wanderer', '[]', NULL, 'https://example.com/wanderer.png')`).run();

  db.prepare(`INSERT INTO character_anime (character_id, anime_id) VALUES
    (1, 101),
    (2, 102),
    (3, 103)`).run();

  return db;
}

function context(db, args, { authorId = '101' } = {}) {
  const collector = Object.assign(new EventEmitter(), { stop: () => {} });
  collector.stop = () => collector.emit('end');
  let payload;
  const sent = {
    edit: async (value) => { payload = value; },
    createMessageComponentCollector: () => collector,
  };
  const ctx = {
    args, prefix: '!', yoshiko: { catalogDb: db },
    message: {
      guildId: '1', author: { id: authorId },
      member: { permissions: { has: () => false } },
      reply: async (value) => { payload = value; return sent; },
    },
  };
  return { ctx, collector, payload: () => payload };
}

function textContent(payload) {
  return payload.components?.[0]?.toJSON().components
    .flatMap((component) => component.components ?? [component])
    .filter((component) => typeof component.content === 'string')
    .map((component) => component.content).join('\n') ?? String(payload);
}

test('parseMarriageCommand correctly extracts flags and enforces precedence', () => {
  assert.deepEqual(parseMarriageCommand('mm'), {
    valid: true, base: 'mm', flags: { rank: false, franchise: false, individual: false },
    view: 'list', sort: 'time',
  });
  assert.deepEqual(parseMarriageCommand('mymarry'), {
    valid: true, base: 'mymarry', flags: { rank: false, franchise: false, individual: false },
    view: 'list', sort: 'time',
  });
  assert.deepEqual(parseMarriageCommand('mmr'), {
    valid: true, base: 'mm', flags: { rank: true, franchise: false, individual: false },
    view: 'list', sort: 'rank',
  });
  assert.deepEqual(parseMarriageCommand('mma'), {
    valid: true, base: 'mm', flags: { rank: false, franchise: true, individual: false },
    view: 'franchise', sort: 'time',
  });
  assert.deepEqual(parseMarriageCommand('mmar'), {
    valid: true, base: 'mm', flags: { rank: true, franchise: true, individual: false },
    view: 'franchise', sort: 'rank',
  });
  assert.deepEqual(parseMarriageCommand('mmra'), {
    valid: true, base: 'mm', flags: { rank: true, franchise: true, individual: false },
    view: 'franchise', sort: 'rank',
  });
  assert.deepEqual(parseMarriageCommand('mmi'), {
    valid: true, base: 'mm', flags: { rank: false, franchise: false, individual: true },
    view: 'individual', sort: 'time',
  });
  assert.deepEqual(parseMarriageCommand('mmir'), {
    valid: true, base: 'mm', flags: { rank: true, franchise: false, individual: true },
    view: 'individual', sort: 'rank',
  });
  assert.deepEqual(parseMarriageCommand('mmri'), {
    valid: true, base: 'mm', flags: { rank: true, franchise: false, individual: true },
    view: 'individual', sort: 'rank',
  });
  // 'i' takes precedence over 'a'
  assert.deepEqual(parseMarriageCommand('mmai'), {
    valid: true, base: 'mm', flags: { rank: false, franchise: true, individual: true },
    view: 'individual', sort: 'time',
  });
  assert.deepEqual(parseMarriageCommand('mmia'), {
    valid: true, base: 'mm', flags: { rank: false, franchise: true, individual: true },
    view: 'individual', sort: 'time',
  });
  assert.deepEqual(parseMarriageCommand('mmair'), {
    valid: true, base: 'mm', flags: { rank: true, franchise: true, individual: true },
    view: 'individual', sort: 'rank',
  });
  // Invalid modifier flag
  assert.deepEqual(parseMarriageCommand('mmx'), {
    valid: false, invalidChar: 'x', base: 'mm',
  });
  // Non-matching command
  assert.equal(parseMarriageCommand('char'), null);
});

test('franchise view (!mma) lists franchises alphabetically without rank and groups unfranchised under Other', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 1, '101'); // BLEACH
  marryCharacter(db, '1', 2, '101'); // Berserk
  marryCharacter(db, '1', 3, '101'); // Another
  marryCharacter(db, '1', 4, '101'); // Unfranchised (Other)

  const mock = context(db, ['mma']);
  await mmCommand(mock.ctx);
  const text = textContent(mock.payload());

  // Alphabetical order: Another, Berserk, BLEACH, Other
  const anotherIdx = text.indexOf('**Another - 1**');
  const berserkIdx = text.indexOf('**Berserk - 1**');
  const bleachIdx = text.indexOf('**BLEACH - 1**');
  const otherIdx = text.indexOf('**Other - 1**');

  assert.ok(anotherIdx !== -1, 'Another should be present');
  assert.ok(berserkIdx !== -1, 'Berserk should be present');
  assert.ok(bleachIdx !== -1, 'BLEACH should be present');
  assert.ok(otherIdx !== -1, 'Other should be present');

  assert.ok(anotherIdx < berserkIdx, 'Another precedes Berserk');
  assert.ok(berserkIdx < bleachIdx, 'Berserk precedes BLEACH');
  assert.ok(bleachIdx < otherIdx, 'BLEACH precedes Other');

  // Without 'r', no rank format '#253'
  assert.ok(!text.includes('#253'), 'Should not display rank in mma without r');
  assert.ok(text.includes('Rangiku Matsumoto'));
  assert.ok(text.includes('Casca'));
  assert.ok(text.includes('Mei Misaki'));
  assert.ok(text.includes('Wanderer'));
});

test('franchise rank view (!mmar) shows bold rank and sorts characters within franchise by rank', async (t) => {
  const db = fixture(t);
  // Add another BLEACH character
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES
    (5, 10, 800, 'Ichigo Kurosaki')`).run();
  db.prepare(`INSERT INTO character_anime (character_id, anime_id) VALUES (5, 101)`).run();

  marryCharacter(db, '1', 1, '101'); // Rangiku (rank 253)
  marryCharacter(db, '1', 5, '101'); // Ichigo (rank 10)

  const mock = context(db, ['mmar']);
  await mmCommand(mock.ctx);
  const text = textContent(mock.payload());

  assert.ok(text.includes('**BLEACH - 2**'));
  // Should format rank as **#<rank>**
  assert.ok(text.includes('**#10** - Ichigo Kurosaki'));
  assert.ok(text.includes('**#253** - Rangiku Matsumoto'));

  // Ichigo (rank 10) should precede Rangiku (rank 253)
  assert.ok(text.indexOf('Ichigo Kurosaki') < text.indexOf('Rangiku Matsumoto'));
});

test('individual card view (!mmi) displays single character card with header, details, footer and buttons', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 1, '101');
  marryCharacter(db, '1', 2, '101');
  db.prepare("UPDATE marriages SET married_at = '2026-01-01T00:00:00.000Z' WHERE character_id = 1").run();
  db.prepare("UPDATE marriages SET married_at = '2026-01-02T00:00:00.000Z' WHERE character_id = 2").run();

  const mock = context(db, ['mmi']);
  await mmCommand(mock.ctx);
  const text = textContent(mock.payload());

  // mmi defaults to time sort (newest married first: Casca married on 2026-01-02)
  assert.ok(text.includes('# [Casca](https://anilist.co/character/2)'));
  assert.ok(!text.includes('💞'));
  assert.ok(text.includes('**Anime:** Berserk'));
  assert.ok(text.includes('**Rank:** #247'));
  assert.doesNotMatch(text, /Favorites|600/);
  assert.ok(text.includes("<@101>'s harem • Character 1 of 2"));

  // Check buttons
  const buttons = mock.payload().components[0].toJSON().components
    .find((c) => c.components?.some((b) => b.custom_id === 'mm:prev' || b.custom_id === 'mm:next'))?.components;
  assert.ok(buttons, 'Action row with buttons exists');
  const prevBtn = buttons.find((b) => b.custom_id === 'mm:prev');
  const nextBtn = buttons.find((b) => b.custom_id === 'mm:next');
  assert.equal(prevBtn.disabled, true, 'Previous disabled on first item');
  assert.equal(nextBtn.disabled, false, 'Next enabled on first item');

  // Navigate to next character
  await mock.collector.listeners('collect')[0]({
    customId: 'mm:next', user: { id: '101' }, guildId: '1', deferUpdate: async () => {},
  });
  const page2Text = textContent(mock.payload());
  assert.ok(page2Text.includes('# [Rangiku Matsumoto](https://anilist.co/character/1)'));
  assert.ok(page2Text.includes("<@101>'s harem • Character 2 of 2"));

  // Navigate back to previous character
  await mock.collector.listeners('collect')[0]({
    customId: 'mm:prev', user: { id: '101' }, guildId: '1', deferUpdate: async () => {},
  });
  const page1Text = textContent(mock.payload());
  assert.ok(page1Text.includes('Casca'));
  assert.ok(page1Text.includes("<@101>'s harem • Character 1 of 2"));
});

test('individual rank view (!mmir) sorts character cards by rank', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 1, '101'); // Rangiku (rank 253)
  marryCharacter(db, '1', 2, '101'); // Casca (rank 247)

  const mock = context(db, ['mmir']);
  await mmCommand(mock.ctx);
  const text = textContent(mock.payload());

  // Casca has rank 247, which is lower than Rangiku (253), so Casca appears first
  assert.ok(text.includes('Casca'));
  assert.ok(text.includes("<@101>'s harem • Character 1 of 2"));
});

test('combining a and i (!mmai) runs individual card view', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 1, '101');

  const mock = context(db, ['mmai']);
  await mmCommand(mock.ctx);
  const text = textContent(mock.payload());

  // Should render individual card view
  assert.ok(text.includes('# [Rangiku Matsumoto](https://anilist.co/character/1)'));
  assert.ok(text.includes("<@101>'s harem • Character 1 of 1"));
});

test('harem renderer escapes names without mutating marriage rows', () => {
  const rows = [
    { characterId: 1, name_full: '*Owned*', rank: 1 },
    { characterId: 2, name_full: '_Released_', rank: 2, married: false },
    { characterId: 3, name_full: '`Taken`', rank: 3, married: true },
  ];
  const before = structuredClone(rows);
  const rendered = textContent({ components: haremListComponents(rows, '101') });
  assert.ok(rendered.includes(escapeMarkdown('*Owned*')));
  assert.ok(rendered.includes(escapeMarkdown('_Released_')));
  assert.ok(rendered.includes(escapeMarkdown('`Taken`')));
  assert.ok(!rendered.includes('💞'));
  assert.deepEqual(rows, before);
});

test('grouped franchise view escapes character names', async (t) => {
  const db = fixture(t);
  db.prepare('UPDATE characters SET name_full = ? WHERE id = 1').run('*Rangiku*');
  marryCharacter(db, '1', 1, '101');
  const mock = context(db, ['mma']);
  await mmCommand(mock.ctx);
  assert.ok(textContent(mock.payload()).includes(escapeMarkdown('*Rangiku*')));
});

test('invalid modifier rejects with clear error', async (t) => {
  const db = fixture(t);
  const mock = context(db, ['mmx']);
  await mmCommand(mock.ctx);
  assert.match(String(mock.payload()), /Unknown modifier "x"/);
});
