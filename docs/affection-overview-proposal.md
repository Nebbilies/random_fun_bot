# `affection` overview — proposed display

Status: overview presentation proposal revised with the user's requested simplifications: remove the visible sort-order description, use a heart icon rather than the word "affection" in each relationship row, and omit cap values from the bonus summary. Single-character non-soulmate cards now omit the inactive soulmate-perk section for brevity. The user approved warm gold #F2C66D as the special accent for active soulmate cards. Sorting and mechanical bonus caps are unchanged. Paging/filter defaults remain proposed unless separately approved. The selected `soulmate` layout is a standard rich embed with always-visible active perks; no bot code or implementation authorization.

## Proposed purpose and format

`{prefix}affection` / `{prefix}aff` is a collection overview, not another full soulmate card. One standard rich embed plus legacy Previous/Next and Owned/Former navigation buttons. No `IS_COMPONENTS_V2`, no reward path, no numbered levels, no summed player affection score.

Proposed navigation defaults (not approved yet):

- Show currently owned characters, highest affection first, deterministic name/identity tie-break. Do not display "highest affection first" in the message; the section heading is simply `Owned characters` (or `Former characters`).
- Five relationships per page; include current owned characters with zero affection at the end.
- Mark the selected soulmate with `♡`; do not repeat the active soulmate perk description list in the collection overview.
- A `Former characters` button changes the same read-only list to saved former-ownership relationships; label these as inactive for benefits. It changes back to `Owned characters` in that view.
- Keep current soulmate and **whole-harem normal bonus** summary at the top in either list; it is not a sum of visible-row bonuses or a per-character contribution. Show only the effective bonuses, not their cap values. The +5 roll and 60-minute limits still apply mechanically.
- Use `♥ 820`-style affection amounts in relationship rows instead of repeating `820 affection`. Retain `♡` on the selected soulmate's name as a separate selection marker; totals are still affection, not another resource.
- Display pending/owed reward status, using already-approved recovery/delivery and existing pending-item dialogs. Public profile viewers get no mutation authority.
- Navigation changes only the viewed list/page, never selection, affection, rewards, or ownership. A public viewer must not cause another player's owed-item selection.

## Exact illustrative state

Eight currently owned characters: Rem 820, Mikasa Ackerman 760, Marin Kitagawa 640 (selected soulmate), Yor Forger 380, Rukia Kuchiki 80, and Anya Forger/Aqua/Violet Evergarden at zero. Three saved former relationships are available in the prototype. These are not live records.

Four owned characters have affection >=200, so normal extra roll capacity is +4, capped at +5. Two have >=700, so normal claim-wait reduction is 12 minutes, capped at 60. No pending reward in this example.

## Exact first-page reply

Pink accent `0xe91e63`, standard embed, no large gallery. The owner avatar may be an ordinary embed author icon; no character portrait is required for the multi-character overview.

```text
TITLE: ♡ Neb's affection
DESCRIPTION: Soulmate: ♡ Marin Kitagawa · ♥ 640

Normal harem bonuses
+4 hourly rolls
12 min less claim waiting

Owned characters

Rem · ♥ 820
▰▰▱▱▱▱▱▱▱▱  20 / 100
Next: Franchise Passport at 900 · 80 to go

Mikasa Ackerman · ♥ 760
▰▰▰▰▰▰▱▱▱▱  60 / 100
Next: Random Rare at 800 · 40 to go

♡ Marin Kitagawa · ♥ 640
▰▰▰▰▱▱▱▱▱▱  40 / 100
Next at 700: Negation 8% + six-minute claim-wait contribution
60 to go

Yor Forger · ♥ 380
▰▰▰▰▰▰▰▰▱▱  80 / 100
Next: Random Rare at 400 · 20 to go

Rukia Kuchiki · ♥ 80
▰▰▰▰▰▰▱▱▱▱  30 / 50
Next: Random Common at 100 · 20 to go

Pending item rewards: none
FOOTER: Page 1 of 2 · 8 owned · !aff <name or #rank> for details

[Previous — disabled] [Next] [Former characters]
```

