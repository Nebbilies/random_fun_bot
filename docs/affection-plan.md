# Affection and soulmate — phase-3 implementation plan

Status: approved by the user, implemented and locally verified on `feat/character-affection`; see [affection-validation.md](./affection-validation.md). The user requested `/plan` after accepting the design/display direction, including the gold soulmate accent. The user authorized feature commits and a pull request. Production database operations, deployment and live service actions remain outside scope.

Design authority: [affection-design.md](./affection-design.md), the final interview record [affection-brainstorm.md](./affection-brainstorm.md), and subsequent presentation decisions. Preserve pre-existing work, including the unrelated glossary additions, promotion manifests, item-expansion documents and Kaimetsu report. Repository inspection during planning found branch `main`, local HEAD `337174d`; recheck the actual checkout before implementation rather than assuming it remains unchanged.

## 1. Fixed scope and implementation invariants

### Accepted product rules — do not re-balance during implementation

- Affection belongs to one guild/player/canonical-character relationship, starts at zero without historical backfill, survives ownership loss, and caps at **2,100**. Discard excess; grant every crossed normal milestone once. No XP, numbered levels, daily affection cap, repeat-character penalty, post-cap payouts, or automatic soulmate selection.
- Awards: owned-character appearance **100**, successful reclaim **20**, franchise **12/10/5** for whole published franchise sizes **1–5/6–10/11+**, genre/no-genre-soulmate fallback **1**. Multiple shared franchises use the **lowest** award; category precedence then selects the highest qualifying category per source/pair, never adds them. Separate recipient relationships remain separate awards.
- A selected soulmate missing genres gets the one-point fallback; a genre-covered soulmate does not gain that exception because the rolled character lacks genres. Do not infer genres.
- Appearance eligibility/Bond chance freezes at selection, before consequences. Earning needs an acknowledged noncanceled character presentation, including losing/unclaimable mystery reveals. Hidden intros do not qualify. Saved awards retain their original recipient despite later ownership/selection changes; later cancellation cannot claw back already-valid progress.
- Current owners can roll their own soulbound characters. Own-character appearances are terminal and nonclaimable, never escapes; they skip and retain armed Cupid's Misfire.
- Soulmate selection requires current ownership and a nonbusy character. Initial selection/switch/replacement starts a **12-hour** cooldown. Ownership loss clears selection and permits a replacement despite the old deadline; reacquisition does not reselect. Preserve spent allowances and temporary rewards.
- Normal benefits: one **+1 roll** contribution at **200** affection and **six-minute claim-wait reduction** at **700**, requiring ownership; harem-wide caps **+5 / 60 minutes**. Apply roll contribution after Rush multiplication; keep fixed claim reset buckets and token precedence.
- Both complete reward tables in design sections 4 and 5 are authoritative: **23 normal milestones**, **21 soulmate checkpoints**, first Windfall **100/8%**, all base perks **900**, all final upgrades **2,100**. Random late normal items follow Epic/Epic/Legendary at each hundred from **1,000 through 2,100**.
- Claim Conservation preserves the chosen claim resource. When Ring alone enables that normal claim, **the same successful check preserves its prepared Ring use**; no activation-charge refund, new use, deadline change, or second check. Conserved normal claims change neither bucket marker nor last-normal-claim timestamp.
- Item Conservation covers semantic inventory-use charges only, including blocked uses and automatic/defensive expenditures. Not ingredients, discards, sacrifices, expiry, prepaid counters or armed-effect exhaustion. Snapshot before consequences; delayed settlement/refund uses saved zero/one actual debit.
- Negation validates before defense expenditure and uses the explicit design attack table: Hostage opening only, Siren activation only, opposing Misfire exhausted on block, Heart for a Heart stops without sacrifice. No mass/unbinding/ordinary-escape protection or extra Crown check.
- Favor/Echo freeze at vault selection or Chit activation; resolve after existing gamble/Recast, Favor then Echo; copy final item once, independently deliver each copy. No recursive chains or modifiers on milestone payouts.
- Milestone random items are chosen uniformly from the eligible earned tier, saved once, and use current pending-item dialogs. Empty tiers remain owed; owner profile/later affection can retry selection. Public viewers cannot cause these writes. Item expiry starts on acquisition, not earning.
- Pre-feature events without required capture evidence keep existing behavior for missing-snapshot effects. Never reconstruct eligibility from current state. New independent post-launch actions, such as reclaim, can qualify normally.

### Accepted display contract

- Traditional configured-prefix commands: `affection`/`aff`, `soulmate`/`sm`; no slash registration.
- Standard rich embeds for soulmate/detail/overview. Preserve original thumbnail URLs without bot-side square cropping; Discord controls dimensions. Do not set `IS_COMPONENTS_V2` on an embed reply. Existing roll/reward Components V2 remain; chooser/confirmation can reuse native Components V2 where useful.
- Active soulmate: **gold `0xF2C66D`**, always-visible active perk descriptions, no "Currently owned", no bottom perk-count line, no expand button. The same character opened through `affection` uses its active-soulmate layout/color.
- Regular affection: **pink `0xE91E63`**, compact `♥ 820` values, next-reward meter, normal contribution; hide the entire inactive soulmate-perk section and explanation. Explicitly label former ownership/inactive normal benefits.
- Overview omits the visible sort-order explanation and cap values; caps still apply mechanically. No paged reward path or separate level system. Current pending-item dialogs remain unchanged in purpose.
- A meter uses progress within the applicable last-to-next reward interval. For active soulmate, take the union of both tracks; show all rewards tied at the next threshold. Non-soulmates use normal milestones. At cap, show all current rewards unlocked, not a zero denominator or invented target.

### Overview defaults accepted with implementation approval

The user's approval to execute this plan accepted its stated overview defaults: **five relationships per page**, owned characters by descending affection with deterministic name/identity ties and zero-progress entries last, and a read-only Owned/Former filter. Sorting/cap explanatory text remains hidden as requested.

## 2. Agreed engineering seams to exercise

Implementation should proceed as small red/green vertical increments after authorization, not a large batch of speculative tests followed by all code. Plan approval also confirms these proposed test seams; no new tests are written in this documentation phase.

