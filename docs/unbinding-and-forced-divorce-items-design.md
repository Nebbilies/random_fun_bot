# Unbinding and next-married-roll items

Status: implemented on `feat/unbinding-and-cupids-misfire`, based on updated `main` at `870d5ac`. The rules below capture the confirmed design; implementation and verification notes follow.

## Confirmed rules

- Add a Legendary item named **Shackles of Liberation** that removes a character's soulbind without changing their ownership. It does not divorce or transfer the character.
- The Legendary can target any currently owned, soulbound character in the same server, including the user's own, without the owner's consent. The user selects the exact character and confirms before spending the item. Targets without a soulbind are rejected without cost. Unbinding grants no priority to roll, divorce, or marry the character afterward.
- Legendary unbinding bypasses Mirror Shield, Counterfeit Crown, and temporary theft protection without triggering or consuming those defenses.
- An owner may immediately soulbind the character again by spending another Aegis of Fidelity. Unbinding adds no cooldown or lasting vulnerability.
- Add a Rare item named **Cupid's Misfire** whose effect forcibly divorces the next married character its user rolls. Divorce leaves the character unowned; it does not automatically award ownership to the item user.
- The Rare effect can trigger on the user's own married character, divorcing them too. Unmarried character rolls leave the effect waiting.
- A successful Rare divorce replaces the escape attempt with a normal public marriage opportunity on that same roll. The roller and former owner may participate under normal claim rules. There is no owner-only reclaim window or free reclaim, and Golden Whistle cannot undo the divorce.
- When the Rare effect targets another player's character, Mirror Shield blocks the divorce and consumes one Shield charge and the armed Rare effect. The roll then proceeds as a normal escape attempt. The user's own Mirror Shield does not protect against their own Rare effect.
- The Rare effect ignores Counterfeit Crown and temporary theft protection without triggering or consuming them as defenses. The rolled character remains the target; there is no decoy substitution. Normal soulbound exclusions from ordinary rolls remain in force. Normal ownership-loss cleanup still applies, including invalidating a Crown whose decoy is divorced.
- The Rare is manually activated through the existing prefix item-use command, spending one inventory charge to arm one server-scoped effect for the user. Only one may be armed at a time; duplicate activation is rejected without cost.
- The armed Rare effect survives restarts and has no countdown. Unmarried rolls, vaults, pranks, and mystery events do not spend it. Successful divorce or Mirror Shield interception consumes the armed effect.

## Shared eligibility

- Neither effect interrupts a live escape attempt, pending trade/gift, or another item's reserved challenge.
- Legendary use on a busy character is rejected without cost.
- If a selected Rare target cannot safely be divorced, the armed effect remains waiting and no Shield charge is spent.
- Eligibility and the exact current ownership are rechecked when committing, preventing stale selections from affecting a different marriage.

## Roll commitment and recovery

- Commit Rare divorce, armed-effect consumption, applicable Shield consumption, and the resulting roll atomically and exactly once.
- Failed Discord delivery retries the same committed result without rerolling, repeating divorce, or spending extra charges.
- A successfully divorced result remains a normal public claim roll and does not enter the mystery-event gate.
- Existing character-selection buffs continue to choose the character normally. The Rare effect does not increase the chance of rolling a married character.

## Roster integration

- Both items have one charge by default and use the existing inventory, rarity-based expiry, guild discovery, and reward systems.
- Inventory expiry does not cancel Cupid's Misfire after its charge has been spent to arm the effect.

## Card presentation

Use one Components V2 roll message, not a separate divorce announcement plus a duplicate character card. Preserve the normal character name, series, rank, likes, image, remaining-roll count, report controls, wishlist line, and normal marriage interaction.

### Successful divorce

Place this notice above the character card:

> 💔 **Cupid's Misfire**
> **[Character]** has been forcibly divorced from @FormerOwner.
> Anyone with an available claim can marry them now—including their former owner.

- Do not call this an escape or show an owner-only reclaim countdown.
- Preserve the divorce notice after a subsequent marriage so the cause of the ownership loss remains visible.
- On self-targeting, name the roller as the former owner; the same claim rules apply.
- Preserve existing wishlist presentation and accent precedence rather than introducing an unrelated card style.

### Mirror Shield interception

Place this notice above the normal escape notice and character card:

> 🛡️ **Cupid's Misfire blocked**
> @Owner's **Mirror Shield** prevented the divorce. One Shield charge and your Cupid's Misfire effect were consumed.

The normal escape rules, reclaim window, and Golden Whistle behavior apply to this blocked result. They do not apply to a successful divorce.

