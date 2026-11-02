import { transaction } from '../catalogDb.js';
import { addActiveBuff, getUsableInventory, decrementItemCharge } from '../itemStorage.js';

const ID = 'cupids_misfire';

// Transaction-neutral: the existing prefix dispatcher holds its write transaction
// across execute() and inventory consumption. Never merge or queue this buff.
function prepareArming(db, guildId, userId) {
  if (db.prepare('SELECT 1 FROM active_user_buffs WHERE guild_id=? AND user_id=? AND buff_id=?')
    .get(guildId, userId, ID)) {
    return { success: false, status: 'already_armed', message: "Cupid's Misfire is already armed. No additional charge was spent." };
  }
  addActiveBuff(db, guildId, userId, ID, JSON.stringify({ version: 1 }), null, 1);
  return { success: true, status: 'armed', message: "💔 Cupid's Misfire is armed indefinitely for your next married character roll—even your own! An opposing Mirror Shield blocks it and consumes the effect." };
}

/** Atomic entry point for callers that own their item cost rather than the legacy dispatcher. */
export function armCupidsMisfire(db, { guildId, userId, inventoryId, now = Date.now() }) {
  return transaction(db, () => {
    const source = getUsableInventory(db, guildId, userId, now)
      .find(row => row.id === inventoryId && row.item_id === ID);
    if (!source) return { success: false, status: 'unavailable', message: 'This item has expired or is no longer available.' };
    const result = prepareArming(db, guildId, userId);
    if (result.success) decrementItemCharge(db, source.id);
    return result;
  });
}

export const cupidsMisfire = {
  id: ID,
  name: "Cupid's Misfire",
  tier: 'rare',
  description: 'Arm an indefinite effect that forcibly divorces your next married roll, including your own, opening a normal public claim. Opposing Mirror Shield consumes one charge and the effect instead.',
  type: 'active',
  maxCharges: 1,
  // The prefix dispatcher atomically spends the inventory charge on success.
  execute({ db, guildId, userId }) { return prepareArming(db, guildId, userId); },
};
