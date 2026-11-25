import { expandInventoryCapacity } from "../itemStorage.js";

export const bagOfHolding = {
  id: "bag_of_holding",
  name: "Bag of Holding",
  tier: "epic",
  description:
    "Permanently expands your inventory capacity by **+1 slot** (max 8).",
  type: "active",
  maxCharges: 1,

  execute({ db, guildId, userId }) {
    const newCapacity = expandInventoryCapacity(db, guildId, userId);
    return {
      success: true,
      newCapacity,
      message: `Your inventory capacity has expanded to ${newCapacity} slots!`,
    };
  },
};