| Seam | Verify through | Covers / deliberately does not prove |
| --- | --- | --- |
| Relationship rules and transactions | New affection module's reads, selection, capture/earning and owed-reward operations, using real temporary SQLite | Progress, selection, matching, milestones, committed receipts; not real Discord rendering |
| Catalog opening/upgrade | Existing writable/read-only/create/convert/rehearse entry points and schema/runtime inspectors | Exact layouts, constraints, rollback, retained rows; not a live deployment |
| Paid roll/claim operations | `reserveRoll`, publication/delivery, `claimRoll`, mystery advancement/reveal helpers | Actual resource and award interactions; not private implementation call counts |
| Item use/defense | Existing activation/action/Fortune/Binoculars/Whistle entry points with deterministic clocks/RNG | Semantic cost and protection outcomes, recovery; not general randomness inside generic inventory deletion |
| Reward lifecycle | Existing reveal/decision/direct-delivery/pending interaction/recovery entry points | Parent/copy outcomes, inventory settlement, provenance, restart; not another reward engine |
| Prefix commands/rendering | Command `run`, component interactions and pure renderer outputs with fake transport | Grammar, scope, display/payload limits, no unwanted mutation; not live client image cropping/notification behavior |

Use literal, worked expectations from the accepted tables, not expected outputs generated from the same constants being tested. Prefer real fixture DBs and injected external I/O/time/randomness; do not mock the new module's internal collaborators. Direct SQL assertions are appropriate when SQL schema/trigger constraints themselves are the seam, not a substitute for ordinary public behavior tests.

## 3. Locality, dependencies, and durable contracts

### Intended modules

Keep the design's deep module, splitting only real responsibilities that prevent callers from duplicating policy:

- **`lib/affectionRules.js`** — immutable rules/version, both tracks, capped benefit/interval calculations, snapshot-based matching/precedence. No SQLite, Discord or mutable process state.
- **`lib/affectionSchema.js`** — new feature DDL, indexes, marker/row invariants and portable ownership-loss triggers. Installed through authoritative schema lifecycle only.
- **`lib/characterAffection.js`** — transaction-neutral capture/award/selection operations plus read-only benefits and relationship projections. Wrappers own a transaction only when called as a top-level operation. Capture/earn functions assert the caller's transaction; do not nest `BEGIN`.
- **`lib/affectionPerks.js`** — focused semantic decision/invocation receipts and use-charge settlement, including negative/no-perk decisions, deferred debit and actual-debit refunds. No Discord I/O or implicit RNG in generic inventory removal.
- **`lib/affectionRewards.js`** — earned milestone selection, owed-tier retry and linkage to existing neutral delivery. Reuse `vaultRewards` delivery/overflow rather than creating an inventory/collector engine.
- **`lib/affectionPresentation.js`** — pure standard-embed builders, compact meter, legacy navigation, and confirmation content. Commands orchestrate lookup and caller authorization, never threshold SQL or random effects.

Avoid a new generic event framework, provider abstraction, portal track editor or runtime schema initializer. Keep the rules/receipt/relationship modules free of imports from roll, item-definition registration or Discord runtime modules. Supply trusted resolved reward-definition/pool snapshots where the transaction adapter needs item selection, so the core cannot introduce a `characterRolls → itemRoster → items → characterRolls` initialization dependency. Existing transaction owners compose award capture, source costs and neutral delivery through narrow interfaces. Revalidate the resulting ES-module graph before adding imports; do not fix a cycle with hidden global DB/runtime singletons.

### Persistence contract

Keep `PRAGMA user_version=12`; use `affection_schema` version 1/capture version 1. Names below are planned concrete relations; exact constraints/columns can be refined without changing semantics.

| Relation | Keys and essential state |
| --- | --- |
| `affection_schema` | One feature/capture version and activation record; no populated historical relationship rows |
| `character_affection` | PK guild/player/character UUID, total integer 0–2,100, update time; FK retained identities, no ownership cascade |
| `player_soulmates` | PK guild/player; nullable selected UUID, selected/switch timestamps and optimistic selection revision; row/deadline survive loss |
| `affection_contexts` | Unique scoped logical source kind/key; immutable actor/guild/channel, rule/capture version, saved award candidates/ownership/matching/perk data, explicit presentation/cancellation state; optional historical roll/action ID, not a deleting FK |
| `affection_awards` | Unique logical source/player/character; qualifying base, saved Bond result, credited delta and resulting total; permanent deduplication |
| `affection_decisions` | Unique invocation/effect/subject/cost ordinal; captured eligible chance (including zero), saved outcome, expected/actual debit, settlement/refund state and committed action result where applicable |
| `affection_entitlements` | Unique guild/player/character/milestone key; fixed item or owed rarity, earned/selected/delivered/declined state, frozen definition/charges and neutral reward linkage |
| `reward_grants` / `reward_copies` | Permanent source/parent lineage, pre-perk decision evidence, Favor/Echo capture and finalization; unique parent+ordinal (0/1) and unique delivery-row ID, item snapshot plus acquired inventory/time/expiry evidence |

Retain `reward_sources` as the existing one-per-grant provenance anchor where possible; add the grant/copy sidecars rather than rebuilding its uniqueness to allow ambiguous sources. Ordinal zero uses the existing parent `vault_rewards` row; ordinal one uses a terminal neutral child row. Each milestone uses a unique direct grant and ordinal zero. Existing inventory ID is historical evidence, **not** a cascading FK: consuming/expiring an item cannot erase acquisition settlement. No destructive compaction/ledger cleanup in the initial implementation.

Feature tables require safe integer times/counts, valid guild/player scope, known states/effects/versions and valid JSON snapshots. Strict inspectors must distinguish legacy absence, valid new no-perk decisions, and corruption. Version new source envelopes as well as their receipts; during the extension record a bounded transition inventory of already-pending sources (or equivalent immutable cutoff evidence for monotonic IDs), without reconstructing any player eligibility. Missing feature capture is legacy only with affirmative pre-feature evidence, not merely because the new receipt is absent. Index owned-progress lookup, selected UUID invalidation, pending entitlements by owner and pending contexts by state/source.

### Stable identity and transaction ordering

