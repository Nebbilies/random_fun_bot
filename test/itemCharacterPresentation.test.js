import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openCatalog } from '../lib/catalogDb.js';
import { immediateActionCards, itemCharacterResult } from '../lib/itemCharacterPresentation.js';

 test('item header sits above card containers and mentions are suppressed', (t) => {
  const db = openCatalog(':memory:'); t.after(() => db.close());
  db.prepare('INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,10,20,?)').run('Test Character');
  const data = itemCharacterResult(db, { title: 'Blood Pact', cards: [{ character: { id: 1 }, footer: 'Married by <@101>' }] });
  assert.equal(data.components[0].toJSON().type, 10);
  assert.equal(data.components[0].toJSON().content, '# Blood Pact');
  assert.equal(data.components[1].toJSON().type, 17);
  assert.match(JSON.stringify(data), /Test Character/);
  assert.deepEqual(data.allowedMentions.parse, []);
});

test('forced divorce cards describe both effective losses, never a marriage', () => {
  const own = { characterId: 1, ownerId: '101' };
  const target = { characterId: 3, ownerId: '202' };
  const cards = immediateActionCards({ kind: 'heart_for_a_heart', state: 'resolved', selections: { own }, result: { targets: [target] } });
  assert.deepEqual(cards.map((c) => c.character), [own, target]);
  assert.ok(cards.every((c) => c.footer.includes('Divorced from')));
  assert.deepEqual(immediateActionCards({ kind: 'severed_fate', state: 'resolved', result: { blocked: true } }), []);
});
