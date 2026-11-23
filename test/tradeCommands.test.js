import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { getMarriage, marryCharacter } from '../lib/characterMarriage.js';
import { isCharacterPendingTransfer } from '../lib/characterAvailability.js';
// Root commands still use the compatibility path; answers use the feature directly.
import { onTradeAnswer } from '../features/trade/tradeRuntime.js';
import { run as trade } from '../commands/trade.js';
import { run as me } from '../commands/me.js';
import { run as give } from '../commands/give.js';
import { run as cancel } from '../commands/cancel.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'trade-commands-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, image_url) VALUES
    (11, 1, 100, 'Eleven', 'https://example.com/eleven.jpg'),
    (12, 2, 90, 'Twelve', 'https://example.com/twelve.jpg'),
    (13, 3, 80, 'Shared', 'https://example.com/shared-a.jpg'),
    (14, 4, 70, 'Shared', 'https://example.com/shared-b.jpg')`).run();
  return db;
}

/**
 * Mirrors discord.js: components are serialized when the message is sent, and
 * the builders reject payloads that break the Components V2 rules.
 */
function serialize(payload) {
  if (Array.isArray(payload?.components)) {
    for (const component of payload.components) {
      if (typeof component?.toJSON === 'function') component.toJSON();
    }
  }
  return payload;
}

function createSentMessage(payload) {
  const collector = Object.assign(new EventEmitter(), { stop: () => {} });
  const message = {
    payload: serialize(payload),
    edits: /** @type {any[]} */ ([]),
    createMessageComponentCollector: () => collector,
    collector,
  };
  message.edit = async (value) => { message.edits.push(serialize(value)); };
  return message;
}

function createChannel() {
  const channel = {
    id: '10',
    sent: /** @type {any[]} */ ([]),
    async send(payload) {
      const message = createSentMessage(payload);
      channel.sent.push(message);
      return message;
    },
  };
  return channel;
}

function createMessage(channel, authorId, { guildId = '1' } = {}) {
  const message = {
    guildId,
    channelId: channel.id,
    author: { id: authorId, bot: false },
    guild: { members: { cache: new Map() } },
    channel,
    replies: /** @type {any[]} */ ([]),
    async reply(payload) {
      const sent = createSentMessage(payload);
      message.replies.push(sent);
      return sent;
    },
  };
  return message;
}

/** Reads the readable text of a reply, a sent message or an edit. */
function text(payload) {
  if (typeof payload === 'string') return payload;
  if (payload?.content) return payload.content;
  const container = payload?.components?.[0]?.toJSON();
  if (!container) return '';
  return (container.components ?? [])
    .flatMap((component) => component.components ?? [component])
    .filter((component) => typeof component.content === 'string')
    .map((component) => component.content)
    .join('\n');
}

/** Types a message into the channel while a transfer is pending. */
async function say(db, channel, authorId, content) {
  const message = createMessage(channel, authorId);
  message.content = content;
  const handled = await onTradeAnswer(db, message);
  return { handled, message };
}

function context(db, channel, authorId, args) {
  return { args, prefix: '!', yoshiko: { catalogDb: db }, message: createMessage(channel, authorId) };
}

test('a two-for-one trade previews and swaps both sides after the initiator confirms', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '101');
  marryCharacter(db, '1', 13, '102');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['trade', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await trade(ctx);

  await say(db, channel, '101', 'Eleven$Twelve');
  assert.match(text(channel.sent[0]?.payload), /wants to trade/);
  assert.ok([11, 12].every(id => isCharacterPendingTransfer(db, '1', id)));
  await say(db, channel, '102', '#3');
  const confirmation = text(channel.sent[1]?.payload);
  for (const name of ['Eleven', 'Twelve', 'Shared']) assert.match(confirmation, new RegExp(name));
  assert.equal((await say(db, channel, '102', 'yes')).handled, false);
  assert.equal((await say(db, channel, '101', 'yes')).handled, true);
  assert.deepEqual([11, 12, 13].map(id => getMarriage(db, '1', id)?.ownerId), ['102', '102', '101']);
  assert.ok([11, 12, 13].every(id => !isCharacterPendingTransfer(db, '1', id)));
});

test('a gift accepts a spaced character list and moves it only after the recipient confirms', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '101');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['give', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await give(ctx);

  await say(db, channel, '101', 'Eleven $ Twelve');
  const confirmation = text(channel.sent[0]?.payload);
  assert.match(confirmation, /Eleven/);
  assert.match(confirmation, /Twelve/);
  assert.equal((await say(db, channel, '101', 'yes')).handled, false);
  assert.equal((await say(db, channel, '102', 'yes')).handled, true);
  assert.equal((await say(db, channel, '102', 'yes')).handled, false);
  assert.deepEqual([11, 12].map(id => getMarriage(db, '1', id)?.ownerId), ['102', '102']);
});

test('batch input rejects empty entries, duplicate aliases, and eleven names, then accepts ten', async (t) => {
  const db = fixture(t);
  db.prepare('UPDATE characters SET name_alternatives = ? WHERE id = 11').run(JSON.stringify(['Alt Eleven']));
  const insert = db.prepare('INSERT INTO characters (id, rank, favourites, name_full) VALUES (?, ?, ?, ?)');
  for (let id = 15; id <= 21; id++) insert.run(id, id - 10, 10, `Character ${id}`);
  for (let id = 11; id <= 21; id++) marryCharacter(db, '1', id, '101');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['give', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await give(ctx);

  const ranks = Array.from({ length: 11 }, (_, index) => `#${index + 1}`);
  const invalidInputs = /** @type {[string, RegExp][]} */ ([
    ['Eleven$$Twelve', /name is missing/],
    ['Eleven $ Alt Eleven', /Eleven.*more than once/],
    ['Eleven $ Totally unknown', /No character matching.*Totally unknown/],
    [ranks.join('$'), /up to 10/],
  ]);
  for (const [input, error] of invalidInputs) {
    await say(db, channel, '101', input);
    assert.match(text(channel.sent.at(-1).payload), error);
    assert.equal(isCharacterPendingTransfer(db, '1', 11), false);
  }
  await say(db, channel, '101', ranks.slice(0, 10).join('$'));
  assert.match(text(channel.sent.at(-1).payload), /#10.*Character 20/);
  assert.equal((await say(db, channel, '102', 'yes')).handled, true);
  assert.equal(getMarriage(db, '1', 20)?.ownerId, '102');
  assert.equal(getMarriage(db, '1', 21)?.ownerId, '101');
});