- Roll/cost/appearance identity: original guild+command-message key, not numeric roll ID or Discord reply ID. Save a request tombstone for **every accepted new request**, even at zero perk chance, so normal cleanup cannot make it chargeable again.
- Reclaim/Whistle: the parent escape's stable key plus retaining player; same committed owner outcome for manual/automatic paths.
- Manual use: original command-message or interaction invocation ID, fixed actor/guild/channel; a new deliberate use has a new ID even if conservation leaves the same item/charges. Fix Golden Hour's `inventoryId:charges` fallback; a delivery action UUID created **after** effect execution is not invocation deduplication.
- Item confirmations/Hostage/Binoculars: existing durable action ID. Lens/Recast/Gamble: parent vault/reward plus semantic operation. Chit: existing deterministic mystery-source identity. Shield cost: incoming attack plus defender/cost ordinal. Milestone: stable relationship+milestone key. Echo: parent+copy ordinal, never another modifier source.
- Check immutable source/actor scope and return a matching committed receipt **before** looking for a live inventory source or original target. Only an uncommitted invocation validates mutable ownership/availability and captures chances.
- Capture all involved users' relevant perk chances before event consequences or affection unlocks. Save decisions atomically with their valid mutation/cost. No async I/O in the transaction. Exceptions roll back decisions, charges, rewards and ownership together.
- Affection earning atomically creates milestone entitlements and their item choice, not necessarily immediate Discord messages. Freeze reward definitions/charges at earning, but materialize inventory **after the parent operation's actual source costs settle**, so a Whistle/Chit/Lens/Recast debit can free a slot and conservation can legitimately retain it. A manual-reclaim outer transaction and a Whistle outer transaction may therefore call the same award operation, then flush selected neutral deliveries at their own final-cost seam. If delivery is deferred after commit, the saved entitlement is recoverable and its selection cannot change.

## 4. Ordered implementation slices

Do not expose the new commands or deploy an intermediate slice. Schema/refactor slices must keep existing tests green without half-enabling the feature in production. Each slice ends with focused verification and a review of changed callers; proceed sequentially through shared state even if read-only surveys or independent tests are delegated.

### Slice 0 — baseline, current-source check and fixture plan

1. Re-read the design, latest UI documents, AGENTS and actual working tree. Preserve unrelated tracked/untracked files; do not pull/reset/clean/stash or create a commit without instruction.
2. Record Node/npm versions and use the supported Node **22.23.2** runtime. Inspect existing test commands; do not import bot startup or open the default production-named DB for a baseline.
3. After implementation approval, run affected existing suites and the catalog typecheck, recording pre-existing failures separately. No tests were run during plan writing.
4. Freeze the accepted current-v12 predecessor DDL using the repository's authoritative schema source/fixtures, not a live database dump. Add/reuse small final-UUID synthetic fixture creation helpers. Many older `openCatalog(':memory:')` fixtures deliberately initialize **legacy v10**; they cannot prove new final-v12 affection behavior.
5. Keep legacy gameplay behavior covered where existing tools/tests require it. New feature commands require supported final affection schema; a v12 database missing expected feature objects must be upgraded/refused, not silently treated as empty progress.

**Gate:** known baselines and fixture/predecessor strategy; no uncontrolled DB/network startup.

### Slice 1 — accepted rules and projections

New: `affectionRules.js`; proposed focused suite `test/affectionRules.test.js`.

- Encode all 23 normal milestones and 21 soulmate checkpoints exactly from the approved design, with stable milestone/effect keys. Do not use UI ordinal as a player level or mutable rank as a payout key.
- Implement current perk rates, next/previous applicable threshold, all crossed normal rewards, 2,100 clamp/credited delta, and normal contribution caps. Preserve distinct normal-only versus active-soulmate union intervals.
- Matching consumes trusted snapshots: own direct 100, no-source Siren indirect exclusion, shared canonical franchise min score 12/10/5, genre intersection/fallback 1, max category once per recipient pair. Return both pairs for an owned non-soulmate plus related soulmate where appropriate.
- Inject deterministic draws at the semantic caller; pure threshold/matching calculations do not draw for rendering. One eligible Bond doubles once before cap.

**Worked cases:** shared size-5+size-80 groups → 5; only size-5 shared → 12; direct soulmate → 100 not 112; own other character → its 100 and separate soulmate match; 2,050+100 → 2,100/credited50; active progress640 interval600–700; normal820 interval800–900; active1,640 interval1,600–1,650; at cap no next reward.

**Gate:** independent table literals and worked examples, no tautological generated expectations.

### Slice 2 — exact v12 extension, receipts and ownership invalidation

New: `affectionSchema.js`; core durable helpers in `characterAffection.js`/`affectionPerks.js`.

Existing touchpoints:
- `catalogFinalSchema.js`: preserve immutable pre-affection current-v12 DDL; derive old Fortune/expiry/items-Phase-2/gender definitions from that baseline, not the newly extended final template. Install new DDL in fresh final catalogs; include exact object/row/UUID/JSON/version/constraint validation and inspector entry points.
- `vaultFortuneUpgrade.js`: extend its existing coordinator through exact historical intermediates, then affection, under one owned `BEGIN IMMEDIATE`; restore timeout; no nested upgrade. Keep current-layout fast path without a write lock and under-lock recheck for simultaneous bot/portal opens.
- `catalogDb.js`: normal/strict writable final opens use the extension; read-only opens never install it and give actionable predecessor diagnostics.
- `characterIdentityMigration.js`, `catalogConversionOperation.js`: prepare empty feature tables before final rebuild expects their columns; install selection-loss triggers only after retained marriages are copied, so no historic progress/loss/selection is manufactured. Update rollback-only upgrade diagnostics and evidence output.
- `ownershipHistorySchema.js` pattern: add portable marriage DELETE and ownership-identity-changing UPDATE triggers clearing only the old owner's matching selection and advancing its revision. Retain cooldown/progress/entitlements. Do not hook normal benefits into each item writer; derive them by current ownership joins.
- `catalogRuntimeRecovery.js`: recognize feature marker and validate its new records without drawing, awarding or selecting owed items. Seed/validate only the minimum pre-feature pending-source provenance/cutoff evidence needed to distinguish legitimate missing snapshots from damaged new captures; this is transition bookkeeping, not historical progress or perk reconstruction.

