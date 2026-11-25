# Centralized name search — revised implementation plan

Status: proposed; planning only. This replaces the earlier, broader nine-phase plan.

## Goal

Make typed character and franchise lookups more forgiving and relevant, using one shared matcher behind the existing lookup functions. Reuse the existing menus and command flows. This is a search improvement, not a UI, item-activation, or portal architecture rewrite.

## 1. Verification of the previous plan

### Menus: what is actually paginated

| Current UI                                     | Verified implementation                                                                           | Change needed for fuzzy search?                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Character chooser                              | `commands/char.js:37`: 25 options per page, Previous/Next and page jump                           | No; preserve it.                                                                                                             |
| Franchise chooser and franchise character list | `commands/utils/franchiseCommand.js:62`: separate 25-option / 15-character pages                  | No; preserve both.                                                                                                           |
| Affection / soulmate chooser                   | `lib/affectionPresentation.js:188`: 25 options per page                                           | No; preserve it.                                                                                                             |
| Divorce chooser                                | `commands/divorce.js:22`: 25 options per page                                                     | No; preserve it.                                                                                                             |
| Trade/give harem display                       | `lib/tradeRuntime.js:187`, `sendHarem`: paginated character list                                  | No; preserve it.                                                                                                             |
| Trade/give ambiguous-name dropdown             | `lib/tradeRuntime.js:239`, `sendCharacterPicker`: renders and accepts only `matches.slice(0, 25)` | Existing limitation; separate small follow-up, not a matcher prerequisite.                                                   |
| Wishlist name-match dropdown                   | `commands/wish.js:37,101`: renders and accepts only `wishes.slice(0, 25)`                         | Existing limitation; separate small follow-up. Wish addition searches the catalog, even though the user's wishlist is small. |
| Identity-based item action selectors           | `lib/itemActionRuntime.js`: Blood Pact, other target/cost selectors already paginate              | No; these are not typed-name lookups.                                                                                        |

The earlier pagination statement concerned the last two name-match dropdowns, not all menus. It was factually specific but unnecessarily promoted those existing limitations into a main phase of the fuzzy-search project. Do not rebuild already-paginated menus or treat pagination as part of the matching algorithm.

### What was overengineered or unsupported

Remove from the required implementation:

- Migrating all commands to a new `none / resolved / choose` result protocol. Existing array lengths already select the appropriate flow.
- Mandatory new confirmations for every prefix, word, substring, or folded match. That changes established UX rather than simply improving lookup.
- A best-result similarity margin of `0.08`, cross-class scoring calibration framework, and arbitrary performance release budgets. Those numbers had not been justified by measurements.
- Combinatorial query-token assignment and broad normalization changes before basic typo behavior is demonstrated.
- A new item preflight/continuation protocol involving receipts, inventory reservations, and activation callbacks.
- Mandatory conversion of every portal search, including moving a local browser filter to a new network endpoint.
- Extracting Clue Reveal's distance helper while preserving multiple legacy comparison modes. Answer validation is not entity lookup.
- Changing franchise exact-display-name versus exact-alias precedence, or expanding one-character behavior globally. Neither is required for this feature.
- A new curated-alias loading path across ownership/wish queries as a prerequisite. That inconsistency is real, but separate from matching the labels the caller already supplies.

Keep the useful core: shared matching, exact precedence, useful partial-name results, conservative typos, correct ambiguity, scope preservation, prepared-index reuse, and regression tests.

## 2. Required scope: highest-value existing gameplay lookups

Replace matching internals in these three functions:

| Function                                         | Callers improved automatically                                                    | Preserve                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `findCharacters` in `lib/gameCharacterLookup.js` | `char` / `im`, wish add, affection, soulmate, divorce, typed trade/give selection | Original rows, rank lookup, catalog versus owner scope.               |
| `matchWishes` in `lib/characterWishlist.js`      | `wish remove`                                                                     | Only the caller's existing wishes, including missing-catalog entries. |
| `findFranchises` in `lib/franchiseLookup.js`     | `ima`, `imar`, supported franchise modifiers                                      | Exact alias collisions and full/direct-only freshness modes.          |

Most commands should not need a structural change: they already handle no matches, one match, and multiple matches.

`commands/im.js` is a re-export and `lib/franchiseModifiers.js` parses flags; do not change them merely to list more migrated files.

### Other real lookup opportunities, not prerequisites

