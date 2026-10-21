export const binoculars = {
  id: 'binoculars',
  name: 'Binoculars',
  tier: 'common',
  description: 'Automatically reveals the correct choice in your next mystery roll minigame.',
  type: 'passive',
  maxCharges: 1,

  execute() {
    return { success: false, message: '**Binoculars** is a passive item and activates automatically when your next mystery minigame starts!' };
  },
};