**Tests:** extend `fortuneUpgrade`, `itemsPhase2Upgrade`, `finalCatalogStartup`, `characterIdentityMigration`, `catalogConversionOperation`, `characterOwnershipHistory`, `catalogConcurrentWriters`; add focused `affectionUpgrade` and `characterAffection` suites. Cover fresh/current/exact older layouts, unknown/partial mixtures, dry-run byte/row stability, caller transaction rejection, concurrent opens, schema failure rollback, raw transfer-back/delete/reacquire selection invalidation, no backfill, permanent receipt retention and foreign-key failures.

**Gate:** creation, writable/read-only restart and offline conversion agree on exact final schema; no runtime lazy `CREATE TABLE`.

### Slice 3 — shared progress/selection module and selection-safe reads

- Implement pure-read `getAffectionBenefits`, owner overview/detail projections and entitlement status. Reads must not call pruning helpers or draw owed items implicitly. Query ownership/progress/selected state together and use current-ownership joins; no process-local maintained bonus counters.
- Implement top-level `confirmSoulmate` with expected prior selection revision, trusted candidate UUID, scope/time, ownership/busy/cooldown revalidation. Initial row absence and ownership-loss null selection allow selection; success advances revision/deadline, same-active target returns its profile/no mutation. Two stale menus cannot both overwrite selection.
- Use `isCharacterBusy`/pending-transfer registration and durable reservations. Existing trade/gift busy state is memory-only and owned by the gameplay bot connection; do not claim the new selector makes it globally persistent across multiple independent bot processes. Test actual same-runtime offers and cross-connection ownership writes.
- Implement caller-transaction-owned `captureAppearance`/`earnAppearance`/`earnReclaim` using stable source/pair receipts. Group appearance candidates before applying one Bond result per pair. Honor saved eligibility, cap/credit once and create permanent milestone entitlements; add fixed/tier item selection evidence through the trusted pool adapter in slice4 before enabling real earning callers in slice5. Capture pre-award perk chances so newly crossed rewards do not affect the same event.
- Former/progress lookup uses retained progress plus existing ownership-loss evidence where relevant; do not infer historical ownership from a character name. Show `Not in your harem` for absent ownership without proof of a former relationship rather than fabricating former status.

**Tests:** `characterAffection.test.js` through its public interface and final temporary DB: isolation, ownership/reacquisition, every threshold/cap, duplicate source vs independent source, selection cooldown equality boundary, raw SQL invalidation, busy rejection, stale confirmation, delayed saved recipients, read-only benefits/projections. Use schema tests for direct trigger assertions.

**Gate:** relationship and selection invariants hold without command/render dependencies.

### Slice 4 — source-neutral item rewards and milestone delivery

New: `affectionRewards.js`; source/copy helpers remain with existing rewards modules.

- Extend `getItemRewardSource`/recognized provenance creation in `vaultRewards.js`; preserve Chit source uniqueness and reject unknown source kinds. Milestones use stable relationship/milestone source IDs; child deliveries use unique copy IDs and parent lineage. Avoid colons in existing `vault:`-parsed IDs, using deterministic encoded IDs plus full scope metadata.
- Add `reward_grants`/`reward_copies` finalization and acquisition receipts. `deliverNeutral` currently loses the inserted inventory ID; record ID/acquisition/expiry/settled state atomically. Neither `delivered_at` (Discord acknowledgement) nor a current inventory row is proof of permanent grant settlement.
- Freeze fixed item starting charges and random uniform within-tier item definitions at milestone earning. Fixed named payouts remain named even when random-pool eligibility changes. A missing random tier creates owed state, not a downgrade/no reward.
- Flush selected copies after actual parent costs; independent delivered/overflow/declined copies reuse the current accept/replace/decline dialog and scoped canonical bindings. Decline never reopens a milestone. Owed unselected rewards retry only through the owner's profile/more affection; at cap profile retry still works, no new poller.
- Update source-policy dispatch in `mysteryConsolation.js`, `vaultRuntime.js`, `vaultSessions.js`, `legacyVaultAbandonment.js`, and restart guards so a milestone/child is not interpreted as Chit or an untyped real vault. Parent gate determines whether a Chit Echo child may announce.
- Keep current discovery masking, acquisition-time expiry, transactional replacement and partial copy delivery. Reuse the existing bounded recovery queues; no new affection item dialog.

**Tests:** `vaultRewards`, `vaultRuntime`, `vaultSessionRecovery`, `paidVaultRecovery`, `migrationOverflowRetention`, `finalInventoryControls`, `itemExpiry`, `itemDiscovery`, plus `affectionRewards.test.js`. Cover three initial payouts, configurable charges, empty tier → owner retry, public view purity, zero/one/multiple free slots, per-copy decline, consume/expire then replay, process reopen, acquisition receipt after inventory deletion, wrong scope/unknown provenance, selection saved across config changes and rollback of replacement failure.

**Gate:** milestones can be earned/delivered independently and replay-safe without any vault modifiers.

### Slice 5 — accepted roll contexts, own appearances, presentation earning

Primary files: `characterRolls.js`, `rollDelivery.js`, `characterRollRuntime.js`, `mysteryCoordinator.js`, `mysteryRuntime.js`, `catalogRuntimeRecovery.js`.

