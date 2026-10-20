export const goldenHour = {
  id: 'golden_hour',
  name: 'Golden Hour',
  tier: 'epic',
  description: 'Triggers a 5-minute Happy Hour for the channel: resets hourly rolls for everyone, and grants the host a mystery vault.',
  type: 'active',
  maxCharges: 1,

  execute() {
    return {
      success: true,
      message: '⭐ Golden Hour has begun! Rolls are supercharged for the next 5 minutes!',
    };
  },
};
