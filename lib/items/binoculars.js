export const binoculars = {
  id: 'binoculars',
  name: 'Binoculars',
  tier: 'common',
  description: 'Optionally reveal the answer in an eligible mystery minigame using its Use Binoculars button.',
  type: 'passive',
  maxCharges: 1,

  execute() {
    return { success: false, message: 'Click **Use Binoculars** during your mystery minigame to receive the answer in DMs. A charge is spent only if the DM succeeds; ignoring the button keeps your item!' };
  },
};