- Capture a permanent accepted-request identity in `reserveRoll` before its existing short-lived roll records can be pruned. Duplicate lookup consults it before quota eligibility/selection; missing linked presentation state after cleanup never authorizes a new request.
- After character selection but before Misfire/consequences, capture ownership, soulmate, matching counts/genres, Bond eligibility/decision and both possible recipient pairs. Record explicit new capture version and outcome kind for ordinary, own appearance, escape, mystery; prank/vault still get accepted cost identity but no character award candidate.
- Change common soulbind eligibility and fallback pools to include only the roller's own soulbound characters. The own-character outcome retains normal image/report controls and applicable selection-item expenditures but has no heart claim, mystery conversion or escape fields. Skip/retain armed Misfire; update item text/description and current validators, not just the execution branch.
- Publish ordinary/escape cards using acknowledgement **and publication result**, not `bound` alone. On success, earn appearance in the final DB mutation, returning saved progress/milestone feedback. Do not reverse it if a later ownership change cancels the escape.
- Own appearance becomes an acknowledged terminal outcome, with an immediate report deadline and no open claim. Receipt survives delivery uncertainty/cleanup. Reactions cannot acquire from an old card after divorce/reacquisition.
- Add a versioned reveal obligation/receipt at shared mystery `prizeCard` callers: winners, `revealUnclaimable`, and Doors losing reveal. Intro, explanation and John Pork placeholder never qualify. Persist terminal reveal recovery even if gameplay already completed; never replay the minigame or resurrect its claim window.
- Extend `inspectMysteryRuntime`/recovery and `cleanupRolls` so unacknowledged new reveal/award obligations retain necessary source/snapshot state. Already-credited rows can clean up presentation normally, while permanent receipts remain.
- Wire owner reclaim at the existing shared `claimRollInTransaction` branch; Siren and Whistle use it. Provide the pre-reclaim Whistle conservation-capture/result seam now, and connect the semantic zero/one spender in slice7; do not accept the final automatic-use gate before that connection. Whistle's outer transaction settles its saved source cost before milestone delivery flush.

**Tests:** `pendingRollRecovery`, `rollDeliveryPublishedTerms`, `characterEscapes`, `escapeRuntimeRecovery`, `forcedEscapePublishedTerms`, `mysteryRolls`, `mysteryRuntime`, `mysteryRuntimeRecovery`, `mysteryConsolation`, `cupidsMisfire`; add `affectionRolls.test.js`/`affectionRecovery.test.js` as needed. Fault inject send-before-ack, ack-before-publish cancellation, earn-before-status-edit failure, losing reveal terminalization, report cleanup, own-card forged reaction, transfer-after-selection, repeated reveal/reclaim, old missing-capture sessions and automatic Whistle.

**Gate:** all eligible presentation paths earn exactly once without a new quota debit or gameplay replay.

### Slice 6 — roll capacity, Windfall, claim reduction and Claim Conservation

- Replace the three debit sites inside `reserveRoll` with a transaction-local accepted-request cost calculation. Check positive capacity **before** refunds. Snapshot Windfall before consequences, persist its zero/one debit with accepted outcome; no check for empty/rejected/paused/duplicate requests. Vault/prank keep their early outcome semantics and do not consume Fever/targeting counters that only belong to character selections.
- Normalize period usage, apply existing qualifying Fever refund to prior current-bucket usage, then debit saved zero/one cost. Calculate returned remaining from resulting usage rather than the current stale pre-refund `used`. Retain free outcome after message failure and on consecutive explicit requests; no bonus or automatic roll.
- Update `rollCapacity`, `getRollStatus`, `claimDailyRolls`, applicable refill/item/status outputs to use `floor(base×Rush)+min(5, owned contributions)`. Preserve usage through gain/loss/switching. No changes to reset cadence or roll banking.
- Refactor claim availability/status around a truly read-only calculation: no pruning `getActiveBuffs` on inspection. Preserve fresh buckets, earliest reset/affection/Ring deadline, missing-timestamp safe behavior and existing token precedence. Use it for Chit eligibility, mystery opening, `mu`/status and final claims.
- In successful marriage transaction, snapshot pre-consequence claimant chance and resource/Ring necessity, apply one persisted conservation result. Reuse the decision foundation introduced in slice2; do not wait for slice7's inventory-use adapters to define claim-resource decisions. Conserved normal claim leaves both old marker/time untouched; conserved token/free claim leaves counter/expiry untouched. In particular, do not initialize a nullable legacy Double Date counter just to preserve it.
- Ring is needed only when the selected resource is normal and availability without Ring is false. Same successful Claim Conservation check preserves this prepared use. A natural reset, affection permission or bypass token never spends Ring. Rejecting/losing claims never draws or spends.

**Tests:** `characterRolls`, `rollCommands`, `itemBuffRolls`, `gameConfigRuntime`, `doubleDateClaims`, `muClaimTokens`, `mysteryRolls`; proposed `affectionQuotas.test.js`. Assert fixed reset boundaries, +5/60m caps, Rush order, no fresh allowance on switching/loss, Fever+Windfall at0/1/2used, period rollover, prank/vault, all resource kinds, Ring successful preserved vs nonconserved spent, no needless Ring expenditure, Double Date null counter, Chit classification and no-write inspection.

**Gate:** displays and authoritative eligibility agree; two concurrent claims cannot spend beyond actual availability, and conserved availability is retained rather than reset.

### Slice 7 — replay-safe semantic item use and complete conservation coverage

- Introduce durable invocation lookup **before inventory query** in `executeItemUse`/`executeItemUseById`, including use commands and inventory interaction IDs. Preserve immutable source scope and saved result, then let new calls resolve/validate inventory. Replay after last-charge deletion or target transfer returns the committed result, never another effect/charge.
- Route legacy dispatcher payments and standalone `armCupidsMisfire` through one semantic use-cost operation; no double charging between `execute` and dispatcher. New legitimate uses of a conserved item use a new invocation ID. Remove charge-count-derived fallback identity for Golden Hour; recovered follow-ups use its saved vault/action linkage.
- Snapshot actor conservation before synchronous item effects, including those that sacrifice their own funding soulmate. Save decision plus expected debit with the committed action and settle actual zero/one charge at the existing payment point.
- Integrate all confirmed `itemActions` source costs, preserving holds and authorization through `consumeItemActionSource`. A conserved use releases its hold without decrement, leaving original expiry; cannot be used twice while held. Ingredients/whole-entry replacement deletes remain excluded.
- Hostage captures source eligibility at validated opening before consequences; confirmed delivery settles once using that record. Failed undelivered cancellation releases holds/restores only existing eligible Crown state, not an invented item copy. Later challenge settlement gets no new source charge or conservation check.
- Lens records actual provisional debit and saved chance before I/O. Ack releases source, definite unpresented eligible refund restores **only actual debit**. Recast arming/preparation only hold; first private `presentRecast`, including `chooseRecast`'s implicit presentation path, saves the use decision and settles once; reopen never pays again.
- Binoculars captures use terms before secret DM, definite failure releases with no charge, ambiguous recovery settles using the saved decision without resending; old pending uses lacking capture retain existing behavior.
- Integrate Chit at genuine-win activation, Gamble at decision (including loss), Whistle after successful reclaim using pre-reclaim capture, and every eligible Shield charge. Preserve capacity after actual costs, remaining-charge feedback and no-effective-benefit successful use semantics.
- Audit all `decrementItemCharge`, reserved-source debit, and direct charge-update sites with `rg`; explicitly classify each as covered semantic use, deferred use, or excluded generic deletion. Keep low-level removal/decrement deterministic.

