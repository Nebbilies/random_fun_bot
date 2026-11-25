import { getItemRules } from "../itemRuntimeConfig.js";
import { addActiveBuff } from "../itemStorage.js";

export const fourLeafClover = {
  id: "four_leaf_clover",
  name: "Four-Leaf Clover",
  tier: "common",
  description:
    "Boosts selection of characters ranked **#1500 or better** for your next **5 qualifying rolls**. Franchise Passport rolls do not use up this boost.",
  type: "active",
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    const rules = getItemRules(db, guildId, "four_leaf_clover");
    addActiveBuff(
      db,
      guildId,
      userId,
      "four_leaf_clover",
      JSON.stringify(rules),
      null,
      rules.rolls,
    );
    return {
      success: true,
      message: `Four-Leaf Clover activated! Your next ${rules.rolls} rolls have boosted rates for characters ranked #${rules.maxRank} or better.`,
    };
  },
};
