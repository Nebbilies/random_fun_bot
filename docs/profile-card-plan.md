# Guild profile card implementation plan

Build the caller’s current guild collection card on `feature/profile-card`. The [approved design](profile-card-design.md) defines the card and progress message.

1. Write failing `node:test` tests for the guild-prefix entry point, collection snapshot, one-message progress, and PNG output. Use a synthetic catalog, mocked Discord replies, and local portrait fixtures.
2. Register `profile` in the guild command registry, add it to player help, and implement the reply flow in `commands/profile.js`. Use the caller’s guild display name and avatar. Extra arguments get a usage hint.
3. In `lib/profileCardData.js`, read all current ownership and effective franchise counts in one SQLite snapshot. Reuse the affection overview and total-married leaderboard, including `!tsl` membership filtering and tie order. Keep zero-affection and archived owned characters eligible, and show the current soulmate independently. Sort franchise counts descending, then by name and ID.
4. Prepare up to seven unique portraits concurrently. Keep each public HTTPS request within five seconds and four MiB, and validate addresses and redirect targets. Use a dimmed slot with a centered question mark when a portrait is unavailable.
5. Pin Skia Canvas 4.0.1 and draw the approved 1440 × 1080 Index layout in `lib/profileCardRenderer.js`. Bundle its fonts and licenses. Allow two lines for soulmate names and one line for ranked names. Use the compact size before applying an ellipsis. Show Waifu Roller with `// TODO: add profile titles feature later` beside it in code.
6. Reply with `Rendering your profile card...` and `-# Loading collection stats...`. Edit the second line to `-# Preparing portraits...` and then `-# Rendering image...`. On the same reply, clear the progress and attach `profile-card.png` inside the `<display name>'s Profile Card` embed. Suppress mentions and show a stage-specific error if the operation fails and the reply can still be edited.

## Verification

- Check exact progress and attachment behavior, guild isolation, rank parity, multi-franchise counting, empty states, and stats, rendering, and upload failures.
- Render a PNG with Tsukishiro Yanagi and a missing portrait. Check it at full size and 360 px wide.
- Run focused and full tests and catalog typechecking on Node 22.23.2. Verify a clean production dependency install and native PNG export on Ubuntu with the bundled fonts.

Phase 3 self-review confirmed the command, data, rendering, and verification paths against the approved design.
