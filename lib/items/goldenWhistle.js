export const goldenWhistle = {
  id: "golden_whistle",
  name: "Golden Whistle",
  tier: "rare",
  description:
    "**Automatically reclaims** your married character if they attempt an escape. Has 3 charges.",
  type: "passive",
  maxCharges: 3,

  execute() {
    return {
      success: false,
      message:
        "**Golden Whistle** is a passive item and activates automatically when an escape attempt starts!",
    };
  },
};