Each meter shows interval progress since the last applicable reward, not percentage of the lifetime cap. Active soulmate uses the earliest upcoming normal/soulmate reward and lists both when tied. Non-soulmates use the next normal reward, without claiming their inactive soulmate checkpoints are active. At cap show `All current rewards unlocked` and no fabricated next threshold.

## Single-character detail — shortened layout; color proposal pending

The accepted `{prefix}affection <name or #rank> [@player]` grammar opens one player's saved relationship with that character, never the character owner's progress by default and never a selection action. Proposed example command: `!affection Rem`; standard rich embed with pink accent and original portrait thumbnail, not a V2 square thumbnail. No buttons, reward path, levels, or cap text.

Illustrative sample: Neb owns Rem at 820 affection, but Marin remains the selected soulmate. Rem's two normal contributions are active. The user chose to hide the inactive soulmate-perk section entirely for a shorter card, not display locked/inactive rates or an activation explanation. Native Discord controls thumbnail dimensions.

```text
AUTHOR: ♡ Neb's affection
TITLE: Rem
DESCRIPTION: Re:ZERO -Starting Life in Another World-
THUMBNAIL: Original character portrait

♥ 820 · 80 to go
▰▰▱▱▱▱▱▱▱▱  20 / 100 to next reward

Next at 900
Franchise Passport

Normal bonuses
+1 hourly roll · 6 min less claim waiting

FOOTER: !sm Rem to select · !aff for all affection
```

`Normal bonuses` describes this character's contribution, not the player's combined harem bonus. Existing mechanical caps still apply. No duplicate "Currently owned" label is needed in this owned sample. Do not imply that soulmate perks are active merely because thresholds have been earned; omit the section unless this is the active soulmate. The generic public profile still labels former ownership explicitly.

Proposed state handling:

- **Selected soulmate:** use the accepted soulmate-style card, including always-visible active-perk descriptions, earliest upcoming reward across both tracks, and selection cooldown. Distinguish its accent from regular affection pink using the approved warm gold `0xF2C66D`. This also applies when the active soulmate is viewed through `affection <character>`.
- **Owned, not selected:** the shortened sample above with regular pink `0xe91e63`; meter uses next normal milestone. Hide the inactive soulmate-perk list and explanation entirely. The footer is only a command hint, not an automatic selection; it still opens normal confirmation and obeys cooldown/busy checks.
- **Former ownership:** explicitly show `Former ownership · saved progress`, mark normal bonuses inactive, hide the soulmate-perk section, and omit the selection hint while unowned. Keep saved affection and the next normal reward visible as future progress, not a claim of current earning eligibility.
- **Never owned/no progress:** show zero affection and no active benefits, with a clear `Not in your harem` state rather than mislabeling it as former ownership.
- **Someone else's relationship:** the author identifies the requested player; never show a caller-specific selection action/hint for that player's relationship. Viewing another player's detail cannot retry/select their owed items.
- **No earned soulmate perks:** only the selected soulmate's card may show `No soulmate perks unlocked yet.` Non-soulmate cards omit the section entirely.
- **Pending rewards:** show an extra concise pending-item line only when there are earned owed/pending items for this relationship, using the approved existing pending-item flow and owner-only retries.
- **At cap:** show `♥ 2,100 · All current rewards unlocked`, without a next target or zero-width interval.

The user approved hiding inactive soulmate details and the distinct active-soulmate warm-gold accent `0xF2C66D`. This is documentation and a visual mockup, not an implemented renderer.

## Empty and public states

- No owned characters: show existing soulmate/no-selection status, zero normal bonuses, and `No characters in your harem.` Offer the Former filter only if saved former relationships exist.
- Former list empty: `No saved affection from former ownership.` No invented progress.
- Public profile: replace owner name/summary correctly; read-only paging only. No reward collection or selection changes.
- Arbitrarily large harem: bounded pages rather than one huge embed; standard embed text/field limits still apply. Native client wrapping is authoritative.
- No aggregate affection currency or total across characters. Each relationship retains its own total.

Prototype is an HTML approximation of a native embed plus legacy action row, not a live Discord screenshot. The mock's list switching is local demonstration only. It does not award or spend anything.
