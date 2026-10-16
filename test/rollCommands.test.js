import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { getRoll } from '../lib/characterRolls.js';
import { onRollReaction, onRollReport, rollCard, runRoll } from '../lib/characterRollRuntime.js';
import { run as mu } from '../commands/mu.js';
import { run as ru } from '../commands/ru.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'roll-command-'));
  const db = openCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec("INSERT INTO characters (id,rank,favourites,name_full,gender,image_url,anime_titles) VALUES (1,1,100,'A <@999>','Female','https://example.com/a.png','[\"A Show\"]'),(2,2,90,'B','Male','https://example.com/b.png','[\"B Show\"]')");
  const sent = [];
  const reacted = [];
  const channel = { send: async (value) => { sent.push(value); } };
  const card = { id: '500', channel, react: async (emoji) => { reacted.push(emoji); } };
  const message = { id: '100', guildId: '1', channelId: '10', author: { id: '101' }, channel,
    reply: async (value) => { sent.push(value); return card; } };
  const yoshiko = { catalogDb: db, imagePicker: { pick: async () => ({ url: 'https://example.com/a.png' }) } };
  return { db, sent, reacted, channel, card, message, yoshiko };
}

test('card shows anime under the name and keeps one report button', () => {
  const card = rollCard({ name_full: 'A', anime_titles: '["A Show"]', rank: 1234, favourites: 1234 }, { url: 'https://example.com/a.png' }, 6);
  const content = JSON.stringify(card.components.map((component) => component.toJSON()));
  assert.match(content, /A Show/);
  assert.ok(content.indexOf('A Show') > content.indexOf('# A'));
  assert.ok(content.indexOf('A Show') < content.indexOf('**Rank:** #1,234'));
  assert.match(content, /\*\*Rank:\*\* #1,234/);
  assert.match(content, /\*\*Likes:\*\* 1,234/);
  assert.match(content, /Report tag/);
  assert.match(content, /6 rolls left/);
  assert.doesNotMatch(content, /Other names:|Image source|Next|Previous/);
  assert.equal((content.match(/Report tag/g) || []).length, 1);
  const unknown = rollCard({ name_full: 'B', anime_titles: null, rank: 13, favourites: 0 }, null, 1);
  assert.match(JSON.stringify(unknown.components.map((component) => component.toJSON())), /Unknown anime/);
  assert.match(JSON.stringify(unknown.components.map((component) => component.toJSON())), /1 roll left/);
});

test('roll publishes before reacting; heart claims immediately and report stays usable', async (t) => {
  const x = fixture(t);
  await runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w');
  assert.match(JSON.stringify(x.sent[0].components.map((component) => component.toJSON())), /A Show/);
  assert.match(JSON.stringify(x.sent[0].components.map((component) => component.toJSON())), /6 rolls left/);
  assert.deepEqual(x.reacted, ['❤️']);
  assert.equal(getRoll(x.db, '1', '10', '500').state, 'open');
  const reaction = { emoji: { name: '❤️' }, message: { id: '500', guildId: '1', channelId: '10', channel: x.channel } };
  await onRollReaction(x.yoshiko, reaction, { id: '102', bot: false });
  assert.equal(x.db.prepare("SELECT owner_id FROM marriages WHERE character_id = 1").get()?.owner_id, '102');
  assert.equal(x.sent.at(-1).content, '<@102> has married A <@999> 🎉');
  assert.deepEqual(x.sent.at(-1).allowedMentions.users, ['102']);
  const replies = [];
  const interaction = { isButton: () => true, customId: 'roll:report', guildId: '1', channelId: '10',
    message: { id: '500' }, user: { id: '103' }, reply: async (value) => { replies.push(value); } };
  assert.equal(await onRollReport(x.db, interaction), true);
  assert.match(replies[0].content, /saved/);
});

test('failed heart closes card but consumes roll', async (t) => {
  const x = fixture(t);
  x.card.react = async () => { throw new Error('Missing permissions'); };
  const previous = console.error;
  console.error = () => {};
  try { await runRoll({ message: x.message, yoshiko: x.yoshiko }, 'w'); }
  finally { console.error = previous; }
  assert.equal(getRoll(x.db, '1', '10', '500').state, 'failed');
  assert.equal(x.db.prepare("SELECT used FROM roll_allowances WHERE guild_id = '1' AND user_id = '101'").get()?.used, 1);
});

test('mu and ru show available and exhausted allowances with reset countdowns', async (t) => {
  const x = fixture(t);
  const now = Date.parse('2026-10-15T17:30:00Z');
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    await mu({ message: x.message, yoshiko: x.yoshiko });
    await ru({ message: x.message, yoshiko: x.yoshiko });
    assert.equal(x.sent[0], 'You can claim right now! The next claim reset is in **2h 30 min**.');
    assert.equal(x.sent[1], 'You have 7 rolls left. Next rolls reset in **30 min**.');
    x.db.prepare('INSERT INTO claim_allowances (guild_id,user_id,period) VALUES (?,?,?)')
      .run('1', '101', Math.floor((now + 7 * 3_600_000) / (3 * 3_600_000)));
    x.db.prepare('INSERT INTO roll_allowances (guild_id,user_id,period,used) VALUES (?,?,?,?)')
      .run('1', '101', Math.floor(now / 3_600_000), 5);
    await mu({ message: x.message, yoshiko: x.yoshiko });
    await ru({ message: x.message, yoshiko: x.yoshiko });
    assert.equal(x.sent[2], "You can't claim right now. The next claim reset is in **2h 30 min**.");
    assert.equal(x.sent[3], 'You have 2 rolls left. Next rolls reset in **30 min**.');
  } finally {
    Date.now = originalNow;
  }
});