test('batch gift resolves fuzzy and ambiguous entries in order across picker pages', async (t) => {
  const db = fixture(t);
  const insert = db.prepare('INSERT INTO characters (id, rank, favourites, name_full) VALUES (?, ?, ?, ?)');
  for (let id = 15; id <= 39; id++) insert.run(id, id - 10, 10, 'Shared');
  for (let id = 11; id <= 39; id++) marryCharacter(db, '1', id, '101');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['give', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await give(ctx);
  const click = (customId, values = []) => ({ customId, values, user: { id: '101' }, guildId: '1',
    deferUpdate: async () => {}, reply: async () => {},
  });

  await say(db, channel, '101', 'Elevne $ Shared');
  const fuzzy = channel.sent.at(-1);
  assert.match(text(fuzzy.payload), /Did you mean.*\n.*Elevne/);
  await fuzzy.collector.listeners('collect')[0](click('xfer:choose', ['11']));
  const ambiguous = channel.sent.at(-1);
  assert.match(text(ambiguous.payload), /Shared.*\nPage 1 of 2/);
  await ambiguous.collector.listeners('collect')[0](click('xfer:choose', ['39']));
  assert.equal(channel.sent.at(-1), ambiguous);
  await ambiguous.collector.listeners('collect')[0](click('xfer:pick:next'));
  assert.match(text(ambiguous.edits.at(-1)), /Page 2 of 2/);
  await ambiguous.collector.listeners('collect')[0](click('xfer:choose', ['39']));
  const confirmation = text(channel.sent.at(-1).payload);
  assert.match(confirmation, /Eleven.*\n#29.*Shared/);
  assert.equal((await say(db, channel, '102', 'yes')).handled, true);
  assert.deepEqual([11, 39, 13].map(id => getMarriage(db, '1', id)?.ownerId), ['102', '102', '101']);
});

test('trade shows the harem, both players pick and the swap happens', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['me', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await me(ctx);

  const opening = text(ctx.message.replies[0].payload);
  assert.match(opening, /Trade with <@102>/);
  assert.match(opening, /Eleven/);

  assert.equal((await say(db, channel, '101', 'Eleven')).handled, true);
  const offer = text(channel.sent[0].payload);
  assert.match(offer, /<@101> wants to trade \*\*Eleven\*\*/);
  assert.match(offer, /Twelve/);

  assert.equal((await say(db, channel, '102', 'Twelve')).handled, true);
  const confirmation = text(channel.sent[1].payload);
  assert.match(confirmation, /<@101> trades \*\*Eleven\*\* for \*\*Twelve\*\*/);
  assert.match(confirmation, /<@101>, confirm\?/);
  assert.ok(!confirmation.includes('💞'));

  assert.equal((await say(db, channel, '102', 'yes')).handled, false);
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
  assert.equal((await say(db, channel, '101', 'yes')).handled, true);
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '102');
  assert.equal(getMarriage(db, '1', 12)?.ownerId, '101');
  assert.match(text(channel.sent[1].edits[0]), /traded \*\*Eleven\*\* for \*\*Twelve\*\*/);
});

test('trade is also reachable under the !trade alias', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['trade', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await trade(ctx);
  assert.match(text(ctx.message.replies[0].payload), /Trade with <@102>/);
});

test('the initiator can decline the final trade and nothing moves', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['trade', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await trade(ctx);
  await say(db, channel, '101', 'Eleven');
  await say(db, channel, '102', 'Twelve');
  assert.equal((await say(db, channel, '101', 'no')).handled, true);
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
  assert.equal(getMarriage(db, '1', 12)?.ownerId, '102');
  assert.match(text(channel.sent[1].edits[0]), /declined the trade/);
});

test('gift hands the character over after the recipient confirms', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['give', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await give(ctx);
  assert.match(text(ctx.message.replies[0].payload), /Gift for <@102>/);
  assert.match(text(ctx.message.replies[0].payload), /Eleven/);

  await say(db, channel, '101', 'Eleven');
  const confirmation = text(channel.sent[0].payload);
  assert.match(confirmation, /<@102>: <@101> wants to give you \*\*Eleven\*\*, confirm\?/);

  assert.equal((await say(db, channel, '101', 'y')).handled, false);
  await say(db, channel, '102', 'y');
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '102');
  assert.match(text(channel.sent[0].edits[0]), /gave \*\*Eleven\*\* to <@102>/);
});

