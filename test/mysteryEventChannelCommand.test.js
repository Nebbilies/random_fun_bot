import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { openCatalog } from '../lib/catalogDb.js';
import { getMysteryEventChannel, setMysteryEventChannel } from '../lib/mysteryCoordinator.js';
import { data, execute } from '../commands/utility/mystery-event-channel.js';

function fixture(t, channel = null, botCanPost = true, admin = true) {
  const directory = mkdtempSync(join(tmpdir(), 'mystery-setting-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const replies = [];
  const interaction = {
    guildId: '1',
    guild: { members: { fetchMe: async () => ({ id: 'bot' }) } },
    memberPermissions: { has: (permission) => admin && permission === PermissionFlagsBits.Administrator },
    options: { getChannel: () => channel && {
      id: channel.id, guildId: channel.guildId ?? '1', type: channel.type ?? ChannelType.GuildText,
      permissionsFor: () => ({ has: () => botCanPost }), toString: () => `<#${channel.id}>`,
    } },
    reply: async (message) => { replies.push(message); },
  };
  return { db, interaction, replies };
}

test('channel setting is Administrator-only and allows clearing to roll-channel fallback', async (t) => {
  const { db, interaction, replies } = fixture(t, null, true, false);
  assert.equal(data.toJSON().default_member_permissions, String(PermissionFlagsBits.Administrator));
  setMysteryEventChannel(db, '1', '20');
  await execute({ catalogDb: db }, interaction);
  assert.equal(getMysteryEventChannel(db, '1', '10'), '20');
  assert.match(replies[0].content, /Administrator/);
  interaction.memberPermissions.has = () => true;
  await execute({ catalogDb: db }, interaction);
  assert.equal(getMysteryEventChannel(db, '1', '10'), '10');
});

test('setting a usable text channel persists it for the guild', async (t) => {
  const { db, interaction, replies } = fixture(t, { id: '30' });
  await execute({ catalogDb: db }, interaction);
  assert.equal(getMysteryEventChannel(db, '1', '10'), '30');
  assert.match(replies[0].content, /<#30>/);
});

test('channel setting rejects unusable bot permissions and other guilds', async (t) => {
  const { db, interaction, replies } = fixture(t, { id: '30' }, false);
  await execute({ catalogDb: db }, interaction);
  assert.equal(getMysteryEventChannel(db, '1', '10'), '10');
  assert.match(replies[0].content, /Attach Files/);
  interaction.options.getChannel = () => ({ id: '40', guildId: '2', type: ChannelType.GuildText });
  await execute({ catalogDb: db }, interaction);
  assert.equal(getMysteryEventChannel(db, '1', '10'), '10');
  assert.match(replies[1].content, /this server/);
});
