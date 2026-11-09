# Franchise divorce chain: design proposal

Status: Approved and implemented on feat/threadbreaker.

Approved name: **Threadbreaker**. Stable item ID: `threadbreaker`.

## Outcome

Add a one-charge Legendary item that targets a franchise in the activating Discord server. Divorce characters from the highest numeric rank upward until a same-owner character survives its configurable divorce check (50% by default). Reveal the committed sequence with suspense cards and three-second pauses.

## Item description

Default description:

> Choose a franchise. Starting with the **highest rank *number***, divorce each owned character. Consecutive characters with the same owner instead have a 50% chance of divorce. The first spared character ends the chain. Permanently locked characters are skipped.

The resolved description must display the current configured percentage rather than always saying 50%.

## Web configuration

The user additionally requires the same-owner divorce probability to be configurable on the existing web configuration portal. Default: 50%; allowed range: 0–100%, inclusive. Reuse percentage inputs and existing global/guild configuration behavior. Store the probability as `itemEffects.threadbreaker.divorceChance` in the existing 0–1 probability convention, with a default of `0.5`.

Capture the effective chance with the ownership snapshot at accepted confirmation, then save it with the committed result. Later configuration edits must not change or reroll an already settled chain. Only same-owner checks use this setting; the first character and owner transitions remain guaranteed divorces. At 0%, the first same-owner character always survives; at 100%, every eligible character divorces.

## Selection and confirmation

Use existing prefix commands and inventory activation controls. Reuse franchise lookup and effective franchise membership, including direct curated and anime-derived memberships. Ambiguous franchise queries require an explicit choice rather than silently choosing the first match.

Only the holder may select and confirm. Keep confirmation brief:

> Use **Threadbreaker** on **Naruto**? Your characters can be affected too.
>
> Confirm · Cancel

At accepted confirmation, read current ownership, ranks, effective membership, and permanent locks in the same transaction that settles the effect. Do not reserve or freeze an entire franchise during the confirmation window.

## Chain rules

1. Select the chosen franchise's currently owned, published characters in this server, including the activator's and departed members' characters.
2. Exclude permanently locked characters entirely. They neither receive a verdict nor affect owner adjacency. Unowned characters are also absent from the chain.
3. Sort by descending numeric rank. Published ranks are positive, required, and unique.
4. Save original ownership for all eligible characters before any divorce.
5. Divorce the first eligible character without a random check.
6. For each later character, compare its original owner to the immediately preceding eligible character's original owner.
7. Different owners mean guaranteed divorce. Equal owners mean a fresh, independent divorce check using the configured probability (50% by default).
8. A divorce continues the chain. Survival ends the entire chain immediately, including processing of later owners.

Negation, Shield, Crown, temporary protection, and busy status grant no immunity. Do not spend defensive charges for this effect. Follow existing ordinary cleanup of invalid defense state.

Examples, in processing order:

- `Alice, Bob, Carol`: all divorce; no 50% checks occur.
- `Alice, Alice, Bob`: the first Alice character divorces; if the second survives, Bob remains untouched. If the second divorces, Bob is guaranteed to divorce.
- `Alice, locked Bob, Alice`: remove locked Bob from eligibility; the second Alice character receives the 50% check.
- One eligible character: guaranteed divorce, then natural exhaustion.
- No eligible characters: no effect and no charge.

## Acquisition and consistency

Use the normal Legendary reward pool and existing permanent guild discovery. Legendary tier odds stay unchanged; adding this item changes the within-tier distribution.

Successful use spends one charge unless Item Conservation activates. Cancelled, expired, invalid, or empty-target uses spend nothing. Reuse the durable action boundary for source reservation, holder authorization, confirmation expiry, and replay protection.

Commit divorces, charge payment, ownership-loss recording, persistent interaction cleanup, and the complete ordered outcome trace atomically. Apply in-memory interaction cleanup only after commit, following the existing mass-divorce pattern. Only divorced characters lose conflicting escapes, trades, gifts, or Hostage interactions; surviving and unvisited characters retain theirs. Cancellation wording must name this item rather than Kaimetsu.

