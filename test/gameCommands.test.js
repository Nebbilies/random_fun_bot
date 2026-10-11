import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, saveDecision } from '../lib/catalogDb.js';
import { loadCharacterIndex } from '../lib/gameCharacterLookup.js';
import { run as characterCommand } from '../commands/char.js';

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
    VALUES (1, 1, 999, 'Satoru Gojou', '五条悟', '["Satoru Gojo"]', '["JUJUTSU KAISEN"]',
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
  const embed = reply.embeds[0].toJSON();
  assert.equal(embed.title, 'Satoru Gojou');
  assert.match(embed.description, /JUJUTSU KAISEN/);
  assert.match(embed.description, /\*\*Other names:\*\*\n• 五条悟\n• Satoru Gojo/);
  assert.match(embed.description, /\*\*Rank:\*\* #1/);
  assert.match(embed.description, /\*\*Favorites:\*\* 999/);
  assert.doesNotMatch(embed.description, /Gender|Birthday|Age|Description/);
  assert.equal(embed.image.url, 'https://cdn.donmai.us/image.jpg');
  assert.equal(reply.allowedMentions.parse.length, 0);
});