### Owner notification

Ping the former owner once when the successful divorce card is initially published. Do not ping them again on edits, subsequent marriage/expiry updates, or recovery of an already-published card. Coordinate with existing escape notifications on Shield-blocked results so the owner is not pinged twice by the same card. Use explicit allowed mentions.

## Implementation steps

### 1. Confirm repository contracts and test seams

- Inspect the current item modules, action runtime, roll reservation/delivery pipeline, and tests before editing. Follow current code where older design docs disagree.
- Use existing prefix commands, not slash commands. Use the durable selection/confirmation flow for Legendary targeting rather than choosing the first substring match.
- Proposed stable IDs: `shackles_of_liberation` and `cupids_misfire`; verify naming conventions before adding them.

### 2. Register both items

Relevant paths: `lib/items/index.js`, `lib/itemRoster.js`, `lib/gameConfigSchema.js`, `lib/itemRuntimeConfig.js`, and the existing release/discovery infrastructure.

- Add item modules for both items and register their names, descriptions, rarity membership, and one-charge defaults.
- Include them in existing reward eligibility, inventory, guild discovery, rarity filters, and configuration validation using the established contracts. Do not change tier weights.
- Add a release entry through `lib/itemReleases.js` if required by the current release convention, retaining undiscovered-name masking.
- Describe Cupid's Misfire's self-divorce risk and Shield interaction clearly in player-facing help.

### 3. Implement Shackles of Liberation

Relevant paths: `lib/itemActivation.js`, `lib/itemActions.js`, `lib/itemActionRuntime.js`, `lib/itemActionStorage.js`, `lib/itemStorage.js`.

- Offer exact selection of an owned, soulbound character in the current server, followed by confirmation.
- Revalidate current ownership, exact soulbind state, busy status, and inventory availability inside the commit transaction. Reject stale or invalid targets without cost.
- Remove only the qualifying soulbind lock, never blindly delete an unrelated temporary protection row. Consume one item charge atomically with successful removal.
- Bypass defense interception without spending Shield/Crown resources. Do not transfer or divorce the target, create ownership-loss history, or install a rebinding cooldown.
- Keep broad fixes to pre-existing stale soulbind locks after divorce outside this feature. Unowned characters are not valid targets for this item.

### 4. Implement Cupid's Misfire arming

Relevant paths: the new item module, `lib/itemActivation.js`, `lib/itemStorage.js` and its persisted buff contracts.

- Use a durable guild/user-scoped armed effect with no deadline. Arming and spending one inventory charge must be atomic.
- Reject duplicate arming without spending another charge, including concurrent attempts. Do not merge or queue additional uses.
- Persist any necessary rule snapshot using existing buff conventions. An armed effect is independent of its consumed inventory entry and survives restart or inventory expiry.

### 5. Resolve the Rare effect at roll commitment

Relevant paths: `lib/characterRolls.js`, `lib/characterMarriage.js`, `lib/characterAvailability.js`, `lib/itemDefense.js`.

- Preserve existing roll selection and selection-buff precedence. Do not force a married-character pool.
- After selection and current-marriage lookup, evaluate the armed effect before creating the normal escape outcome and before any unowned-result mystery routing.
- A target that is unowned or cannot safely be divorced leaves the effect armed, with no defense charge spent. Preserve normal safe roll handling; do not interrupt reserved interactions.
- Revalidate the exact marriage and busy state in the same transaction as outcome persistence.
- For another owner's character, resolve Mirror Shield first. On interception, spend one Shield charge and the armed effect, retain the marriage, and create the normal escape outcome.
- Otherwise, including self-targeting, delete the exact marriage through the shared safe ownership path, consume the armed effect, and create a normal unowned public claim roll. Skip escape creation, owner-only reclaim, and mystery routing for this successful outcome.
- Do not run Crown redirection or temporary theft-protection interception. Preserve normal ownership-loss history and Crown-decoy invalidation.
- Ensure ordinary claim allowances remain unchanged by divorce itself; a later marriage spends the applicable normal entitlement.

### 6. Persist and render the outcome

Relevant paths: roll storage/schema as needed, `lib/characterRollRuntime.js`, `lib/rollDelivery.js`, `lib/catalogRuntimeRecovery.js`.