Save visited character identities, original owners and ranks, and each verdict. Include the first spared character and the termination reason; do not fabricate verdicts for unvisited characters. Repeated confirmation or recovery uses the saved outcome and never rerolls or repeats gameplay changes.

## Public reveal

Follow Grand Masquerade's activation style, using the final approved name:

> # @Player has used Threadbreaker! 🥀
> **Franchise:** Naruto

Suppress actual mention notifications as existing reveal components do.

After the announcement:

1. Wait three seconds, then send the first visited character's Components V2 card. Reuse existing card presentation with a concise suspense footer such as `Their bond hangs by a thread…`.
2. Wait three seconds, then edit that same card to show `💔 Divorced` or `✨ Spared. The chain ends.`
3. If divorced and another visited character exists, wait three seconds before sending that next character's suspense card. Repeat.
4. After a spared verdict, send a separate message containing exactly `## The chain ended!`. No later character card is sent.

Natural-exhaustion behavior: send the same separate ending message after the final divorce. This provides a clear end when no character survives, without extra summaries or a full duplicate divorce list.

The pauses reveal historical outcomes. All divorces already occurred at confirmation; reveals must not imply current ownership is frozen. Use the saved original owner and rank when presenting the chain; normal catalog image and franchise rendering may reuse existing presentation helpers.

## Delivery and recovery

Persist the current character index, suspense/verdict stage, current card message ID, and ending-message progress. Edits should be retry-safe; if a card was deleted, recreate the appropriate saved stage. Retain earlier characters' verdict cards in the channel.

A long franchise can generate many cards and take minutes. Do not cap the chain or accelerate it without changing the agreed gameplay/presentation contract. Instead, let each action's reveal progress independently with at most one active publisher per action, allowing unrelated item delivery and recovery to continue. The user approved this scheduling adjustment; the existing recovery loop awaits complete reveals serially.

Sending a new Discord message and saving its ID are not atomic. A crash between those operations can duplicate a presentation message, as with existing separate-message reveals. Reuse supported delivery deduplication if available during implementation; do not promise exactly-once Discord delivery. Gameplay and charge spending must still occur once.

Extend existing action-kind, identity-snapshot, and migration validators wherever they enumerate action/result/reveal shapes. No new dependencies or standalone scheduler framework are proposed.

## Alternatives considered

- **Resolve gameplay during each pause:** rejected by the user in favor of atomic settlement before reveal. Avoids live ownership changes altering the chain mid-animation.
- **Separate suspense and verdict messages:** not selected; editing each character's card keeps the chosen presentation with fewer messages.
- **Reuse one card for every character:** not selected; the user chose separate character cards whose suspense changes to a verdict.
- **Await the entire reveal in the serial recovery sweep:** not recommended because long chains can delay unrelated action deliveries.

## Verification acceptance

- Descending rank, original-owner adjacency, independent configured-probability checks, guaranteed owner transitions, and complete early stopping.
- Web percentage setting: 50% default, inclusive 0% and 100% boundaries, invalid-value rejection, global/guild behavior, dynamic item description, and unchanged settled outcomes after configuration edits.
- Guild isolation, activator/departed-owner inclusion, effective membership, unowned omission, and lock exclusion from adjacency.
- Defense bypass, no defensive payment, and cleanup limited to actually divorced characters.
- Empty/cancelled/expired actions, Item Conservation, rollback, duplicate confirmation, and database-reopen replay.
- Brief holder-bound selection/confirmation, ambiguous franchise handling, and normal reward/discovery integration.
- Activation heading, three-second suspense/verdict pacing, verdict edits, separate exact ending message, and no unvisited cards.
- Delivery recovery from each saved stage without rerolling or repeated ownership changes; unrelated actions progress during long reveals.
- Relevant migration/identity validators recognize the new saved action shapes.

## Self-review

Phase 2 self-review: passed for internal consistency against confirmed interview answers and inspected repository behavior. The user approved this design, including confirmation-time snapshotting, the natural-exhaustion message, and independent scheduling, and selected Threadbreaker as the final name. Implementation and validation are complete; see threadbreaker-validation.md.
