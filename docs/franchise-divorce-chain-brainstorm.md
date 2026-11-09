# Franchise divorce chain: brainstorm

Status: Brainstorm completed; design and implementation approved. Implemented and verified on feat/threadbreaker.

## Confirmed requirements

- Add a Legendary item with one charge.
- The user chooses a franchise.
- Traverse owned characters from highest numeric rank to lowest numeric rank.
- Compare each character's owner with the preceding character's original owner, using ownership before the activation's divorces.
- Divorce the first character and each character whose original owner differs from the preceding character's original owner.
- When consecutive original owners match, the current character has a configurable chance of divorce, defaulting to 50%. The user added web configurability after approving the initial design.
- If that character survives, end the entire chain; all later characters remain untouched.
- Include all stored owners in the activating Discord server, including the activator and departed members.
- Exclude permanently locked characters entirely, including from preceding-owner comparisons.
- Bypass Negation, Shield, and Crown, following the existing mass-effect policy.
- Use effective franchise membership, including anime-derived and directly curated memberships.
- Keep confirmation information brief.
- Announce activation in Grand Masquerade's style.
- Provide anticipation of individual character outcomes with three-second pacing.
- Reveal each visited character on a separate suspense card, wait three seconds, then edit that card with the committed divorce or survival verdict. Wait three seconds before the next character.
- After a spared character, send a separate message containing exactly `## The chain ended!`.
- Settle gameplay atomically before the reveal; presentation never rerolls outcomes.
- Use the normal Legendary reward pool and discovery behavior.
- Cancelled, expired, and empty-target actions spend nothing. Successful actions use existing Item Conservation and atomic charge/divorce/replay rules.
- Final item name: Threadbreaker.
- Snapshot at confirmation; send the same ending message on natural exhaustion; schedule long reveals independently so unrelated delivery can continue.
- Use the engineering framework. This interview is the Brainstorm phase. Obtain approval between Design Proposal and Implementation Plan; self-review both documents.

## Open decisions

No unresolved gameplay or presentation decisions. Implementation Plan and test boundaries await approval.

## Existing behavior to consider

- Kaimetsu provides a confirmed, atomic mass-divorce flow with durable outcomes and replay protection in `lib/itemActions.js`.
- Kaimetsu excludes permanent ownership locks and bypasses Negation, Shield, and Crown. Targeted forced-divorce items use a different defense policy.
- Effective franchise membership is defined in `lib/characterFranchises.js`; `lib/franchiseLookup.js` provides franchise search and published-character lookup.
- Existing divorce cleanup handles conflicting escapes, trades, and Hostages. Kaimetsu-specific messages need appropriate wording for this item.
- Published catalog ranks are required, positive, and unique (`lib/catalogFinalSchema.js`); missing-rank and tied-rank rules are unnecessary.
- The existing activation system applies Item Conservation to charge spending, including mass effects.
- Grand Masquerade announces activation with a heading naming the user and item, then sends alternating suspense and character-card messages three seconds apart (`lib/masqueradeReveal.js`). Its outcomes are committed before delivery, and reveal progress is saved.

Acquisition and activation proposals were accepted during the interview and design approval.