**Tests:** `itemActivation`, `itemActions`, `itemActionRuntime`, `itemExpiryConsumers`, `itemBehaviorAudit`, `binocularsRecovery`, `mysteryBinocularsExpiry`, `vaultFortune`, `fortuneRuntime`, `mysteryConsolation`; proposed `affectionItemConservation.test.js`. Cover command replay after source gone, same-charge valid second invocation, no source-charge duplication, actor loss/sacrifice, held expiry, zero debit+refund, failure/reopen/concurrent settlement, pre-feature pending uses, no protection for ingredients/counters, and source-cost slot retained causing overflow.

**Gate:** semantic spend inventory is complete, with one saved decision per real charge and no accidental replay/refund inflation.

### Slice 8 — Negation at validated hostile action seams

Use the shared saved-decision operation, not an ownership trigger, for these exact touchpoints:

| Files / action | Placement and result |
| --- | --- |
| `items/masterKey.js`, `items/pickpocketsHook.js` | Select/validate original target before existing Shield check; negation prevents transfer. Invalid/no eligible target cannot consume defense/source as a valid block. |
| `characterRolls.js` opposing Misfire | Before Shield; on Negation retain marriage/exhaust armed Misfire and ordinary escape behavior; own appearances still skip/retain it. |
| `itemActions.js` Severed Fate | Validated confirmation before Shield/Crown; no divorce. |
| `itemActions.js` Heart for a Heart | Same, but stop own sacrifice too; source normally pays/conserves. |
| `itemActions.js` Hostage | At validated opening only; prevent challenge, normally pay/conserve Note; no later check. |
| `items/sirensCall.js` | At validated activation before Crown; no escape created, normally pay/conserve Siren. |

- Snapshot defender and attacker protection/cost chances before consequences, including an attack on the funding soulmate. Persist failed/no-perk outcomes as well as successful Negation.
- Keep existing item-specific defense scopes/order **after** failed Negation. Crown redirects once within same owner, not a new attack/check. Misfire still bypasses Crown; Siren still does not suddenly consult Shield.
- No checks for Kaimetsu, Masquerade, consensual transfers, unbinding, sacrifices alone or ordinary escape marriages. Blocked action feedback names Negation accurately and reflects actual conserved/spent charges, not an assumed Shield shatter.

**Tests:** extend `itemBehaviorAudit`, `itemActions`, `cupidsMisfire`, `itemActivation`, `characterEscapes`, relevant forced-escape suites; proposed `affectionNegation.test.js`. Use controlled boundary draws for8/12/16%; validate nonexistent Key target/empty Hook harem costs, two-defense preservation, one Crown redirection, source conservation on block, Heart sacrifice retained, Hostage opening snapshot/switch-before-settlement, Siren no creation, defender-soulmate target, exclusions and racing stale confirmations.

**Gate:** every eligible action validates first and resolves once; no extra ownership/mass protections.

### Slice 9 — Fortune's Favor / Echo through the existing vault pipeline

- At A/B/C selection freeze current Favor/Echo eligibility and source item pools; a pre-feature unopened session without required feature capability is not reinterpreted from current state. At Chit activation capture winner perks alongside the original chosen reward. A fresh post-launch independent charge use can have its own capture even on an older parent event; no historical reward eligibility is reconstructed.
- Preserve original reveal and saved gamble/Recast evidence. Once existing decisions finish, one transaction applies next-tier Favor (at most Legendary; empty tier keeps original), then independent Echo, freezes final item/charges and creates copy records/delivery rows exactly once. Lost gamble finalizes no copies and no item bonus. Bonus copies are neutral, never vault/modifier sources.
- Ordinal zero uses current parent row; bonus child has no vault session. Skip every vault modifier for both milestone/child rows and selected overflow retries. Record parent/copy provenance so no duplicate source uniqueness conflict or accidental new armed Recast.
- Update `inspectFortuneRuntime` chosen-Recast equality against pre-perk evidence, not changed final JSON. Update `inspectMysteryConsolation` original-to-final/copy validation; retain winner/decision/source pool/charge checks. Child Chit announcement inherits parent character-reveal acknowledgement gate.
- Keep Lens previews before new perks, existing gamble eligibility based on pre-Favor rarity, and current manual Recast choice scope. Capture/inspection never rerolls on config/soulmate change, restart or overflow.

**Tests:** `vaultRewards`, `vaultFortune`, `fortuneRuntime`, `vaultRuntime`, `mysteryConsolation`, `vaultSessionRecovery`, `paidVaultRecovery`, `catalogRuntimeRestart`; proposed `affectionItemRewards.test.js`. Cover independent effects both/none, next-tier boundary/uniform draws, empty/top tiers, Recast keep/change/timeouts, lost gamble, no child chains, captured-vs-live eligibility, one/no/free slots, per-copy decline/expiry, restart after finalization before send, Chit reveal ordering and unknown source corruption.

**Gate:** final reward lineage remains auditable and restart-safe without rewriting the existing choice/overflow UI.

### Slice 10 — prefix commands and approved compact presentation

New: `commands/affection.js`, `commands/soulmate.js`, `affectionPresentation.js`; optional thin alias modules or explicit alias routing, not duplicated handlers.

