import { readRollSnapshot } from './rollLifecycleRepository.js';
import { getMysterySession } from '../../lib/mysterySessionState.js';
import { characterSnapshotFromState, validateCharacterSnapshot } from '../../lib/characterSnapshot.js';

/** Load durable published terms, or null for a legacy roll without stored terms.
 * Mystery state is optional, but any present snapshot must validate and agree.
 */
export function loadRollCharacterSnapshot(db, rollId) {
  if (!Number.isSafeInteger(rollId) || rollId <= 0) return null;
  const roll = readRollSnapshot(db, rollId);
  if (!roll) return null;
  const snapshot = roll.snapshotJson === null ? null
    : validateCharacterSnapshot(JSON.parse(roll.snapshotJson), roll.characterId);
  if (snapshot && snapshot.name_full !== roll.characterName) {
    throw new Error('Invalid roll character snapshot: name mismatch');
  }
  let mysterySnapshot = null;
  if (roll.mysterySessionId) {
    const session = getMysterySession(db, roll.mysterySessionId);
    if (!session || session.characterId !== roll.characterId || session.originRollId !== rollId) {
      throw new Error('Mystery origin roll identity mismatch');
    }
    mysterySnapshot = characterSnapshotFromState(JSON.parse(session.stateJson || 'null'),
      session.characterId, session.rankSnapshot);
    if (mysterySnapshot && mysterySnapshot.name_full !== roll.characterName) {
      throw new Error('Invalid mystery character snapshot: origin roll name mismatch');
    }
    if (snapshot && mysterySnapshot && Object.keys(snapshot)
      .some((key) => snapshot[key] !== mysterySnapshot[key])) {
      throw new Error('Invalid roll character snapshot: mystery snapshot mismatch');
    }
  }
  return snapshot ?? mysterySnapshot;
}
