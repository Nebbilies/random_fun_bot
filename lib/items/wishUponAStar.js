import { getItemRules } from "../itemRuntimeConfig.js";
import { characterMainFranchiseRelation } from "../characterFranchises.js";
import { getMarriage, marryCharacter } from "../characterMarriage.js";
import { isCharacterBusy, isCharacterHeld } from "../characterAvailability.js";
import { withOwnershipOperationClock } from "../characterOwnershipHistory.js";
import { scoreWeeklyGain } from "../../features/weeklyEvents/weeklyEvents.js";

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
          'Please name the franchise you wish for! Example: `!use wish "Frieren"`',
      };
    }

    const membership = characterMainFranchiseRelation(db);
    const franchise = db
      .prepare(
        `SELECT f.id, f.display_name FROM franchises f
        WHERE LOWER(f.display_name) LIKE ?
          AND EXISTS (SELECT 1 FROM ${membership} m WHERE m.franchise_id=f.id)`,
      )
      .get(`%${franchiseQuery.trim().toLowerCase()}%`);

    if (!franchise) {
      return {
        success: false,
        message: `Could not find a franchise matching "${franchiseQuery}".`,
      };
    }

    // Find franchise characters ordered by gameplay rank.
    const characters = db
      .prepare(
        `
      SELECT DISTINCT c.id, c.name_full, c.favourites, c.rank
      FROM characters AS c
      JOIN ${membership} AS membership ON membership.character_id = c.id
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

    const married = withOwnershipOperationClock(db, now, () => {
      const result = marryCharacter(db, guildId, chosen.id, userId, now);
      if (result.status === "married" && result.marriage)
        scoreWeeklyGain(
          db,
          guildId,
          userId,
          chosen.id,
          `wish-item:${result.marriage.id}`,
          now,
        );
      return result.status === "married";
    });
    if (!married)
      return {
        success: false,
        message: "That character is no longer available.",
      };

    return {
      success: true,
      character: chosen,
      franchise,
      message: `⭐ A shooting star falls from the heavens! You have wished for **${franchise.display_name}** and married **${chosen.name_full}**!`,
    };
  },
};