- `index.js` early game dispatch: map `aff`/`affection` and `sm`/`soulmate` to canonical handlers. Extend the collector-only expired namespace guard for new view/selection controls. No slash registration.
- Reuse `findCharacters`/character index/curated aliases and `resolveUserTarget`/`resolveTargetUsername`. Extract trailing player mention before joining a name. `#rank` resolves to UUID at menu creation, never follows subsequent rank changes. Default relationship is the caller's, not the current character owner's.
- Own overview/detail command explicitly retries unselected owed rewards as an authorized continuation, then renders a fresh pure projection. Someone else's profile and all read-only paging/filter actions never invoke reward selection/delivery. New soulmate selection obeys the existing maintenance ingress restriction, while status inspection stays available; do not block an existing earned reward as if it were a new attack.
- Soulmate candidate chooser/confirm follows current divorce/wish patterns, scoped to actor/guild/message and expected selection revision. Recheck `requireNewGameAction`, ownership, busy state and cooldown at commitment. Same-active candidate returns status without confirmation reset. Timeout/cancel/restart produce disabled/expired controls and no mutation.
- Render selected soulmate gold with original portrait, compact meter/next rewards, always-visible active perks, per-character normal contribution and switching availability. No ownership redundancy, perk count or show/hide button. Active soulmate detail via `affection` uses the same renderer.
- Render regular detail pink with `♥ total`, normal-only next reward, contribution, no inactive soulmate list/activation explanation. Mark saved former state/inactive normal bonuses; no selection hint on an unowned or another player's relationship. At cap hide next target; missing images omit thumbnail safely.
- Implement overview defaults only if accepted with this plan: five rows, owned/former filter, descending totals with deterministic ties; no visible sorting description or cap values. Current soulmate/whole-harem bonuses/pending status remain distinct from the listed characters' contributions.
- Read-only controls are scoped to the invoking viewer and fixed viewed player/message; a viewer cannot change the target to obtain mutation authority. Escape text, suppress mentions and respect native embed fields/6,000-character budgets and Unicode names. The meter is text, not an unsupported Discord progress widget or rendered-image dependency.
- Existing V2 roll cards get compact saved affection deltas/new-milestone notices without removing report controls or changing stored images. Only add final credited outcomes; never draw to render. Mystery character reveals currently use embeds, so add saved award feedback in their existing embed/status path too rather than updating only `rollCard`; do not convert their minigames to V2 as unrelated scope.
- Add a short dynamic-prefix command reference (`docs/affection.md`) and update game help only where a real shared help surface exists; no invented unrelated help system. Include new modules/commands in `tsconfig.catalog.json` deliberately rather than assuming transitive typecheck covers them all.

**Tests:** proposed `affectionCommands`, `soulmateCommands`, `affectionPresentation`; extend `gameCommands`, `userTarget`, `gameCharacterLookup`, `guildPrefix`, `botBootstrap`, relevant roll runtime/render tests. Check alias routing, optional target, name ambiguity, no slash export, correct colors/fields, no hidden inactive perks, no unintended ownership/cap/sort text, tied reward meters, maximal Unicode/long fields, no image, empty/former/no selection/cap states, stale/racing confirmations, unauthorized/public paging, timeout/restart and read-only navigation DB stability.

**Gate:** builders produce native-feasible payloads; fake transport proves scope/order but live Discord portrait/spacing acceptance remains separate.

### Slice 11 — whole-runtime recovery and transition acceptance

- Extend `inspectCatalogRuntimeRestart`, `inspectMysteryRuntime`, `inspectFortuneRuntime` and source lineage inspectors to validate **terminal** provenance/receipts too, not only visibly pending records. Unknown new states/versions/scope conflicts block for inspection; legitimate owed-tier debt is valid pending work.
- Distinguish each pre-feature missing-capture path explicitly: old roll appearance gets no guessed award; old finalized reward no Favor/Echo; already-debited old Lens/Binoculars pending use retains its old settlement policy. A new independent reclaim/use can capture current eligibility. Missing new-version capture is corruption, not legacy.
- `index.js` startup: retain preflight before gameplay ingress; reconcile held-item costs using existing coordinators, recover ordinary/own/forced delivery and general mystery reveal receipts, then source-gated reward copies/selected milestone deliveries. Never re-run item effects or game selection to recover messages.
- Reuse the current bounded periodic recovery with no duplicate watchers. No polling to populate an empty-tier reward: only the accepted owner events/profile do that. Public queries remain pure.
- Expand cleanup guards for pending appearance evidence and ensure permanent source tombstones, awards, entitlements and acquisition receipts are not cascaded with roll/presentation rows. No TTL deletion of earned replay evidence.
- Reopen with two connections and race duplicate decision/claim/reward/receipt finalization. SQLite writer serialization plus UNIQUE constraints supplies correctness; process-local UI queues are presentation aids, not global exclusivity. Existing single-bot memory-only transfer limitation remains explicit.

**Tests:** `catalogRuntimeRestart`, `runtimeRestartSafety`, `pendingRollRecovery`, `escapeRuntimeRecovery`, `mysteryRuntimeRecovery`, `binocularsRecovery`, `fortuneRuntime`, `finalCatalogStartup`, `catalogConversionOperation`, new `affectionRecovery`. Exercise interruption between receipt/effect/cost/presentation/award/entitlement/copy transitions; source cleanup; replay after item consumption/expiry; old pending fixtures; corrupt positive and negative decision state; and non-writing inspection. None use production DBs.

**Gate:** replay can restore presentation but never a second award, draw, claim debit, use charge or acquired copy; paid/corrupt ambiguity fails closed without erasing legitimate obligations.

## 5. Verification execution and completion evidence

### Commands after implementation is authorized

Use the supported runtime and real filenames found in the checkout. Short focused examples (add new suites as each slice lands):

```sh
node --test test/finalCatalogStartup.test.js test/fortuneUpgrade.test.js test/itemsPhase2Upgrade.test.js
node --test test/characterRolls.test.js test/characterEscapes.test.js test/pendingRollRecovery.test.js
node --test test/itemActivation.test.js test/itemActions.test.js test/binocularsRecovery.test.js
node --test test/vaultRewards.test.js test/vaultFortune.test.js test/mysteryConsolation.test.js
npm run typecheck:catalog
npm test
git diff --check
```

Run long builds/tests with a background terminal, continue useful work, then read the result; do not create polling/sleep watchers. If the harness cannot isolate Node tests, use the supported bounded alternative recorded in this repository only after checking the installed Node accepts it, and report the exact command. Do not silently turn skipped or failing tests into passes.

