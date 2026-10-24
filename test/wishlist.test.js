import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import {
  WISHLIST_LIMIT, addWish, clearWishes, findWishMatchers, getWishes, removeWish,
} from '../lib/characterWishlist.js';
import { rollCard } from '../lib/characterRollRuntime.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wishlist-'));
  const db = openCatalog(join(dir, 'catalog.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  db.exec(`INSERT INTO characters (id,rank,favourites,name_full,name_native,name_alternatives,gender,image_url,anime_titles) VALUES
    (1,1,100,'One','Mot','["Uno"]','Female','https://example.com/1.png','["Show"]'),
    (2,2,90,'Two',NULL,NULL,'Male','https://example.com/2.png','["Show"]'),
    (3,3,80,'Three',NULL,NULL,'Female','https://example.com/3.png','["Show"]'),
    (4,4,70,'Four',NULL,NULL,'Female','https://example.com/4.png','["Show"]'),
    (5,5,60,'Five',NULL,NULL,'Female','https://example.com/5.png','["Show"]'),
    (6,6,50,'Six',NULL,NULL,'Female','https://example.com/6.png','["Show"]'),
    (7,7,40,'Seven',NULL,NULL,'Female','https://example.com/7.png','["Show"]'),
    (8,8,30,'Eight',NULL,NULL,'Female','https://example.com/8.png','["Show"]')`);
  db.exec(`INSERT INTO character_identities (id, name_full, image_url)
    SELECT id, name_full, image_url FROM characters`);
  return db;
}

function cardContent(card) {
  return card.components.map((component) => {
    const json = component.toJSON();
    if (json.content) return json.content;
    return (json.components ?? []).flatMap((child) => child.components ?? [child])
      .map((child) => child.content ?? '').join('\n');
  }).join('\n');
}

function accentOf(card) {
  const container = card.components.find((component) => component.toJSON().type === 17);
  return container.toJSON().accent_color;
}

test('catalog database reaches version 10 and shares the wish table with every server', (t) => {
  const db = fixture(t);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 10);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_wishes'").get());
  assert.equal(WISHLIST_LIMIT, 7);
});

test('a wish remembers its character and survives a catalog republish', (t) => {
  const db = fixture(t);
  assert.equal(addWish(db, { guildId: '1', userId: '101', characterId: 3, now: 1000 }).status, 'added');
  let wishes = getWishes(db, { guildId: '1', userId: '101' });
  assert.deepEqual(wishes.map((wish) => [wish.characterId, wish.rank, wish.name, wish.inCatalog]),
    [[3, 3, 'Three', true]]);

  // Publication deletes and reinserts characters; a wish must not ride along.
  db.exec('DELETE FROM characters');
  wishes = getWishes(db, { guildId: '1', userId: '101' });
  assert.deepEqual(wishes.map((wish) => [wish.characterId, wish.rank, wish.name, wish.inCatalog]),
    [[3, null, 'Three', false]]);
});

test('the seven-slot cap refuses an eighth wish and never replaces anything silently', (t) => {
  const db = fixture(t);
  for (const characterId of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(addWish(db, { guildId: '1', userId: '101', characterId, now: characterId }).status, 'added');
  }
  const refused = addWish(db, { guildId: '1', userId: '101', characterId: 8, now: 99 });
  assert.equal(refused.status, 'full');
  assert.equal(refused.count, 7);
  assert.deepEqual(getWishes(db, { guildId: '1', userId: '101' }).map((wish) => wish.characterId),
    [1, 2, 3, 4, 5, 6, 7]);
});

test('duplicate wishes are reported, not counted twice', (t) => {
  const db = fixture(t);
  addWish(db, { guildId: '1', userId: '101', characterId: 2, now: 1 });
  const repeat = addWish(db, { guildId: '1', userId: '101', characterId: 2, now: 2 });
  assert.equal(repeat.status, 'duplicate');
  assert.equal(repeat.count, 1);
  assert.equal(getWishes(db, { guildId: '1', userId: '101' }).length, 1);
});

test('wishlists are per server and per player', (t) => {
  const db = fixture(t);
  addWish(db, { guildId: '1', userId: '101', characterId: 5, now: 1 });
  addWish(db, { guildId: '2', userId: '101', characterId: 6, now: 2 });
  addWish(db, { guildId: '1', userId: '102', characterId: 7, now: 3 });
  assert.deepEqual(getWishes(db, { guildId: '1', userId: '101' }).map((wish) => wish.characterId), [5]);
  assert.deepEqual(getWishes(db, { guildId: '2', userId: '101' }).map((wish) => wish.characterId), [6]);
  assert.deepEqual(getWishes(db, { guildId: '1', userId: '102' }).map((wish) => wish.characterId), [7]);
  assert.equal(addWish(db, { guildId: '1', userId: '102', characterId: 1, now: 4 }).status, 'added');
  assert.equal(getWishes(db, { guildId: '2', userId: '101' }).length, 1);
});

test('removeWish and clearWishes only touch the caller in their server', (t) => {
  const db = fixture(t);
  addWish(db, { guildId: '1', userId: '101', characterId: 1, now: 1 });
  addWish(db, { guildId: '1', userId: '101', characterId: 2, now: 2 });
  addWish(db, { guildId: '1', userId: '102', characterId: 3, now: 3 });
  assert.equal(removeWish(db, { guildId: '1', userId: '101', characterId: 1 }), true);
  assert.equal(removeWish(db, { guildId: '1', userId: '101', characterId: 1 }), false);
  assert.equal(removeWish(db, { guildId: '2', userId: '101', characterId: 2 }), false);
  assert.deepEqual(getWishes(db, { guildId: '1', userId: '101' }).map((wish) => wish.characterId), [2]);
  assert.equal(clearWishes(db, { guildId: '1', userId: '101' }), 1);
  assert.equal(getWishes(db, { guildId: '1', userId: '101' }).length, 0);
  assert.equal(getWishes(db, { guildId: '1', userId: '102' }).length, 1);
});

test('findWishMatchers names every wisher in one server, oldest wish first', (t) => {
  const db = fixture(t);
  assert.deepEqual(findWishMatchers(db, { guildId: '1', characterId: 4 }), []);
  addWish(db, { guildId: '1', userId: '102', characterId: 4, now: 20 });
  addWish(db, { guildId: '1', userId: '101', characterId: 4, now: 10 });
  addWish(db, { guildId: '1', userId: '103', characterId: 5, now: 30 });
  addWish(db, { guildId: '2', userId: '104', characterId: 4, now: 40 });
  assert.deepEqual(findWishMatchers(db, { guildId: '1', characterId: 4 }), ['101', '102']);
  assert.deepEqual(findWishMatchers(db, { guildId: '1', characterId: 5 }), ['103']);
  assert.deepEqual(findWishMatchers(db, { guildId: '1', characterId: 8 }), []);
});

test('a wish match turns the roll card green and adds one line naming every wisher', () => {
  const character = { name_full: 'One', anime_titles: '["Show"]', rank: 1, favourites: 100 };
  const plain = rollCard(character, { url: 'https://example.com/1.png' }, 6);
  assert.equal(accentOf(plain), 0xe91e63);
  assert.doesNotMatch(cardContent(plain), /Wish/);

  const wished = rollCard(character, { url: 'https://example.com/1.png' }, 6, null,
    { userIds: ['101', '102'], ping: true });
  assert.equal(accentOf(wished), 0x57f287);
  assert.match(cardContent(wished), /⭐ <@101>, <@102>'s Wish/);
  assert.deepEqual(wished.allowedMentions.users, ['101', '102']);
  assert.deepEqual(wished.allowedMentions.parse, []);

  const single = rollCard(character, null, 6, null, { userIds: ['101'], ping: true });
  assert.match(cardContent(single), /⭐ <@101>'s Wish/);
});

test('the wish line sits above the card and below the escape text, and never re-pings on refresh', () => {
  const character = { name_full: 'One', anime_titles: '["Show"]', rank: 1, favourites: 100, gender: 'Female' };
  const escape = { phase: 'protected', ownerId: '999', protectedUntil: 60_000, ping: true };
  const first = rollCard(character, null, 6, escape, { userIds: ['101'], ping: true });
  const firstContent = cardContent(first);
  assert.ok(firstContent.indexOf('tries to leave your harem') < firstContent.indexOf("⭐ <@101>'s Wish"));
  assert.ok(firstContent.indexOf("⭐ <@101>'s Wish") < firstContent.indexOf('# One'));
  assert.equal(accentOf(first), 0x57f287);
  assert.deepEqual(first.allowedMentions.users, ['999', '101']);

  const refreshed = rollCard(character, null, 6, { ...escape, ping: false }, { userIds: ['101'], ping: false });
  assert.match(cardContent(refreshed), /⭐ <@101>'s Wish/);
  assert.deepEqual(refreshed.allowedMentions.users, []);
  assert.equal(accentOf(refreshed), 0x57f287);
});

test('a married card stays brown even when the character was wished', () => {
  const character = { name_full: 'One', anime_titles: '["Show"]', rank: 1, favourites: 100, gender: 'Female' };
  const married = rollCard(character, null, 6,
    { outcome: 'married', winnerId: '101', ownerId: '101', ping: true },
    { userIds: ['102'], ping: true });
  assert.equal(accentOf(married), 0x8b4513);
  assert.match(cardContent(married), /⭐ <@102>'s Wish/);
});

test('an escape card keeps its purple accent when nobody wished for the character', () => {
  const character = { name_full: 'One', anime_titles: '["Show"]', rank: 1, favourites: 100, gender: 'Female' };
  const card = rollCard(character, null, 6, { phase: 'protected', ownerId: '999', protectedUntil: 60_000 });
  assert.equal(accentOf(card), 0x9b59b6);
});