- Persist sufficient immutable outcome metadata to reproduce the notice: effect result, rolled character, former owner, and interception details where applicable. Do not infer the former owner from current ownership during recovery.
- Extend the current card renderer to display the notices above without treating successful divorce as an escape.
- Retain the notice when the card is updated after marriage or expiry, under existing card-update conventions.
- A committed result is recoverable after send failure/restart. Never repeat divorce, reselect a character, or reconsume effects when delivering it again.
- Ping the former owner once on initial publication using explicit allowed mentions. Edits and recovery of an already-published card must not generate additional owner notifications.

### 7. Verify and document

Locate and extend the repository's existing test files and use its established runner. Add focused regression coverage before or alongside implementation:

- Roster/config validation, default charges, rarity, rewards, discovery masking, and inventory expiry integration.
- Legendary: own/other-owner success; exact target selection; no soulbind, unowned, stale ownership, busy target, canceled confirmation, or missing inventory rejected without cost.
- Legendary: Shield/Crown untouched, unrelated temporary locks preserved, ownership/history unchanged, immediate rebinding allowed, and concurrent attempts cannot spend twice for one soulbind.
- Rare: durable arming, concurrent duplicate rejection, correct server/user scope, no countdown, and survival after inventory expiry/restart.
- Rare: unmarried rolls, vaults, pranks, and mystery outcomes retain the effect; existing selection buffs and probabilities are unchanged.
- Rare: other-owner divorce and self-divorce; unavailable targets preserve both armed effect and Shield charge.
- Defenses: opposing Shield blocks and spends exactly one charge/effect; own Shield does not block; Crown never redirects; temporary theft protection does not prevent divorce; soulbound characters remain excluded.
- Outcome: successful divorce creates public claim availability, never escape or mystery; former owner has no free reclaim; Golden Whistle cannot rescue a successful divorce but retains normal behavior after Shield interception.
- Ownership cleanup/history: exact marriage deletion, Crown-decoy invalidation, Chronicle ownership-loss eligibility, and no claim reset/refund from divorce itself.
- Recovery/concurrency: transaction rollback, duplicate roll invocation, competing ownership actions, failed delivery, restart before/after publication, and replay cause no extra charge use or second divorce.
- Presentation: success, self-hit, Shield block, wishlist match, missing image, subsequent marriage/expiry, durable recovery, allowed mentions, and unchanged report controls.

Run focused tests first, then the normal full test/lint checks where available. Update item descriptions and relevant documentation to match the tested behavior.

## Notification delivery limitation

Discord publication and local acknowledgement cannot be committed atomically. Persist an owner-notification attempt marker before sending. The first attempt allows the owner ping; ambiguous retries suppress that owner's mention even if they also match a wish or an escape notice. This prevents repeat notifications after an accepted send whose response was lost, including outside Discord's nonce window. A genuinely failed first attempt can therefore result in a silently delivered retry rather than a guaranteed ping. Ownership and item effects remain exactly-once; Discord message delivery itself is best effort.

## Completion criteria

- Both items are fully integrated and their behavior matches the confirmed rules above.
- The former owner is pinged once on initial publication, without repeat pings on updates or recovery of an already-published card.
- Tests demonstrate atomic, replay-safe effects and correct claim/escape distinctions.
- No unrelated protection-lifecycle changes or slash commands are introduced.

## Implementation notes

- Item IDs are `shackles_of_liberation` and `cupids_misfire`.
- Shackles uses the existing durable item-action picker and confirmation with exact marriage snapshots.
- Cupid's Misfire uses the existing persisted user-buff storage. Its roll outcome and owner-notification attempt marker extend existing `rules_json`; no new schema migration is required.
- Both items are registered in configuration, rewards, discovery, and the 02/11/2026 item release.
- Existing unrelated glossary edits and untracked local files are intentionally not included in feature commits.

## Verification

- `npm test`: 1,528 tests, 1,527 passing, 1 skipped, 0 failures.
- `npm run typecheck:catalog`: passed.
- `git diff --check` and syntax checks for the changed effect/action modules: passed.
- Focused tests cover exact unbinding selection and revalidation, defense bypass, self-divorce, opposing Shield interception, ordinary claim costs, buff persistence, atomic rollback, durable delivery, discovery/config/expiry integration, and ambiguous-send notification suppression.
- Read-only review identified the send-before-ack notification edge case; the persisted at-most-once notification-attempt marker and regression test address it, subject to the delivery limitation above.

## Existing mechanics relevant to the design

- Aegis of Fidelity supplies permanent soulbinding; ordinary character rolls exclude soulbound characters.
- An ordinary married-character roll starts an escape attempt while retaining the original marriage. Forced divorce must be distinct from this outcome.
- Character ownership is server-scoped.