| Area verified in code                                        | Practical follow-up                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/itemActivation.js`: item-name exact/substring selection | Explicit shorthand and fuzzy suggestions could improve `use`, but do not silently spend an item on the nearest name. Duplicate copies of one type are not multiple name candidates. Keep this separate from core character/franchise work. |
| Aegis and Master Key                                         | They currently select the first SQL substring match among scoped marriages. Reuse shared target search only with explicit ambiguity handling; do not replace SQL `.get()` with fuzzy `[0]`.                                                |
| Franchise Passport and Wish Upon a Star                      | Shared franchise aliases/typo matching would help, but target acceptance must fit the current effect/cost flow first.                                                                                                                      |
| Blood Pact argument fallback                                 | It contains first-substring matching, but normal command activation uses paginated identity-based sacrifices. Do not redesign that normal menu for fuzzy search.                                                                           |
| Admin catalog/franchise search                               | Useful later consumers of the same helper. Preserve empty-query browsing, exact ID access, server pagination, option caps, and existing UI. No forced local-to-server search conversion.                                                   |
| Clue Reveal                                                  | Already has conservative typo acceptance. Leave its normalization, configured limits, ambiguity checks, timing, and private helper unchanged in this feature.                                                                              |

“Apply where useful” does not mean all lookup-related files must migrate in one release. Complete the main gameplay lookup improvement first, then select these follow-ups by concrete UX value and integration cost.

IDs, mentions, component values, command routing, external tags, and database identities always stay exact. No slash commands or schema changes.

## 3. Simple matching rules

### Preserve exact behavior

1. Keep character/wish `#rank` parsing ahead of name search.
2. Keep the existing NFKC, case, and whitespace normalization. Filter invalid alias values; do not invent transliterations.
3. For characters/wishes, exact full names still take precedence over exact aliases/native names.
4. For franchises, preserve the existing combined exact name/alias group; do not introduce new suppression of a shared exact alias.
5. Exact matches exclude weaker suggestions. Multiple distinct exact matches still open the existing chooser.
6. Preserve current minimum-query behavior and divorce's exact one-character exception. Any broader short-name support is a separate intentional change.

### Improve partial matching, not just misspellings

The current code returns the first nonempty prefix/substring tier and drops all weaker tiers. That can hide useful results:

```text
Names: Gojo Example; Satoru Gojo
Query: gojo
Current result: Gojo Example only
Desired result: both, because Gojo is a meaningful name word in each
```

Use a small, explicit match order after exact lookup:

1. **Word and word-prefix matches** across primary names and aliases. Combine meaningful partial matches instead of discarding surname matches when another full name begins with the query.
2. **Bounded typo matches** against a full name/alias or consecutive name words. This supports `Gojp` against the `Gojo` word in `Satoru Gojo`.
3. **Arbitrary substring matches** as a compatibility fallback, so existing intentional fragments such as `toru` remain usable when stronger evidence is absent.

Return the strongest available group. Within the meaningful-partial group, order whole-word matches before incomplete word prefixes; within typo matches, prefer fewer edits and then higher normalized similarity. Primary versus alias evidence is a tie-breaker after match quality, not a reason to hide other plausible partial matches.

Keep multiword matching simple: compare the query with consecutive words in one label, in order; account for every query word. Do not pool words from unrelated aliases or build a token-assignment optimizer. Numeric tokens must match exactly so sequel/version numbers are not treated as typos.

### Conservative typo limits

Starting policy, covered by explicit examples before integration:

| Shorter compared label/word-sequence length | Maximum edits |
| ------------------------------------------- | ------------- |
| 1–3 code points                             | 0             |
| 4–7                                         | 1             |
| 8+                                          | 2             |

Count insertion, deletion, substitution, and adjacent transposition. Require edit distance to be no more than 25% of the longer compared text as well. Use Unicode code points for the new distance calculation. Do not perform typo expansion on numeric-only query tokens.

These are simple acceptance limits, not a calibrated probability model. Adjust them only alongside expected-result tests. Reject weak input; do not always return the nearest name.

### Multiple matches stay simple

- Match each entity once, using its best matching label. Several matching aliases are not several characters.
- Every distinct entity passing the chosen match group's limits is a candidate.
- Zero candidates: current no-match response.
- One candidate: current single-result flow, subject to the narrow ownership-transfer rule below.
- Multiple candidates: current chooser, in relevance order.
- Use catalog rank/franchise ID/existing wish order only as deterministic tie-breakers. Do not use popularity, top-one selection, or menu limits to erase ambiguity.

No best-score gap or confidence percentage is needed for the initial version. A bounded candidate group and the existing chooser provide the disambiguation.

## 4. Small shared implementation; preserve current interfaces

Add `lib/nameSearch.js` containing pure normalization/preparation, word matching, bounded typo distance, and candidate ordering. Keep the distance implementation internal unless a second genuine caller needs it.

The existing lookup modules adapt their row labels to the matcher and continue returning their original arrays:

```js
findCharacters(characters, query); // original character/marriage rows
matchWishes(wishes, query); // original wish rows
findFranchises(franchises, query); // original franchise rows
```

