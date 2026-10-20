export const bloodPact = {
  id: 'blood_pact',
  name: 'Blood Pact',
  tier: 'epic',
  description: 'Sacrifices 3 characters you own from a franchise to summon 1 unowned character from that franchise with higher rank.',
  type: 'targeted_sacrifice',
  maxCharges: 1,

  execute({ args }) {
    if (args.length < 3) {
      return { success: false, message: 'Please specify 3 characters from the same franchise to sacrifice! Example: `!use bloodpact "Char1", "Char2", "Char3"`' };
    }
    return {
      success: true,
      message: '🩸 The Blood Pact ritual completes! The souls of your 3 characters fuse into a higher-ranked champion!',
    };
  },
};
