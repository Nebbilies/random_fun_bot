import { getItemRules } from "../itemRuntimeConfig.js";
import { addActiveBuff } from "../itemStorage.js";

export const rollingFever = {
  id: "rolling_fever",
  name: "Rolling Fever",
  tier: "rare",
  description:
    "For your **next 10 character rolls**, rolling a character ranked #1500 or better refunds up to **2 rolls** already used this hour.",
  type: "active",
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    const rules = getItemRules(db, guildId, "rolling_fever");
    addActiveBuff(
      db,
      guildId,
      userId,
      "rolling_fever",
      JSON.stringify(rules),
      null,
      rules.rolls,
    );
    return {
      success: true,
      message: `Rolling Fever activated! For your next ${rules.rolls} rolls, characters ranked #${rules.maxRank} or better refund up to ${rules.refundRolls} used rolls.`,
    };
  },
};