Do not attach search scores to catalog rows or require a command-wide interface migration. Retain match kind internally; expose it through a small detailed helper only where a caller must distinguish a newly typo-corrected input from an existing literal match.

Reuse the current WeakMap/prepared snapshot mechanism. Immutable catalog snapshots are prepared once; live ownership and wishlist arrays use fresh values. Do not change `catalogCache` revision transactions, introduce query caches, or cache player eligibility.

Character identity differs by row: catalog `id`, marriage `characterId` (its `id` is a marriage ID), and wish `characterId`. Return the original object, retaining ownership/marriage identity for existing commit-time checks. Do not broaden the caller's input set to the full catalog.

## 5. Preserve flows; add only narrowly needed acceptance

- Keep all current chooser layouts, pagination, controls lifetime, permission checks, card/image navigation, and Components V2 presentation.
- Keep existing single-result behavior for exact and intentional literal partial matches. Do not require an extra click for normal prefixes or substrings.
- Wishlist changes are reversible and already show the updated list; do not add a mandatory confirmation system for this feature.
- Divorce and soulmate already display the selected target and require confirmation. Reuse that confirmation for typo-corrected results.
- For **new typo-only ownership-transfer matches**, ensure the player whose character was inferred accepts that identity: the trade initiator already sees a final confirmation; the trade recipient's counteroffer and a gift giver's offer need their own selection if inferred. Reuse the existing picker even for one corrected candidate in those two cases, rather than changing every command.
- If the trade picker is touched for that rule, invalidate an older picker when a new name query replaces it. Preserve exact selected IDs and existing live-session/ownership checks.
- After selection, never rerun the text query to choose an identity. Existing effects continue validating the captured identity.

The two unpaginated name-match dropdowns are separately verified follow-ups. If addressed in the same branch, add only local Previous/Next behavior and tests; do not introduce a universal chooser framework. Do not claim fixing these is what makes fuzzy search work. Never truncate a candidate set to manufacture a unique result.

## 6. Implementation steps and verification

### Step 1 — Shared matcher and examples

Implement/test the helper with examples for exact precedence, meaningful surname matches, prefixes, substitutions, swapped letters, aliases, native names, multiple plausible entities, numeric distinctions, malformed aliases, and unrelated input.

Specifically lock the desired `Gojo Example` / `Satoru Gojo` behavior; adding typo fallback alone would not fix the current partial-name suppression.

### Step 2 — Integrate the three lookup functions

Reuse prepared metadata, keep signatures/row shapes, and test prepared/unprepared equivalence. Preserve franchise freshness and caller-owned scopes. The existing callers get the search improvement without a UI rewrite.

### Step 3 — Targeted command regression checks

Add typed-typo cases to command tests and the narrow trade/give acceptance handling above. Verify current no-result/single-result/chooser behavior and already-existing pagination. Keep wishlist/trade pagination fixes separate unless explicitly bundled.

### Step 4 — Validate and stop at the agreed scope

Run focused lookup/command tests, full tests, and `npm run typecheck:catalog`. Time representative exact, partial, typo, and no-hit searches against an available prepared catalog/synthetic full-size fixture; ensure expensive fuzzy work is skipped when exact/meaningful literal matches suffice. Optimize if measured blocking is significant; do not introduce workers, benchmarks infrastructure, or numerical release gates without evidence.

Tests to extend: `gameCharacterLookup`, `preparedCatalogSearch`, `wishlist`, `franchiseCatalog`, `catalogCache`, `gameCommands`, `wishlistCommands`, `tradeCommands`, `franchiseCommands`, and relevant affection/soulmate/divorce tests. Add `test/nameSearch.test.js`.

Acceptance criteria:

- Exact and rank lookups retain their established behavior.
- Meaningful partial matches are no longer hidden by a different entity's full-name prefix.
- Common name typos work, weak unrelated queries do not, and multiple plausible matches use existing choosers.
- Ownership/wish scopes, freshness, original identities, and existing effect-time checks are unchanged.
- No mandatory item activation rewrite, portal rewrite, quiz extraction, generalized menus, or new persistence was needed.

## Verification performed for this revision

Re-read the original plan and the main lookup implementations, their command callers, menu renderers/handlers, prepared cache, item-name/target paths, portal search paths, and Clue Reveal. A separate read-only review checked the proposed scope and menu distinctions.

Ran the existing baseline checks:

```sh
node --test test/gameCharacterLookup.test.js test/preparedCatalogSearch.test.js test/gameCommands.test.js test/wishlistCommands.test.js test/tradeCommands.test.js test/franchiseCommands.test.js
```

Result: **57 passed, 0 failed**. This verifies the current baseline, not a new fuzzy implementation. No runtime files changed.
