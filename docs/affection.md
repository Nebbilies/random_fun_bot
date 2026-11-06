# Affection and soulmate commands

Use your server’s configured bot prefix wherever `{prefix}` appears below. These are traditional message commands, not slash commands.

| Command | Purpose |
| --- | --- |
| `{prefix}affection` / `{prefix}aff` | Your affection overview, current soulmate, effective normal harem bonuses and pending item status |
| `{prefix}affection @player` | Another player’s read-only server profile |
| `{prefix}affection <name or #rank> [@player]` | One relationship’s saved progress; defaults to your relationship, not the current character owner |
| `{prefix}soulmate` / `{prefix}sm` | Your current soulmate, active perks and switching availability |
| `{prefix}soulmate <name or #rank>` | Find a character, choose if ambiguous, then explicitly confirm or cancel |

Character lookup includes native names and curated aliases. Ranks resolve to a permanent character identity when the prompt opens: a later rank change cannot redirect that confirmation.

## Reading the cards

The overview shows five relationships per page, descending by affection with deterministic name/identity ties. Owned characters with zero progress are included. Previous/Next and Owned/Former controls are read-only and restricted to the command author. The viewed player is fixed for the lifetime of the controls.

Each heart amount is that character relationship’s affection, not a spendable balance or a summed player score. The meter measures the interval since the previous applicable reward, not progress toward the lifetime maximum. Regular cards show the next normal milestone. The selected soulmate uses the union of normal and soulmate checkpoints, including every reward tied at the next threshold. At maximum, cards show “All current rewards unlocked” without an invented next reward.

Active soulmate cards are gold with always-visible active perk descriptions. Regular cards are pink and omit inactive soulmate perk details. Both use the original portrait thumbnail when available; Discord determines its displayed dimensions. Former relationships retain progress but grant no active normal benefits. A never-owned relationship is labeled “Not in your harem,” not former ownership.

Own-character roll appearances stay pink and omit wishlist announcements and mentions. Affection profiles omit zero-value normal bonuses and empty pending-reward sections; progress shows one meter and the next reward without a repeated remaining amount.

Earning feedback uses `❤️ **+20** affection` and separate `🔓` lines for item reward counts, normal passive unlocks, and soulmate perk unlocks or upgrades. Reclaims, including Golden Whistle reclaims, show their actual earned amount and publish milestone items for both recipients immediately. Escape-card updates combine gains for the same player and character, with player labels and other affected characters' names to distinguish recipients. Switching soulmates between appearance and reclaim leaves separate character groups. Checkpoint announcements describe the triggering award rather than the player's later soulmate selection.

Successful perk effects receive concise notices: Windfall saves the roll cost, Unbroken Bond labels a doubled gain, Claim Conservation saves the claim, and Item Conservation saves the source item charge. Fortune's Favor identifies the actual tier upgrade; an Echo copy is labeled separately. Milestone item cards are labeled “Affection reward.” These notices read saved outcomes and never reroll or repeat an award.

The overview’s normal harem bonuses are your effective whole-harem benefits, not the sum of the visible page. A detail card’s normal contribution belongs only to that character. Normal contributions require current ownership; their mechanical limits remain +5 hourly rolls and 60 minutes of claim-wait reduction across your harem.

## Selection and safety

Soulmate selection requires current ownership and a nonbusy character. Initial selection and each switch start a 12-hour cooldown. Losing ownership clears the selection; a replacement can be chosen without waiting out the old deadline. Reacquisition does not automatically select a soulmate. Selecting the already-active character only displays status and does not restart the cooldown.

Confirmation rechecks ownership, availability, cooldown, maintenance restrictions and the expected prior selection. Stale prompts cannot silently overwrite a newer choice. Cancelled or expired controls do not change selection. Status remains inspectable during maintenance; new selections are blocked.

Selection previews explain known ownership, busy-state, or cooldown blockers before confirmation and disable the confirm button while blocked. Switching previews name the soulmate whose active perks will be replaced. Switching availability appears in the card body so Discord can render its relative timestamp.

Opening your own profile retries owed milestone-item selection against the current eligible pool, even at maximum affection. Earned items use the existing reward delivery and pending-item dialogs; there is no separate affection claim button. Public profiles and all paging/filter interactions are pure reads and cannot select or deliver someone else’s rewards.

New rolls grant 100 affection for your own character's appearance, and indirect soulmate affection of 12/10/5 for a shared franchise. Shared genres and missing genre metadata grant no affection. Successful owner reclaims grant 20. On ordinary rolls captured with the soulmate-reclaim feature marker, a successful manual or Golden Whistle reclaim also grants the original roller's current, owned soulmate 8 base affection, regardless of franchise. That bonus stacks with appearance affection, uses the roller's current Unbroken Bond chance, and can unlock normal milestones and soulmate checkpoints. Having no eligible soulmate at reclaim grants no roller bonus. Siren's Call and pre-feature rolls do not qualify. Existing rolls retain their saved earning rules during recovery; no historical bonuses are backfilled.

Affection starts at zero without historical backfill, persists after ownership loss and caps at 2,100. There are no numbered levels, XP, reward-path pages or automatic soulmate selections. See [the design](affection-design.md) for the full earning rules, reward tables and perk exclusions.

Native portrait rendering and desktop/mobile spacing require separate live Discord acceptance; payload tests do not prove client appearance.