test('the confirm buttons accept the trade as well', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['trade', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await trade(ctx);
  await say(db, channel, '101', 'Eleven');
  await say(db, channel, '102', 'Twelve');

  const interaction = {
    customId: 'xfer:confirm', user: { id: '101' }, guildId: '1',
    values: [], deferUpdate: async () => {}, reply: async () => {},
  };
  const rejected = [];
  await channel.sent[1].collector.listeners('collect')[0]({ ...interaction, user: { id: '102' },
    reply: async payload => rejected.push(payload) });
  assert.match(rejected[0].content, /Only <@101>/);
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
  await channel.sent[1].collector.listeners('collect')[0](interaction);
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '102');
  assert.equal(getMarriage(db, '1', 12)?.ownerId, '101');
});

test('an ambiguous name opens a select menu', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 13, '101');
  marryCharacter(db, '1', 14, '101');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['give', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await give(ctx);
  await say(db, channel, '101', 'Shared');

  const picker = channel.sent[0];
  assert.match(text(picker.payload), /Several characters match/);
  const options = picker.payload.components[0].toJSON().components
    .flatMap((component) => component.components ?? [])
    .flatMap((component) => component.options ?? []);
  assert.equal(options.length, 2);
  assert.ok(options.every((option) => !option.label.includes('💞')));
  const interaction = {
    customId: 'xfer:choose', user: { id: '101' }, guildId: '1',
    values: ['14'], deferUpdate: async () => {}, reply: async () => {},
  };
  await picker.collector.listeners('collect')[0](interaction);
  assert.match(text(channel.sent[1].payload), /wants to give you \*\*Shared\*\*/);
});

test('cancel drops the pending trade', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['trade', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await trade(ctx);

  const cancelCtx = context(db, channel, '101', ['cancel']);
  await cancel(cancelCtx);
  assert.match(text(cancelCtx.message.replies[0].payload), /The trade was cancelled/);
  assert.equal((await say(db, channel, '101', 'Eleven')).handled, false);
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
});

