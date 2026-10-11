import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { openCatalog } from '../lib/catalogDb.js';
import { getGuildPrefix, setGuildPrefix } from '../lib/guildPrefix.js';
import { execute as prefixCommand } from '../commands/utility/prefix.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'game-prefix-'));
  const db = openCatalog(join(directory, 'bot.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return db;
}

test('guild prefix persists and leaves other guilds on default', (t) => {
  const db = fixture(t);
  assert.equal(getGuildPrefix(db, '1', 'w!'), 'w!');
  setGuildPrefix(db, '1', '!');
  assert.equal(getGuildPrefix(db, '1', 'w!'), '!');
  assert.equal(getGuildPrefix(db, '2', 'w!'), 'w!');
  assert.throws(() => setGuildPrefix(db, '1', 'a b'), /Invalid prefix/);
});

test('prefix command requires Manage Server and saves new prefix', async (t) => {
  const db = fixture(t);
  const replies = [];
  const interaction = {
    guildId: '1',
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    options: { getString: () => '!' },
    reply: async (value) => { replies.push(value); },
  };
  await prefixCommand({ catalogDb: db }, interaction);
  assert.equal(getGuildPrefix(db, '1', 'w!'), '!');
  assert.match(replies[0].content, /!/);
  interaction.memberPermissions.has = () => false;
  interaction.options.getString = () => '?';
  await prefixCommand({ catalogDb: db }, interaction);
  assert.equal(getGuildPrefix(db, '1', 'w!'), '!');
});
