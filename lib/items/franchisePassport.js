import { getItemRules } from '../itemRuntimeConfig.js';
import { addActiveBuff } from '../itemStorage.js';

export const franchisePassport = {
  id: 'franchise_passport',
  name: 'Franchise Passport',
  tier: 'epic',
  description: 'Selects characters from your chosen franchise for your next 5 qualifying rolls. Uses the normal pool if no eligible characters from that franchise are available.',
  type: 'targeted_franchise',
  maxCharges: 1,

  execute({ db, guildId, userId, args }) {
    const franchiseQuery = args.join(' ').replace(/^["']|["']$/g, '');
    if (!franchiseQuery) {
      return { success: false, message: 'Please name the anime franchise for your passport! Example: `!use passport "Jujutsu Kaisen"`' };
    }
    const franchise = db.prepare('SELECT id, display_name FROM franchises WHERE LOWER(display_name) LIKE ?')
      .get(`%${franchiseQuery.trim().toLowerCase()}%`);
    if (!franchise) {
      return { success: false, message: `Could not find franchise "${franchiseQuery}".` };
    }
    const rules = getItemRules(db, guildId, 'franchise_passport');
    addActiveBuff(db, guildId, userId, 'franchise_passport', JSON.stringify({ ...rules, franchiseId: franchise.id, name: franchise.display_name }), null, rules.rolls);
    return { success: true, message: `Franchise Passport stamped for **${franchise.display_name}**! Your next ${rules.rolls} rolls are guaranteed from this series.` };
  },
};