test('a trade needs a partner in the server and characters to trade', async (t) => {
  const db = fixture(t);
  const channel = createChannel();
  const lonely = context(db, channel, '101', ['trade', '<@999>']);
  await trade(lonely);
  assert.match(text(lonely.message.replies[0].payload), /not in this server/);

  const alone = context(db, channel, '101', ['trade', '<@102>']);
  alone.message.guild.members.cache.set('102', { id: '102' });
  await trade(alone);
  assert.match(text(alone.message.replies[0].payload), /do not own any characters to trade/);
});

test('a trade cannot start with yourself or without a target', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  const channel = createChannel();
  const self = context(db, channel, '101', ['trade', '<@101>']);
  await trade(self);
  assert.match(text(self.message.replies[0].payload), /cannot trade with yourself/);

  const empty = context(db, channel, '101', ['trade']);
  await trade(empty);
  assert.match(text(empty.message.replies[0].payload), /Usage: !trade @user/);
});

test('only the player who has to pick consumes the typed name', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['trade', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await trade(ctx);
  assert.equal((await say(db, channel, '102', 'Twelve')).handled, false);
  assert.equal((await say(db, channel, '101', 'Nobody')).handled, true);
  assert.match(text(channel.sent[0].payload), /No character matching \*\*Nobody\*\*/);
});

test('the character list is a valid Components V2 payload', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['give', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await give(ctx);

  const container = ctx.message.replies[0].payload.components[0].toJSON();
  const section = container.components.find((component) => component.type === 9);
  // A section holds at most three text displays, so the notice sits outside it.
  assert.ok(section, 'the list uses a section for the character thumbnail');
  assert.ok(section.components.length <= 3, 'a section holds at most three text displays');
  const notice = container.components.find((component) => component.type === 10);
  assert.match(notice.content, /Gift for <@102>/);
  assert.equal(container.components.length, 2);
});


test('a typo-only gift requires the giver to select the corrected character', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['give', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await give(ctx);
  await say(db, channel, '101', 'Elevne');
  assert.match(text(channel.sent.at(-1).payload), /pick the character you meant/);
  assert.equal(getMarriage(db, '1', 11)?.ownerId, '101');
  const picker = channel.sent.at(-1);
  await picker.collector.listeners('collect')[0]({ customId: 'xfer:choose', user: { id: '101' }, guildId: '1',
    values: ['11'], deferUpdate: async () => {}, reply: async () => {} });
  assert.match(text(channel.sent.at(-1).payload), /wants to give you/);
});

test('a newer typed query invalidates an older ambiguous-name picker', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 13, '101');
  marryCharacter(db, '1', 14, '101');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['give', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await give(ctx);
  await say(db, channel, '101', 'Shared');
  const old = channel.sent.at(-1);
  let acknowledge = () => {};
  const delayedPick = old.collector.listeners('collect')[0]({
    customId: 'xfer:choose', user: { id: '101' }, guildId: '1', values: ['13'],
    deferUpdate: () => new Promise(resolve => { acknowledge = () => resolve(undefined); }),
  });
  await say(db, channel, '101', 'unknown');
  acknowledge();
  await delayedPick;
  assert.match(text(channel.sent.at(-1).payload), /No character matching/);
  let refused = '';
  await old.collector.listeners('collect')[0]({ customId: 'xfer:choose', user: { id: '101' }, guildId: '1', values: ['13'],
    reply: async value => { refused = value.content; }, deferUpdate: async () => {} });
  assert.match(refused, /expired/);
  assert.equal(isCharacterPendingTransfer(db, '1', 13), false);
  assert.equal(getMarriage(db, '1', 13)?.ownerId, '101');
});

test('a typo-only counteroffer requires the recipient to accept the corrected identity', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', 11, '101');
  marryCharacter(db, '1', 12, '102');
  const channel = createChannel();
  const ctx = context(db, channel, '101', ['trade', '<@102>']);
  ctx.message.guild.members.cache.set('102', { id: '102' });
  await trade(ctx);
  await say(db, channel, '101', 'Eleven');
  await say(db, channel, '102', 'Twelev');
  assert.match(text(channel.sent.at(-1).payload), /pick the character you meant/);
  assert.equal(getMarriage(db, '1', 12)?.ownerId, '102');
});
