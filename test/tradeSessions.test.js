import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, liveSession, endSession, prepareTransferCancellation } from '../features/trade/tradeSessions.js';
import { registerPendingTransfer, isCharacterPendingTransfer } from '../lib/characterAvailability.js';

test('prepared cancellation preserves a live offer until commit and only cancels its exact marriage', () => {
  const db = {};
  let notifications = 0;
  const session = createSession(db, { guildId: '1', initiatorId: '2', recipientId: '3',
    offer: { characterId: 'uuid-character', marriageId: 10 }, target: null }, () => { notifications++; });
  registerPendingTransfer(db, `trade:${session.id}`, '1', ['uuid-character']);
  const wrong = prepareTransferCancellation(db, '1', [{ characterId: 'uuid-character', marriageId: 11, ownerId: '2' }]);
  wrong();
  assert.equal(liveSession(db, session), true);
  const afterCommit = prepareTransferCancellation(db, '1', [{ characterId: 'uuid-character', marriageId: 10, ownerId: '2' }]);
  // A rollback discards the callback; preparation cannot mutate live state.
  assert.equal(liveSession(db, session), true);
  assert.equal(isCharacterPendingTransfer(db, '1', 'uuid-character'), true);
  assert.equal(notifications, 0);
  afterCommit();
  assert.equal(liveSession(db, session), false);
  assert.equal(isCharacterPendingTransfer(db, '1', 'uuid-character'), false);
  assert.equal(notifications, 1);
  afterCommit();
  endSession(db, session);
  assert.equal(notifications, 1);
});
