import { getItemRules } from "../itemRuntimeConfig.js";
import { characterFranchiseRelation } from "../characterFranchises.js";
import { getMarriage, marryCharacter } from "../characterMarriage.js";
import { isCharacterBusy, isCharacterHeld } from "../characterAvailability.js";

export const wishUponAStar = {
  id: "wish_upon_a_star",
  name: "Wish Upon A Star",
  tier: "legendary",
  description:
    "Choose a franchise. **Marry a random unowned character** from its **top 3** by rank; otherwise marry its best-ranked available unowned character.",
  type: "targeted_franchise",
  maxCharges: 1,

  execute({
    db,
    guildId,
    userId,
    args,
    random = Math.random,
    now = Date.now(),
  }) {
    const franchiseQuery = args.join(" ").replace(/^["']|["']$/g, "");
    if (!franchiseQuery) {
      return {
        success: false,
        message:
          'Please name the anime franchise you wish for! Example: `!use wish "Frieren"`',
      };
    }

    const franchise = db
      .prepare(
        `
      SELECT id, display_name FROM franchises
      WHERE LOWER(display_name) LIKE ?
    `,
      )
      .get(`%${franchiseQuery.trim().toLowerCase()}%`);

    if (!franchise) {
      return {
        success: false,
        message: `Could not find an anime franchise matching "${franchiseQuery}".`,
      };
    }

    // Find franchise characters ordered by gameplay rank.
    const characters = db
      .prepare(
        `
      SELECT DISTINCT c.id, c.name_full, c.favourites, c.rank
      FROM characters AS c
      JOIN ${characterFranchiseRelation(db)} AS membership ON membership.character_id = c.id
      WHERE membership.franchise_id = ?
      ORDER BY c.rank ASC
    `,
      )
      .all(franchise.id);

    if (!characters.length) {
      return {
        success: false,
        message: `No catalog characters found for franchise "${franchise.display_name}".`,
      };
    }

    // Check top 3 unowned
    const top3 = characters.slice(
      0,
      getItemRules(db, guildId, "wish_upon_a_star").topCount,
    );
    const available = (c) =>
      !getMarriage(db, guildId, c.id) &&
      !isCharacterBusy(db, guildId, c.id, now) &&
      !isCharacterHeld(db, guildId, c.id, now);
    const unownedInTop3 = top3.filter(available);

    let chosen;
    if (unownedInTop3.length > 0) {
      chosen = unownedInTop3[Math.floor(random() * unownedInTop3.length)];
    } else {
      // If all top 3 are claimed, find the highest unowned character in the franchise
      chosen = characters.find(available);
    }

    if (!chosen) {
      return {
        success: false,
        message: `Every character from "${franchise.display_name}" is already married in this server!`,
      };
    }

    marryCharacter(db, guildId, chosen.id, userId);

    return {
      success: true,
      character: chosen,
      franchise,
      message: `⭐ A shooting star falls from the heavens! You have wished for **${franchise.display_name}** and married **${chosen.name_full}**!`,
    };
  },
};
