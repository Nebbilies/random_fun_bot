import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { isValidCharacterId, loadCharacterIndex, findCharacters } from '../lib/gameCharacterLookup.js';
import { marryCharacter, getMarriage, listMarriagesByFranchise, divorceCharacter } from '../lib/characterMarriage.js';
import { getOwnedCharacter, transferCharacter, swapCharacters } from '../lib/characterTrade.js';
import { addWish, getWishes, matchWishes, removeWish, findWishMatchers } from '../lib/characterWishlist.js';
import { isCharacterBusy, isCharacterHeld, isCharacterPendingTransfer, registerPendingTransfer,
  unregisterPendingTransfer } from '../lib/characterAvailability.js';
import { startGift, onTradeAnswer } from '../lib/tradeRuntime.js';
import { run as wishCommand } from '../commands/wish.js';
import { run as divorceCommand } from '../commands/divorce.js';
import { createReviewServer } from '../web/reviewCharacterTags.js';
import { authConfig, authenticatedFetch } from './helpers/portalAuth.js';

const A = '12345678-1234-4123-8123-123456789abc';
const B = 'abcdef01-2345-4678-9abc-def012345678';
const C = '99999999-8888-4777-8666-555555555555';

// Deliberately independent of openCatalog/migrations: no production DB is opened.
// TEXT character keys model the destination while row/session/franchise IDs stay INTEGER.
function fixture(t, characterType = 'TEXT', ids = [A, B, C]) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE characters (id ${characterType} PRIMARY KEY, rank INTEGER, favourites INTEGER,
      name_full TEXT, name_native TEXT, name_alternatives TEXT, anime_titles TEXT,
      image_url TEXT, site_url TEXT, gender TEXT, anime_adult INTEGER);
    CREATE TABLE character_identities (id ${characterType} PRIMARY KEY, name_full TEXT);
    CREATE TABLE marriages (id INTEGER PRIMARY KEY, guild_id TEXT, character_id ${characterType},
      owner_id TEXT, married_at TEXT, UNIQUE(guild_id, character_id));
    CREATE TABLE character_wishes (guild_id TEXT, user_id TEXT, character_id ${characterType},
      created_at INTEGER, PRIMARY KEY(guild_id,user_id,character_id));
    CREATE TABLE item_character_reservations (guild_id TEXT, character_id ${characterType}, action_id TEXT);
    CREATE TABLE character_rolls (guild_id TEXT, character_id ${characterType}, escape_marriage_id INTEGER,
      state TEXT, expires_at INTEGER);
    CREATE TABLE mystery_sessions (guild_id TEXT, character_id ${characterType}, state TEXT);
    CREATE TABLE counterfeit_crowns (guild_id TEXT, character_id ${characterType});
    CREATE TABLE character_protection_locks (guild_id TEXT, character_id ${characterType},
      lock_type TEXT, protected_until INTEGER);
    CREATE TABLE character_anime (character_id ${characterType}, anime_id INTEGER);
    CREATE TABLE franchise_anime (franchise_id INTEGER, anime_id INTEGER);
    CREATE TABLE franchises (id INTEGER PRIMARY KEY, display_name TEXT);
    INSERT INTO franchises VALUES (1, 'Shared series');
    INSERT INTO franchise_anime VALUES (1, 10);
    CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO catalog_meta VALUES ('import_phase', 'complete');
    CREATE TABLE tag_decisions (character_id ${characterType} PRIMARY KEY, status TEXT,
      tag_name TEXT, source TEXT, updated_at TEXT);
    CREATE TABLE tag_candidates (character_id ${characterType}, tag_name TEXT, post_count INTEGER, reason TEXT);
    CREATE TABLE character_tag_reports (id INTEGER PRIMARY KEY, character_id ${characterType},
      reporter_id TEXT, reported_at TEXT, resolved_at TEXT, outcome TEXT);
  `);
  ids.forEach((id, index) => {
    db.prepare(`INSERT INTO characters (id,rank,favourites,name_full,name_alternatives,anime_titles)
      VALUES (?,?,100,?,'[]','[]')`).run(id, index + 1, index < 2 ? 'Shared' : 'Third');
    db.prepare('INSERT INTO character_identities VALUES (?,?)').run(id, index < 2 ? 'Shared' : 'Third');
    db.prepare('INSERT INTO character_anime VALUES (?,10)').run(id);
  });
  return db;
}

function sent(payload) {
  const handlers = new Map();
  const collector = { on(event, callback) { handlers.set(event, callback); }, stop() {} };
  return { payload, edits: [], handlers, createMessageComponentCollector: () => collector,
    async edit(value) { this.edits.push(value); } };
}
function context(db, args, characterIndex = loadCharacterIndex(db)) {
  const replies = [];
  const channel = { id: '10', sent: [], async send(payload) {
    const message = sent(payload); this.sent.push(message); return message;
  } };
  return { args, prefix: '!', yoshiko: { catalogDb: db, characterIndex }, message: {
    guildId: '1', channelId: '10', author: { id: '101' }, channel,
    guild: { members: { cache: new Map([['102', { id: '102' }]]) } }, replies,
    async reply(payload) { const message = sent(payload); replies.push(message); return message; },
  } };
}
function interaction(value, customId = 'wish:choose') {
  return { user: { id: '101' }, guildId: '1', customId, values: [value], updates: [],
    async deferUpdate() {}, async reply() {}, async update(payload) { this.updates.push(payload); } };
}

test('ID bridge accepts canonical UUID and legacy integers without treating source strings as catalog IDs', () => {
  for (const id of [A, B]) assert.equal(isValidCharacterId(id), true);
  const legacy = { prepare: () => ({ get: () => ({ user_version: 10 }) }) };
  for (const id of [1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isValidCharacterId(id), false);
    assert.equal(isValidCharacterId(id, legacy), true);
  }
  for (const id of [A.toUpperCase(), null, undefined, {}, [], 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    '11', 'anilist:11', ` ${A}`, A.replaceAll('-', ''), `${A}x`]) assert.equal(isValidCharacterId(id), false);
  const rows = [{ id: A, rank: 1, name_full: 'Shared' }];
  assert.equal(findCharacters(rows, 'Shared')[0].id, A);
  assert.equal(findCharacters(rows, '#1')[0].id, A);
  assert.deepEqual(findCharacters(rows, A), []); // Name/rank search is not source-ID resolution.
});

for (const [type, ids] of [['TEXT', [A, B, C]], ['INTEGER', [11, 12, 13]]]) {
  test(`${type} marriage/trade/wishlist bridge preserves character identities`, (t) => {
    const db = fixture(t, type, ids);
    const [a, b, c] = ids;
    const marriage = marryCharacter(db, '1', a, '101').marriage;
    assert.equal(marriage.characterId, a);
    assert.equal(typeof marriage.id, 'number');
    assert.equal(marryCharacter(db, '1', a, '101').status, 'already_yours');
    marryCharacter(db, '1', b, '102');
    assert.equal(listMarriagesByFranchise(db, '1', '101')[0].characters[0].characterId, a);
    assert.equal(getOwnedCharacter(db, '1', '101', a).characterId, a);
    assert.equal(swapCharacters(db, { guildId: '1', first: { characterId: a, ownerId: '101' },
      second: { characterId: b, ownerId: '102' } }).status, 'traded');
    db.prepare('INSERT INTO counterfeit_crowns VALUES (?,?)').run('1', a);
    const gift = transferCharacter(db, { guildId: '1', characterId: a, fromOwnerId: '102', toOwnerId: '101' });
    assert.equal(gift.characterId, a);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM counterfeit_crowns').get().n, 0);
    assert.equal(transferCharacter(db, { guildId: '1', characterId: a, fromOwnerId: '101',
      toOwnerId: '102', marriageId: marriage.id + 100 }).status, 'not_owned');
    assert.equal(divorceCharacter(db, '1', a, '101', marriage.id + 100), false);
    assert.equal(divorceCharacter(db, '1', a, '101', marriage.id), true);
    assert.equal(getMarriage(db, '1', a), null);
    const wish = { guildId: '1', userId: '101', characterId: c };
    assert.equal(addWish(db, wish).status, 'added');
    assert.equal(addWish(db, wish).status, 'duplicate');
    assert.deepEqual(findWishMatchers(db, { guildId: '1', characterId: c }), ['101']);
    assert.equal(matchWishes(getWishes(db, wish), 'Third')[0].characterId, c);
    db.prepare('DELETE FROM characters WHERE id = ?').run(c);
    assert.equal(getWishes(db, wish)[0].characterId, c);
    assert.equal(getWishes(db, wish)[0].inCatalog, false);
    assert.equal(removeWish(db, wish), true);
    for (const invalid of ['11', 'anilist:11', 0]) {
      assert.throws(() => getMarriage(db, '1', invalid));
      assert.throws(() => getOwnedCharacter(db, '1', '101', invalid));
      assert.throws(() => addWish(db, { ...wish, characterId: invalid }));
    }
    assert.equal(db.isTransaction, false);
  });
}

test('UUID availability checks durable holds, exact in-memory offers and expiry', (t) => {
  const db = fixture(t);
  registerPendingTransfer(db, 'trade:1', '1', [A], 100);
  t.after(() => unregisterPendingTransfer(db, 'trade:1'));
  assert.equal(isCharacterBusy(db, '1', A, 99), true);
  assert.equal(isCharacterPendingTransfer(db, '1', A, 99, 'trade:1'), false);
  assert.equal(isCharacterBusy(db, '2', A, 99), false);
  assert.equal(isCharacterBusy(db, '1', B, 99), false);
  assert.equal(isCharacterBusy(db, '1', A, 100), false);
  db.prepare('INSERT INTO item_character_reservations VALUES (?,?,?)').run('1', A, 'stake');
  marryCharacter(db, '1', B, '101');
  db.prepare('INSERT INTO item_character_reservations VALUES (?,?,?)').run('1', B, 'stake');
  assert.equal(divorceCharacter(db, '1', B, '101', getMarriage(db, '1', B).id), false);
  assert.equal(transferCharacter(db, { guildId: '1', characterId: B, fromOwnerId: '101', toOwnerId: '102' }).status, 'busy');
  assert.equal(isCharacterBusy(db, '1', A, 100), true);
  db.prepare('INSERT INTO character_rolls VALUES (?,?,NULL,?,?)').run('1', C, 'open', 200);
  assert.equal(isCharacterHeld(db, '1', C, 100), true);
  assert.equal(isCharacterHeld(db, '1', C, 200), false);
  db.prepare('INSERT INTO mystery_sessions VALUES (?,?,?)').run('1', C, 'running');
  assert.equal(isCharacterHeld(db, '1', C, 200), true);
});

test('wish picker uses exact offered strings and retains UUID/legacy value types', async (t) => {
  for (const [type, ids] of [['TEXT', [A, B, C]], ['INTEGER', [11, 12, 13]]]) {
    const db = fixture(t, type, ids);
    const ctx = context(db, ['wish', 'Shared']);
    await wishCommand(ctx);
    const picker = ctx.message.replies[0];
    const collect = picker.handlers.get('collect');
    await collect(interaction(type === 'TEXT' ? A.toUpperCase() : '011'));
    assert.equal(getWishes(db, { guildId: '1', userId: '101' }).length, 0);
    await collect(interaction(String(ids[1])));
    assert.equal(getWishes(db, { guildId: '1', userId: '101' })[0].characterId, ids[1]);
    addWish(db, { guildId: '1', userId: '101', characterId: ids[0] });
    ctx.args = ['wish', 'remove', 'Shared'];
    await wishCommand(ctx);
    await ctx.message.replies.at(-1).handlers.get('collect')(interaction(String(ids[1])));
    assert.deepEqual(getWishes(db, { guildId: '1', userId: '101' }).map((row) => row.characterId), [ids[0]]);
  }
});

test('UUID gift runtime picker and divorce confirmation keep exact character identity', async (t) => {
  const db = fixture(t);
  marryCharacter(db, '1', A, '101');
  marryCharacter(db, '1', B, '101');
  const ctx = context(db, ['give', '102']);
  await startGift(ctx);
  const answer = (author, content) => onTradeAnswer(db, { ...ctx.message, author: { id: author }, content });
  await answer('101', 'Shared');
  const picker = ctx.message.channel.sent.at(-1);
  await picker.handlers.get('collect')(interaction(B, 'xfer:choose'));
  assert.equal(isCharacterPendingTransfer(db, '1', B), true);
  await answer('102', 'yes');
  assert.equal(getMarriage(db, '1', B).ownerId, '102');
  assert.equal(getMarriage(db, '1', A).ownerId, '101');
  ctx.args = ['divorce', 'Shared'];
  await divorceCommand(ctx);
  const prompt = ctx.message.replies.at(-1);
  const serialized = JSON.stringify(prompt.payload.components.map((component) => component.toJSON()));
  assert.match(serialized, /Character ID/);
  assert.doesNotMatch(serialized, /AniList ID/);
  assert.ok(serialized.includes(A));
  await prompt.handlers.get('collect')(interaction(A, 'divorce:confirm'));
  assert.equal(getMarriage(db, '1', A), null);
});

test('portal decision/report routes accept opaque UUIDs and reject source-ID-like inputs', async (t) => {
  const db = fixture(t);
  db.prepare('INSERT INTO character_tag_reports (character_id,reporter_id,reported_at) VALUES (?,?,?)')
    .run(A, '101', '2026-01-01');
  const server = createReviewServer({ db, port: 0, authConfig, api: { async exactTag() { return { name: 'shared' }; } } });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => authenticatedFetch(`${origin}/api/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const characterId of ['11', 'anilist:11', `${A}x`, 0, A.toUpperCase()]) {
    assert.equal((await post('decision', { characterId, status: 'no_match' })).status, 400);
    assert.equal((await post('reports/resolve', { characterId, outcome: 'dismissed' })).status, 400);
  }
  assert.equal((await post('decision', { characterId: A, status: 'approve', tag: 'shared' })).status, 200);
  assert.equal(db.prepare('SELECT character_id FROM tag_decisions').get().character_id, A);
  assert.equal((await post('reports/resolve', { characterId: A, outcome: 'corrected', tag: 'shared' })).status, 200);
  assert.equal(db.prepare('SELECT character_id,outcome FROM character_tag_reports').get().outcome, 'corrected');
});

test('owned source paths document the legacy-only bridge and do not number-coerce select values', () => {
  const lookup = readFileSync(new URL('../lib/gameCharacterLookup.js', import.meta.url), 'utf8');
  assert.match(lookup, /explicit legacy database connection/);
  assert.match(lookup, /Source IDs are never resolved automatically/);
  for (const path of ['../commands/wish.js', '../lib/tradeRuntime.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Number\(interaction\.values/);
  }
});
