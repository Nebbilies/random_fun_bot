# Item expiry rollout and verification

## Deployment

Deploy schema/deadline stamping, live-inventory checks, started-use reservations, and passive enforcement as one release. Deploying only the inventory UI or `!use` check is not sufficient.

1. Back up production storage and verify the restore procedure.
2. Rehearse startup upgrade on a copy of the production database before deployment.
3. Upgrade the bot and configuration portal together. The startup upgrade uses the existing SQLite write lock and validates known schema shapes before committing.
4. Record `item_expiry_schema.rollout_at`. Existing entries receive the effective rarity lifetime from this single migration instant; restarting never restamps them.
5. Check `PRAGMA foreign_key_check`, inventory capacity, held action recovery, and the portal's global/guild expiry controls.
6. Use a schema-compatible rollback application or restore explicitly. Do not assume an old application understands the additive schema.

## Runtime behavior

- `itemExpiryDays` contains whole-day values from 1 through 365. Defaults are 2/4/7/14/30 for Common/Rare/Epic/Legendary/`???`.
- Saving new values affects later acquisitions only. Pending vault rewards acquire a deadline on actual delivery.
- Inventory reads and capacity checks enforce deadlines directly, including after downtime. A bounded startup/periodic cleanup removes unreferenced expired sources; it is not the eligibility mechanism.
- Sources held by confirmation actions, Hostage delivery, Fortune, or Binoculars DM delivery remain internally available to finish that use after expiry. They disappear from visible inventory and free their slot at expiry.
- Binoculars reserves before sending a DM. Known failed delivery releases the charge without extending its lifetime. If the process stops during an uncertain DM send, startup settles the reserved charge once and does not resend the secret answer. Discord delivery cannot be atomically committed with SQLite, so an uncertain delivery can cost a charge even if the DM did not arrive.
- Viewing inventory/help does not reserve anything. A supported interactive use starts when its bounded selection/confirmation action is accepted; targets and confirmation may follow after the inventory deadline.
- Countdown labels refresh when inventory is rendered, not through continuous message edits. No expiry DMs or channel announcements are sent.

## Verification record

Implementation uses focused storage/schema, configuration, action/Fortune, passive consumer, mystery, and presentation tests with controlled clocks.

- Final `npm test`: 1,263 tests; 1,262 passed, 0 failed, 1 skipped.
- `npm run typecheck:catalog`: passed.
- `git diff --check`: passed.
- Independent standards review: no documented-standard violations; three structural observations addressed.
- Independent spec/correctness review: legacy duplicate-confirmation migration, acknowledgement ordering, and Binoculars recovery findings addressed with regression coverage.

The portal presentation has automated browser coverage. No production database upgrade, live bot deployment, or real Discord interaction has been performed as part of this implementation. Those operational checks remain deployment steps.
