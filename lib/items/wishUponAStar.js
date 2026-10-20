import { getMarriage, marryCharacter } from '../characterMarriage.js';

export const wishUponAStar = {
  id: 'wish_upon_a_star',
  name: 'Wish Upon A Star',
  tier: 'legendary',
  description: 'Names a franchise and marries 1 randomly chosen character from the top 3 most favorited characters in that franchise.',
  type: 'targeted_franchise',
  maxCharges: 1,

  execute({ db, guildId, userId, args, random = Math.random }) {
    const franchiseQuery = args.join(' ').replace(/^["']|["']$/g, '');
    if (!franchiseQuery) {
      return { success: false, message: 'Please name the anime franchise you wish for! Example: `!use wish "Frieren"`' };
    }

    const franchise = db.prepare(`
      SELECT id, display_name FROM franchises
      WHERE LOWER(display_name) LIKE ?
    `).get(`%${franchiseQuery.trim().toLowerCase()}%`);

    if (!franchise) {
      return { success: false, message: `Could not find an anime franchise matching "${franchiseQuery}".` };
    }

    // Find franchise characters ordered by favorites DESC
    const characters = db.prepare(`
      SELECT DISTINCT c.id, c.name_full, c.favourites, c.rank
      FROM characters AS c
      JOIN character_anime AS ca ON ca.character_id = c.id
      JOIN franchise_anime AS fa ON fa.anime_id = ca.anime_id
      WHERE fa.franchise_id = ?
      ORDER BY c.favourites DESC
    `).all(franchise.id);

    if (!characters.length) {
      return { success: false, message: `No catalog characters found for franchise "${franchise.display_name}".` };
    }

    // Check top 3 unowned
    const top3 = characters.slice(0, 3);
    const unownedInTop3 = top3.filter((c) => !getMarriage(db, guildId, c.id));

    let chosen;
    if (unownedInTop3.length > 0) {
      chosen = unownedInTop3[Math.floor(random() * unownedInTop3.length)];
    } else {
      // If all top 3 are claimed, find the highest unowned character in the franchise
      chosen = characters.find((c) => !getMarriage(db, guildId, c.id));
    }

    if (!chosen) {
      return { success: false, message: `Every character from "${franchise.display_name}" is already married in this server!` };
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