Maintain a concise eventual `docs/affection-validation.md` with actual baseline/focused/full counts, runtime/version, typecheck/whitespace results, crash/reopen cases and any limitations. Table/payload checks are not a live Discord UI test. Do not claim the feature implemented/verified from this plan.

### Acceptance traceability

| Accepted requirement | Principal implementation slices |
| --- | --- |
| Exact awards/membership min/fallback and both reward tables | 1,3,4,5 |
| Ownership persistence/clearing, switching cooldown/busy checks | 2,3,10 |
| Nonclaimable own/soulbound appearances and Misfire change | 5,8 |
| Selection/reveal/reclaim snapshots and permanent replay evidence | 2–5,7,11 |
| Capacity/Rush, fixed claims and final Ring exception | 6 |
| All semantic inventory costs and actual-debit refunds | 7, with5/8/9 consumers |
| Validated action-specific Negation/exclusions | 8 |
| Favor/Echo ordering/copy lineage/Chit reveal gate | 4,9,11 |
| Pending milestone/empty-tier recovery and public query purity | 4,10,11 |
| Standard embeds, gold/pink, compact meters, hidden inactive text | 10 |
| Exact upgrades/fresh/readonly/legacy transition/operational safety | 2,11 |

## 6. Risks, stop conditions, and rollout separation

- **Do not infer time guarantees** from old catalog models or raise accepted thresholds to match superseded week targets. Four Legendary payouts and item targeting can accelerate progress; that is the accepted track, not permission for hidden caps/nerfs.
- **Receipt completeness is mandatory.** Conservation makes mutable charge counts unsuitable for use identity; source state may be gone on replay. If a caller cannot supply a replay-safe invocation/capture identity, fix that seam or stop it rather than sampling current state on recovery.
- **Snapshot ordering matters across effects.** A reclaim unlocking Conservation cannot conserve its own Whistle; an item losing its own soulmate must keep its pre-consequence chance; a claim cannot unlock its own source perk from another operation in the same parent event.
- **Exact-schema changes are not an optional appendix.** Do not weaken validators to accept any v12, modify historical predecessor fixtures to match new DDL, or let a new startup initializer repair arbitrary partial state. Read-only tools must remain read-only.
- **Delivery is not globally exactly once.** Discord send-before-ack can produce duplicate presentation outside its nonce window. Use canonical bindings/receipts and saved results to keep resources and progression exactly once without overclaiming message delivery.
- **No blanket inventory RNG/ownership protection hooks.** They would conserve ingredients/discards or protect mass/sacrifice paths that are excluded. Use explicit semantic integrations and portable selection invalidation only.
- **Unknown paid/new-version state is a blocker, not a disposable fixture.** Stop and surface any unresolved product contradiction, unsupported pending-state transition, rollback/data-loss risk, or need to change an accepted mechanic. Do not broaden this feature into a general refactor to hide it.
- No production actions during implementation/verification by default. Future rollout requires explicit authorization, a fresh consistent SQLite backup including WAL, coordinated bot/portal code, rehearsed upgrade and runtime/Discord acceptance. Preserve compatible code+DB rollback pairs; old exact-schema binaries may refuse the extended DB. Never drop feature tables to manufacture a downgrade.
- No commits unless explicitly requested; if requested later, follow repository commit convention without co-author metadata.

## 7. Plan self-review and authorization gate — implementation subsequently approved

**Author self-review complete; self-approved as a plan, not implementation authorization.** Reviewed the complete plan against the accepted design, final Ring override, both reward tables, gold/shortened-card decisions, current source, existing test structure and operational constraints. Three bounded read-only implementation inventories informed the task map; an independent read-only execution review found no material unresolved execution issue. That review is not gameplay verification or user approval.

Self-review refinements captured in the final plan:

- Freeze exact v12 predecessor definitions before extending final DDL; coordinate fresh/strict/read-only/offline conversion and state inspection, without a casual version bump or marker-only acceptance.
- Put permanent invocation lookup before mutable source/owner validation, including legacy direct item use. A conserved repeat invocation cannot reuse charge-count identity, and presentation cleanup cannot remove request tombstones or payout evidence.
- Distinguish pre-feature missing capture using affirmative transition provenance/new source versions rather than treating every missing receipt as legacy. No historical player eligibility/backfill is inferred.
- Snapshot Whistle before reclaim progress; account for Hostage/Lens/Recast/Binoculars deferred zero/one debits and actual-debit refunds; retain original secret/reveal semantics and no double inventory charge.
- Materialize milestone inventory after actual parent costs settle while atomically fixing milestone entitlement/item choice at earning. This avoids overflow caused solely by integration ordering and handles conserved sources legitimately retaining a slot.
- Preserve original versus post-Favor outcomes, grant/copy uniqueness and acquisition receipts. Keep both selected milestone items and Echo copies on the existing pending-item interaction/recovery path.
- Explicitly cover embed-based mystery reveal feedback as well as V2 ordinary cards, and keep terminal reveal obligations from premature cleanup.
- Resolve slice dependencies: decision foundation exists in slice2, progress creates entitlements in slice3, item selection/delivery composition lands in slice4, automatic Whistle conservation completes in slice7. No intermediate feature deployment/command exposure is authorized.
- Preserve final Claim Conservation's same-check Ring-use exception; mechanical caps remain while overview cap text is hidden. Gold `0xF2C66D` is approved, not a pending color proposal. Overview paging/filter defaults remain explicit plan choices requiring acceptance.

Documentation checks passed: local Markdown links resolve; all **47 existing test-suite names** referenced by the task inventory exist in this checkout; proposed new suites are labeled; accepted normal/soulmate threshold sequences and display exclusions are covered by the task/acceptance map; `git diff --check` is clean. No gameplay tests, typecheck, schema operation, production DB access, network/SSH action, bot startup, or service action was performed during planning. No commits created.

The user explicitly approved execution, disposable-fixture verification, split feature commits without co-author metadata, and creation of a PR. Implementation follows these slices; actual results are in [affection-validation.md](./affection-validation.md). No live deployment, production database/service operations, or unrelated changes are authorized. The original planning phase remained documentation-only.
