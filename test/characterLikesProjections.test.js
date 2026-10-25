import assert from 'node:assert/strict';
import test from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { characterLikesProjection } from '../lib/characterLikesProjection.js';
import { loadCharacterIndex, findCharacters } from '../lib/gameCharacterLookup.js';
import { listMarriages, listMarriagesByFranchise, marryCharacter } from '../lib/characterMarriage.js';
import { reserveRoll, publishMysteryIntro } from '../lib/characterRolls.js';
import { rollCard, startForcedEscape } from '../lib/characterRollRuntime.js';
import { reserveMysteryAwareRoll, beginMysteryEvent, advanceMysteryEvent } from '../lib/mysteryCoordinator.js';
import { startMysteryRoll, cancelMysteryRuntime } from '../lib/mysteryRuntime.js';
import { formatCharacterLikes } from '../lib/characterLikes.js';

function fixture(t, source) {
  const db = openCatalog(':memory:');
  t.after(() => db.close());
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,gender,image_url,anime_titles)
    VALUES(11,1,5050,'Prize','Female','https://example.com/prize.png','["Show"]');
    INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;`);
  if (source !== 'legacy') {
    migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
    db.prepare('UPDATE characters SET likes_source=?').run(source);
  }
  return { db, id: db.prepare('SELECT id FROM characters').get().id };
}
const request = { guildId: '1', channelId: '10', commandMessageId: '100', userId: '101', pool: 'w', now: 1000, random: () => 0 };
const render = payload => JSON.stringify(payload.components.map(component => component.toJSON()));
function check(character, source) {
  assert.equal(character.favourites, 5050);
  assert.equal(character.likes_source, source === 'legacy' ? 'anilist' : source);
  assert.equal(formatCharacterLikes(character), source === 'generated' ? '5,050 [generated]' : '5,050');
}

for (const source of ['legacy', 'anilist', 'generated']) {
  test(`${source}: lookup and both marriage list projections carry likes provenance`, t => {
    const { db, id } = fixture(t, source);
    const found = findCharacters(loadCharacterIndex(db), 'Prize');
    assert.equal(found[0].id, id);
    check(found[0], source);
    assert.equal(marryCharacter(db, '1', id, '101').status, 'married');
    for (const sort of ['time', 'rank']) {
      check(listMarriages(db, '1', '101', sort)[0], source);
      check(listMarriagesByFranchise(db, '1', '101', sort)[0].characters[0], source);
    }
  });

  test(`${source}: reserve roll hydrates provenance into revealed cards and mystery selection`, t => {
    const { db, id } = fixture(t, source);
    const roll = reserveRoll(db, request);
    assert.equal(roll.status, 'reserved');
    assert.equal(roll.character.id, id);
    check(roll.character, source);
    const card = render(rollCard(roll.character, null, roll.remaining));
    assert.equal(card.includes('[generated]'), source === 'generated');
    let selected;
    const mystery = reserveRoll(db, { ...request, guildId: '2', commandMessageId: '101', mystery: {
      eventChannelId: '10', selectEvent: ({ character }) => {
        selected = character;
        return { eventId: 'doors', state: {}, durationMs: 60000 };
      },
    } });
    assert.equal(mystery.status, 'mystery');
    check(selected, source);
  });

  test(`${source}: forced escape independently reads and renders provenance`, async t => {
    const { db, id } = fixture(t, source);
    marryCharacter(db, '1', id, '101');
    const sent = [];
    const card = { id: '500', edit: async () => {} };
    const result = await startForcedEscape({ db, guildId: '1', channelId: '10', ownerId: '101', characterId: id,
      channel: { send: async payload => { sent.push(payload); return card; } },
      now: () => 1000, setTimer: () => 1, clearTimer: () => {} });
    assert.equal(result.status, 'started');
    check(result.character, source);
    assert.equal(render(sent[0]).includes('[generated]'), source === 'generated');
  });

  test(`${source}: mystery start, winner and timeout re-reads retain provenance`, t => {
    const { db } = fixture(t, source);
    const roll = reserveMysteryAwareRoll(db, { ...request, mysteryEnabled: true });
    assert.equal(roll.status, 'mystery');
    assert.equal(roll.eventId, 'doors');
    check(roll.character, source);
    assert.equal(publishMysteryIntro(db, roll.sessionId, '500', 1100), true);
    const started = beginMysteryEvent(db, roll.sessionId, 6100, () => 0);
    assert.equal(started.status, 'started');
    check(started.character, source);
    const won = advanceMysteryEvent(db, { sessionId: roll.sessionId, guildId: '1', channelId: '10',
      input: { type: 'button', userId: '101', value: '1' }, now: 6200 });
    assert.equal(won.status, 'winner');
    check(won.character, source);

    const other = reserveMysteryAwareRoll(db, { ...request, guildId: '2', commandMessageId: '101', mysteryEnabled: true });
    const expired = beginMysteryEvent(db, other.sessionId, 1000000);
    assert.equal(expired.status, 'no_winner');
    check(expired.character, source);
  });
}

test('generated mystery introduction keeps both likes and provenance hidden', async t => {
  const { db } = fixture(t, 'generated');
  const reservation = reserveMysteryAwareRoll(db, { ...request, mysteryEnabled: true });
  const sent = [];
  await startMysteryRoll({ db, client: {}, message: { channelId: '10', channel: {
    send: async payload => { sent.push(payload); return { id: '500' }; },
  } }, reservation, now: () => 1100, setTimer: () => 1, clearTimer: () => {} });
  cancelMysteryRuntime(db);
  const content = JSON.stringify(sent);
  assert.doesNotMatch(content, /5050|5,050|generated|Prize/);
  assert.match(content, /\?\?\?\?/);
});

test('projection detects a schema rebuild on the same connection and rejects invalid aliases', t => {
  const { db } = fixture(t, 'legacy');
  assert.equal(db.prepare(`SELECT ${characterLikesProjection(db)} FROM characters`).get().likes_source, 'anilist');
  migrateCharacterIdentities(db, { dryRun: false, targetVersion: 11 });
  db.exec("UPDATE characters SET likes_source='generated'");
  assert.equal(db.prepare(`SELECT ${characterLikesProjection(db, 'c')} FROM characters c`).get().likes_source, 'generated');
  assert.throws(() => characterLikesProjection(db, 'c;--'), /Invalid character table alias/);
});
