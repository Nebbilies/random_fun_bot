export const mirrorShield = {
  id: 'mirror_shield',
  name: 'Mirror Shield',
  tier: 'epic',
  description: 'Passively protects your collection by blocking the next steal attempt targeting you.',
  type: 'passive',
  maxCharges: 1,

  execute() {
    return { success: false, message: '**Mirror Shield** is a passive defense item and triggers automatically when someone attempts to steal from you!' };
  },
};
