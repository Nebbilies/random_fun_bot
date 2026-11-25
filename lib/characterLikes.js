import { formatNumber } from "./formatNumber.js";

/** Format an already-revealed count; callers must not invoke this for hidden likes. */
export function formatCharacterLikes(character) {
  const value = formatNumber(character.favourites ?? 0);
  return character.likes_source === "generated"
    ? `${value} [generated]`
    : value;
}
