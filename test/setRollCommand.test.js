import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { openCatalog } from '../lib/catalogDb.js';
import { claimDailyRolls, failRoll, getMaxRolls, getRollStatus, reserveRoll, setMaxRolls } from '../lib/characterRolls.js';
import { data, execute } from '../commands/utility/set-roll.js';
import { run as daily } from '../commands/daily.js';
import { run as ru } from '../commands/ru.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'set-roll-'));
  const path = join(directory, 'catalog.sqlite');
  const db = openCatalog(path);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const replies = [];
  const interaction = {
    guildId: '1', guild: {},
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
    options: { getInteger: () => 10 },
    reply: async (message) => { replies.push(message); },
  };
  return { db, path, interaction, replies };
}

test('set-roll registers a guild-only integer option and requires Administrator at runtime', async (t) => {
  const { db, interaction, replies } = fixture(t);
  const command = data.toJSON();
  assert.equal(command.name, 'set-roll');
  assert.equal(command.dm_permission, false);
  assert.equal(command.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.equal(command.options[0].name, 'amount');
  assert.equal(command.options[0].required, true);
  assert.equal(command.options[0].min_value, 1);
  interaction.memberPermissions.has = () => false;
  await execute({ catalogDb: db }, interaction);
  assert.equal(getMaxRolls(db, '1'), 7);
  assert.match(replies.at(-1).content, /Administrator/);
  interaction.memberPermissions.has = () => true;
  interaction.guild = null;
  await execute({ catalogDb: db }, interaction);
  assert.equal(getMaxRolls(db, '1'), 7);
  assert.match(replies.at(-1).content, /Administrator/);
});

test('administrator setting persists, stays server-scoped, and rejects invalid amounts', async (t) => {
  const { db, path, interaction, replies } = fixture(t);
  await execute({ catalogDb: db }, interaction);
  assert.equal(getMaxRolls(db, '1'), 10);
  assert.equal(getMaxRolls(db, '2'), 7);
  assert.match(replies.at(-1).content, /10 rolls per user per hour/);
  assert.equal(replies.at(-1).ephemeral, true);
  const reopened = openCatalog(path);
  try { assert.equal(getMaxRolls(reopened, '1'), 10); }
  finally { reopened.close(); }
  for (const amount of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, null]) {
    interaction.options.getInteger = () => amount;
    await execute({ catalogDb: db }, interaction);
    assert.match(replies.at(-1).content, /positive whole number/);
    assert.equal(getMaxRolls(db, '1'), 10);
    assert.throws(() => setMaxRolls(db, '1', amount), /Invalid roll maximum/);
  }
});

test('changed maximum controls reservations, preserves spending, and resets next hour', (t) => {
  const { db } = fixture(t);
  const now = Date.parse('2026-10-17T12:30:00Z');
  db.exec("INSERT INTO characters (id,rank,favourites,name_full,gender) VALUES (1,1,100,'A','Female')");
  let message = 100;
  const roll = (userId = '101', time = now) => reserveRoll(db, {
    guildId: '1', channelId: '10', commandMessageId: String(message++), userId, pool: 'w', now: time,
  });
  setMaxRolls(db, '1', 2);
  for (let i = 0; i < 2; i++) {
    const result = roll();
    assert.equal(result.status, 'reserved');
    assert.equal(result.remaining, 1 - i);
    failRoll(db, result.rollId);
  }
  assert.equal(roll().status, 'exhausted');
  setMaxRolls(db, '1', 4);
  assert.equal(getRollStatus(db, '1', '101', now).remaining, 2);
  const extra = roll();
  assert.equal(extra.remaining, 1);
  failRoll(db, extra.rollId);
  setMaxRolls(db, '1', 1);
  assert.equal(getRollStatus(db, '1', '101', now).remaining, 0);
  assert.equal(roll().status, 'exhausted');
  assert.equal(getRollStatus(db, '1', '102', now).remaining, 1);
  assert.equal(getRollStatus(db, '1', '101', now + 3_600_000).remaining, 1);
  assert.equal(roll('101', now + 3_600_000).status, 'reserved');
});

test('daily and ru report the configured maximum and daily refills do not stack', async (t) => {
  const { db, replies } = fixture(t);
  setMaxRolls(db, '1', 12);
  const ctx = { yoshiko: { catalogDb: db }, message: { guildId: '1', author: { id: '101' },
    reply: async (message) => { replies.push(message); } } };
  await daily(ctx);
  assert.match(replies.at(-1), /refilled to 12/);
  await ru(ctx);
  assert.match(replies.at(-1), /12 rolls left/);
  assert.equal(claimDailyRolls(db, '1', '101').status, 'claimed');
  assert.equal(getRollStatus(db, '1', '101').remaining, 12);
});

test('opening an existing version 6 catalog adds the roll setting table', (t) => {
  const { db, path } = fixture(t);
  db.exec('DROP TABLE guild_roll_limits');
  const reopened = openCatalog(path);
  try {
    assert.equal(getMaxRolls(reopened, '1'), 7);
    setMaxRolls(reopened, '1', 9);
    assert.equal(getMaxRolls(reopened, '1'), 9);
  } finally { reopened.close(); }
});
