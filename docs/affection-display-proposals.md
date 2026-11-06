# `soulmate` reply — three display proposals

Status: the user selected Option 3's layout with revisions: omit "Currently owned", always show the active perk descriptions, and remove the bottom perk count and expand/collapse button. A standard rich embed is the recommended rendering for the requested portrait thumbnail behavior; see revised Option 3 below. No bot/UI implementation or overall implementation approval. Other options remain comparison history. Prefix `!` is illustrative; use the configured guild prefix.

## Shared example state

- Player: Neb. Selected and owned soulmate: Marin Kitagawa, My Dress-Up Darling.
- Affection: 640. Previous reward threshold: 600; next threshold: 700. Meter is **40/100 in the current interval**, not 640/700 or progress toward the 2,100 cap.
- At 700 the same relationship unlocks **both** Negation 8% and a normal six-minute claim-wait contribution while owned.
- Active soulmate perks: Windfall 10%, Item Conservation 16%, Unbroken Bond 16%, Claim Conservation 8%, Fortune's Favor 8%. Negation and Echo are not active yet.
- Marin currently contributes +1 hourly roll capacity and zero minutes of claim-wait reduction. Contribution is not the player's whole-harem bonus; the existing +5/60-minute caps still apply.
- Selection cooldown remaining: three hours. All data is illustrative; these are not live database values. Artwork in the visual comparison is a labeled placeholder.

## Option 1 — Quick glance (native embed)

Pink accent `0xe91e63`, right-side character thumbnail, no buttons. Exact text:

```text
AUTHOR: Neb's soulmate
TITLE: ♡ Marin Kitagawa
DESCRIPTION: My Dress-Up Darling · Currently owned

Affection
640 affection
▰▰▰▰▱▱▱▱▱▱  40 / 100 to next reward
60 affection to go

Next at 700
Negation 8% + six-minute claim-wait contribution

Active soulmate perks
Windfall 10% · Item Conservation 16% · Unbroken Bond 16%
Claim Conservation 8% · Fortune's Favor 8%

Normal contribution
+1 hourly roll · 0 min claim-wait reduction

FOOTER: Switch available in 3 hours · !aff for all affection
```

Use ordinary embed fields and footer; the meter is monospace text, not an unsupported Discord progress widget. Best for repeated status checks.

## Option 2 — Character-first (Components V2)

Pink-accent Container with TextDisplay heading, MediaGallery for existing character artwork, Separator, compact affection/meter text, next rewards, Separator, and readable perk descriptions. No buttons or reward path. Exact text:

```text
♡ Neb's soulmate
Marin Kitagawa
My Dress-Up Darling · Currently owned

[Character artwork]

640 affection · 60 to next reward
▰▰▰▰▱▱▱▱▱▱  40 / 100

Next at 700
Negation — 8% chance to block an eligible attack.
Normal bonus — contributes 6 min less claim waiting while owned.

Active soulmate perks
Windfall · 10% — make a qualifying roll free.
Item Conservation · 16% — preserve an item's use charge.
Unbroken Bond · 16% — double a qualifying affection award.
Claim Conservation · 8% — preserve the marriage claim resource.
Fortune's Favor · 8% — upgrade an eligible item reward one tier.

Current normal contribution: +1 hourly roll; 0 min claim reduction.
Switch available in 3 hours · !aff for all affection
```

Keep artwork at its available aspect ratio; the prototype's labeled image rectangle is illustrative, not a promised fixed crop. Best if the selected character and its artwork should dominate the message.

## Option 3 — selected layout, revised to always-visible perks

The original mock used Components V2. The user selected its compact layout with these changes: no "Currently owned" line, always-expanded active soulmate perks, and no bottom "5 soulmate perks active" count. There is consequently no expand/collapse button.

Recommended rendering: one standard rich embed with a special active-soulmate accent, a normal embed thumbnail on the right, author/title/description, non-inline fields, and a footer. The user approved warm gold `0xF2C66D`, replacing this selected card's original pink. Regular affection cards remain pink `0xe91e63`. This does not require message components at all. If other controls are needed later, legacy Action Rows can accompany embeds; do not set `IS_COMPONENTS_V2` or mix V2 Container/Section components into this reply.

Exact revised sample:

```text
AUTHOR: ♡ Neb's soulmate
TITLE: Marin Kitagawa
DESCRIPTION: My Dress-Up Darling
THUMBNAIL: Original character portrait, not square-cropped by the bot

Affection
640 affection · 60 to go
▰▰▰▰▱▱▱▱▱▱  40 / 100 to next reward

Next at 700
Negation 8% + six-minute claim-wait contribution

Active soulmate perks
Windfall · 10% — make a qualifying roll free.
Item Conservation · 16% — preserve an item's use charge.
Unbroken Bond · 16% — double a qualifying affection award.
Claim Conservation · 8% — preserve the marriage claim resource.
Fortune's Favor · 8% — upgrade an eligible item reward one tier.

Normal contribution
+1 hourly roll · 0 min claim-wait reduction

FOOTER: Switch available in 3 hours · !aff for all affection
```

Pass the original image URL/attachment to `EmbedBuilder.setThumbnail`; do not preprocess it to a square. A normal embed supports a portrait thumbnail in Discord's native embed layout, but client rendering controls the actual dimensions. Image width/height fields are not author-settable and the HTML approximation cannot guarantee pixel-identical Discord rendering. Confirm the non-square source image on desktop/mobile during eventual live UI acceptance. If missing, omit the thumbnail and retain the text.

The generic affection profile must still distinguish former ownership and active normal benefits as accepted. Non-soulmate character cards now hide the entire inactive soulmate-perk section for brevity; active soulmate cards retain the always-visible perk descriptions. The removal of redundant "Currently owned" wording applies to the active `soulmate` reply, whose selection already requires current ownership. The special soulmate accent also applies when that active character is viewed through `affection <character>`, not to unselected characters merely because they have unlocked checkpoint thresholds.

## Shared fallback states (all options)

- **No selection:** `No soulmate selected.` / `Choose a character you own with !soulmate <name or #rank>.` Do not show a meter for an invented character. Show the actual next eligible switching time only if relevant; ownership-loss replacement bypass remains intact.
- **Maximum affection:** `2,100 affection · All current rewards unlocked.` No next threshold, zero denominator, or post-cap reward path. Current perks/contribution and selection cooldown can remain.
- **At threshold:** apply committed awards/unlocks first, then point the meter to the next strictly greater threshold. For `soulmate`, next means the earliest upcoming reward across both normal and soulmate tracks; show all rewards at that threshold.
- **Images unavailable:** omit thumbnail/gallery, preserve all text, never fail the status command.
- **Long names/mobile:** use normal Discord text wrapping; do not depend on fixed-width column alignment.
- Rendered owner names/character text are escaped; user mentions do not ping. Any cooldown is an actual Discord timestamp in implementation, not the fixed mock value.

The revised Option 3 is the selected layout direction. Native rich embed rendering is recommended for the user's requested thumbnail behavior; the earlier three-option comparison remains historical. In-thread mockups are HTML approximations, not live Discord screenshots, and do not authorize the implementation phase.

Rendering references checked: [Discord message/embed structures and create-message limitations](https://docs.discord.com/developers/resources/message), and [Components V2 overview](https://docs.discord.com/developers/components/overview). Standard embeds are separate from the Components V1/V2 distinction; V2-flagged messages cannot include a traditional rich embed.
