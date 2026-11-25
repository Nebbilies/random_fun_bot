import { getGameConfig } from "./gameConfig.js";
import { getItemDefinition } from "./itemRoster.js";
import { GAME_CONFIG_DEFAULTS } from "./gameConfigSchema.js";

export function getItemExpiryDeadline(db, guildId, itemId, now) {
  const definition = getItemDefinition(itemId);
  if (!definition)
    throw new Error(`Unknown inventory item definition: ${itemId}`);
  const lifetimes =
    getGameConfig(db, guildId).itemExpiryDays ??
    GAME_CONFIG_DEFAULTS.itemExpiryDays;
  const days = lifetimes[definition.tier];
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new Error(
      `Invalid item expiry days for guild ${guildId}, tier ${definition.tier}`,
    );
  const deadline = now + days * 86400000;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(deadline))
    throw new Error("Invalid inventory acquisition time");
  return deadline;
}
