import { withOwnershipOperationClock } from "../characterOwnershipHistory.js";
import {
  itemUseInvocationId,
  getItemUseReceipt,
  saveItemUseReceipt,
  spendAffectionItemChargeInTransaction,
} from "../affectionItemUse.js";
import { addActiveBuff, getUsableInventory } from "../itemStorage.js";

const ID = "cupids_misfire";

// Transaction-neutral: the existing prefix dispatcher holds its write transaction
// across execute() and inventory consumption. Never merge or queue this buff.
function prepareArming(db, guildId, userId) {
  if (
    db
      .prepare(
        "SELECT 1 FROM active_user_buffs WHERE guild_id=? AND user_id=? AND buff_id=?",
      )
      .get(guildId, userId, ID)
  ) {
    return {
      success: false,
      status: "already_armed",
      message:
        "Cupid's Misfire is already armed. No additional charge was spent.",
    };
  }
  addActiveBuff(
    db,
    guildId,
    userId,
    ID,
    JSON.stringify({ version: 1 }),
    null,
    1,
  );
  return {
    success: true,
    status: "armed",
    message:
      "💔 Cupid's Misfire is armed indefinitely for your next opposing married character roll! Your own characters are skipped and leave it armed. An opposing Mirror Shield or Soulmate Negation blocks it and consumes the effect.",
  };
}

/** Atomic entry point for callers that own their item cost rather than the legacy dispatcher. */
export function armCupidsMisfire(
  db,
  {
    guildId,
    userId,
    inventoryId,
    invocationId,
    channelId = "",
    now = Date.now(),
    random = Math.random,
  },
) {
  invocationId = itemUseInvocationId({ invocationId });
  return withOwnershipOperationClock(db, now, () => {
    const scope = {
      invocationId,
      guildId,
      userId,
      channelId,
      kind: "misfire_activation",
      inventoryId,
    };
    const saved = getItemUseReceipt(db, scope);
    if (saved) return saved;
    const source = getUsableInventory(db, guildId, userId, now).find(
      (row) => row.id === inventoryId && row.item_id === ID,
    );
    if (!source)
      return {
        success: false,
        status: "unavailable",
        message: "This item has expired or is no longer available.",
      };
    const result = prepareArming(db, guildId, userId);
    if (result.success) {
      const payment = spendAffectionItemChargeInTransaction(db, {
        sourceKey: invocationId,
        guildId,
        userId,
        inventoryId,
        now,
        random,
      });
      result.actualDebit = payment.actualDebit;
      result.conserved = payment.conserved;
      saveItemUseReceipt(db, { ...scope, result, now });
    }
    return result;
  });
}

export const cupidsMisfire = {
  id: ID,
  name: "Cupid's Misfire",
  tier: "rare",
  description:
    "Arm an indefinite effect that **forcibly divorces** your **next married roll**, opening a normal public claim.",
  type: "active",
  maxCharges: 1,
  // The prefix dispatcher atomically spends the inventory charge on success.
  execute({ db, guildId, userId }) {
    return prepareArming(db, guildId, userId);
  },
};
