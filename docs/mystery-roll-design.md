# Mystery roll event design

Status: Phase 2 design approved by the user. The first release includes Doors, Treasure Hunt, and Clue Reveal. Meteor Shower is designed for a later release. Time Capsule and Passing Parcel are out of scope.

## Goal and scope

Add mystery outcomes to the existing `!w` and `!h` rolls without making each event reimplement roll limits, ownership, claims, Discord routing, or restart handling. An event starts from one selected, unowned character and one spent roll. The first release covers one-roll, one-prize events: Doors, Treasure Hunt, and Clue Reveal. Meteor Shower needs a separate multi-card extension and will come later. Time Capsule and Passing Parcel are out of scope.

The current code has `reserveRoll` and `claimRoll` in `lib/characterRolls.js`, Discord delivery in `lib/characterRollRuntime.js`, and message/interaction routing in `index.js`. SQLite already stores roll quotas and claimable cards. Slash commands already exist under `commands/utility`, although `index.js` currently registers them only for `config.guildId`.

## Agreed game rules

- A `!w` or `!h` request selects a character first, then uses that character's rank to decide whether mystery triggers. The roll uses the existing shared seven-per-hour allowance. Character selection remains uniform among eligible unowned characters, except that characters on live claim cards or reserved by an event are excluded. An empty eligible pool spends no roll.
- Only one event may be active per server. While it is active, including countdown and protected claim time, `!w` and `!h` decline without spending rolls. This also preserves the 100% mystery chance of ranks `#1–20`: those characters cannot be rolled while another event is active.
- Once mystery triggers, choose an enabled, available event by fixed roster weights. Every event can receive every character rank. The event's selected character stays the prize. Event difficulty does not scale with rank.
- In the event channel, post a mystery card using `assets/mystery_roll.png`. Above its embed, show `# ❓ A mystery character appears!`. Its name is `??????`, rank `???`, likes `????`, and anime `-`; no actual prize details or claim control appear. Five seconds later, begin the selected event. The original roll channel links to this message.
- The server's configured event channel receives the event and typed answers. The original roll gets a link. Until configured, the roll channel is the event channel. A server Administrator changes the setting by slash command; the character game commands remain prefix commands.
- An event module decides its winner. That may be someone other than the roller, including someone without an available claim. The selected character remains reserved from other rolls until the event ends.
- After a winner is decided, show a five-second countdown, then reveal the character. If the winner can claim, only that winner has 60 seconds to use a claim. The normal one-claim-per-three-hours rule still applies. There is no public fallback. A winner with no claim sees the character revealed but unclaimable. If no one wins before the event deadline, reveal it unclaimable. A simple mystery reveal without a contest instead uses the existing public 60-second claim rule.
- Each event declares a deadline subject to a global maximum. Answer spam has a shared per-player cooldown; an event may impose additional attempt rules.
- A bot restart cancels active events and protected mystery claim windows without refund or compensation. The bot leaves old Discord messages unchanged; their controls and reactions cease to work. Normal non-mystery roll windows retain their existing restart behavior.
- Save a small outcome history with event ID, character ID and rank snapshot, result, and timing. Event IDs remain meaningful after an event is removed from the roster.

## Mystery probability

Store the agreed rank/chance points as one validated table:

| Rank | Chance |
| ---: | ---: |
| `1–20` | 100% |
| `50` | 50% |
| `100` | 25% |
| `200` | 10% |
| `500` | 3% |
| `1,000` | 1% |
| `4,000` | 0.5% |
| `15,000` | 0.05% |

Between anchors, interpolate linearly in **log probability**. For neighboring points `(r1, p1)` and `(r2, p2)`, use `p(x) = p1 * (p2 / p1) ** ((x - r1) / (r2 - r1))`. This exactly meets every chosen point, remains monotone, and permits changing one anchor without refitting an opaque formula. Validate increasing ranks, probabilities in `(0, 1]`, and nonincreasing chances at startup. Capture the selected rank for the draw and history; never treat rank as character identity.

If a future catalog extends beyond rank `#15,000`, continue the final segment's declining log slope so rolls remain valid. The current catalog stops at `#15,000`.

The table gives roughly one mystery per 103 rolls if all 15,000 catalog characters are equally available. Ownership, gender pools, and live-card exclusions change the actual rate. This is an estimate, not a guaranteed server frequency.

## Design options

| Option | Effect on adding or removing an event | Assessment |
| --- | --- | --- |
| Add cases to `runRoll`, claim handling, and message routing | Each event spreads changes across the most sensitive code | Reject. Deletion and editing are easy to miss in one path. |
| Put every event in a generic JSON rule language | Roster edits look simple, but multi-step clues and player choices make the interpreter large | Reject. Configuration would become a second programming language. |
| Give each event a module behind one small interface; keep shared rules in a coordinator | New one-prize events add one module plus one roster entry | Recommend. Event-specific state stays local; claims and quotas stay centralized. |

### Module seam

Use one **mystery coordinator module** as the external seam from roll commands and Discord events. It owns rank odds, active-server checks, event selection, deadlines, input routing, countdown, reveal, claims, and history. Its interface should be small: start or decline a roll, accept an event input, accept a claim, and cancel active sessions on boot. Existing `w`/`h` commands still delegate through the roll runtime.

The coordinator holds an internal event seam. An event module only needs to create its starting state and advance that state for an input or timer. It returns a view to send, a next state, and optionally `winner` or `noWinner`. The coordinator sends Discord messages and applies outcomes. The following is an interface sketch, not implementation code:

```text
event.start(context) -> { state, view, nextAt, deadline } | unavailable
event.advance(state, input, context) -> { state, view?, nextAt?, outcome? }
outcome = winner(userId) | noWinner
```

`context` supplies the selected character's stable ID and rank snapshot, roller ID, current time, and a controlled random source. An event never writes marriage or allowance records, chooses a replacement character, or sends Discord messages directly. The coordinator accepts only events whose returned deadlines fit the global maximum. Event views may differ, but shared rendering enforces mention restrictions, event IDs in controls, and the common reveal/claim card.

The **roster** is a short code-owned list of stable event IDs, module references, enabled flags, and positive selection weights. It is changed and deployed with code. On startup, validate unique IDs, known modules, and usable weights. Before a weighted draw, remove events unable to start, such as an exhausted Treasure Hunt puzzle bank; renormalize the remaining weights. If none are available after mystery triggers, decline without spending the roll rather than silently turn a guaranteed top-rank mystery into a normal reveal. Disabling or deleting a module stops new selection. Historical rows keep the old ID as text; do not reuse an ID for a different event.

## Shared roll and claim flow

1. In one short SQLite transaction, check for an active event **before** charging a roll. Select uniformly from unowned characters that have no live claim card or active event reservation. Calculate mystery chance from the rank snapshot and check event availability. Debit the roll only when a normal card or event session can be reserved. The unique active-session constraint per guild is the final guard against concurrent commands.
2. Outside the transaction, post the event in the configured channel. Reply to the original roll with its link. If Discord delivery fails, mark the reservation failed and release it. Follow the existing failed-delivery rule: the roll stays spent. Do not hold a database transaction across Discord requests.
3. Route buttons, menus, and typed messages by session ID and event channel. Reject stale, cross-server, cross-channel, or unauthorized inputs. Give `!w` and `!h` priority over event answer parsing so command attempts receive the paused-roll response; route legitimate typed answers before unrelated message side effects.
4. The event module handles only its own interaction. The coordinator serializes each accepted state transition and records the outcome. Timer callbacks check absolute deadlines so a delayed callback cannot extend an event.
5. On a win, the coordinator runs the countdown, reveals the selected character, and opens the winner-only 60-second claim window if the winner is eligible. Reuse one atomic claim rule for public and exclusive cards: verify card state, deadline, allowed user, current catalog character and ownership, and claim allowance, then marry and close the card. Event modules cannot call marriage code. On loss, timeout, no claim, or protected-window expiry, reveal or leave the revealed character unclaimable as agreed.
6. Keep the server paused through the protected claim window. Close the active session and release its character reservation when the event is fully resolved. On boot, close all unfinished event sessions and mystery claim windows in SQLite, then ignore input on their old messages. Do not edit those messages.

Use additive SQLite storage for a per-guild event channel setting, session/outcome records, and per-guild Treasure Hunt puzzle wins. The active session and its character reservation must be transactionally visible; an in-memory map alone cannot enforce roll pauses and ownership races. Detailed event state may be ephemeral because restart cancels it, but retain stable session identity, final status, and outcome history in SQLite. Extend the current claim card record with an exclusive user/session reference rather than building a second marriage path.

## Two interface examples

**Doors** is a solo, pure-random choice. Its start state chooses one winning door from three using the injected random source. Only the roller may choose, once, before its deadline. The event returns `winner(rollerId)` for the winning door; a wrong choice or timeout returns `noWinner`. There is no puzzle bank and no alternate character prize.

**Treasure Hunt** uses a checked bank of puzzle templates and generated instances. One puzzle has one answer and staged clues at fixed times. The first correct typed answer in the event channel wins; shared cooldown limits spam. The answer is independent of the hidden character, so every catalog character can be the prize. Track completed puzzle IDs by guild and exclude them from later picks there. Mark a puzzle completed only when someone wins; an unsolved or restart-canceled puzzle may recur, even though a player could save its answer. The user explicitly accepted that tradeoff. If a guild has no available puzzle, this event reports unavailable and the selector chooses another enabled event.

Puzzle templates and answer normalization belong to Treasure Hunt's internal content module, separate from the roster and claim logic. Generated instances need stable IDs so the per-guild completed set is deterministic. Validate each template's answer and clue schedule before making it selectable.

## Other event ideas and extension points

| Idea | Fit with the one-roll, one-prize interface | Additional rule still needed |
| --- | --- | --- |
| Clue Reveal | Fits. Everyone in the event channel may guess one leading anime linked to the selected character; first correct guess wins. Select a TV entry first, then highest popularity, among entries actually linked to the character. Accept its Romaji, English, native, and synonym titles after normalization and conservative typo tolerance. Run five clue stages over 90 seconds: format, year/season, genres, tags, then a title hint. A wrong guess locks that player out until the next clue. Omit a franchise clue that gives away the title. Skip this event if the target lacks enough reliable metadata. On timeout, show the answer anime and rolled character unclaimable. | Validate that no clue directly states an accepted answer title. |
| Passing Parcel | Out of scope by user decision. | No design or implementation in this phase. |
| Time Capsule | Out of scope by user decision. | No design or implementation in this phase. |
| Meteor Shower | Later release. Needs a multi-card extension: draw five to ten separate characters, capped by the eligible pool size. Cards drop every five seconds as ordinary public 60-second claim cards from one spent roll. The triggering character is always included at a random drop position. Extra characters are sampled uniformly from the same eligible unowned pool, excluding live cards and duplicates in the shower. Any player with a claim available may claim a card. Rolls resume when the last claim window closes. Restart cancels every remaining shower claim window without editing old messages. | Add a separate multi-card reservation and claim flow later. |
| Rank Wager | Could fit if a correct guess wins the selected character. | Its original extra bonus needs a reward system outside this scope. |
| Boss Encounter | Could fit as a one-prize group challenge. | Define which contributor becomes the sole protected winner. |
| Growing Jackpot | Does not fit one-roll lifetime. | Persistent value shared across separate rolls needs another module. |
| Prophecy | Does not fit one-roll lifetime. | Future-roll linkage and expiry need another module. |
| The Bargain | Not ready for this interface. | Define a concrete cost and how it is charged atomically. |
| The Impostor | Could fit as a one-prize deduction event. | Define clue generation and the winning participant. |

A new compatible event should add an event module, its private content if needed, a roster entry, and contract tests. It should not add a new quota path, claim transaction, Discord listener, or schema table unless its new mechanic genuinely needs one. Multi-prize and cross-roll ideas are distinct seams, not extra methods forced onto this interface.

## Risks and verification targets

- Excluding characters with live cards changes the current behavior that permits duplicate live rolls. The user approved this to keep an event's prize available. The selection query and claim transaction must agree on what counts as live.
- A participant without a claim can win and cause a valuable character to become unclaimable. This is intentional. Show claim availability clearly without disqualifying participation.
- A bot restart can leave a visible but dead event or claim message because the user chose not to edit it. New inputs must remain harmless; the next attempted roll can explain that the event was canceled.
- The slash channel setting needs registration beyond the single `config.guildId` currently used by `index.js` if the bot serves multiple guilds. The setting must still verify server management permission at execution time.
- Keep sensitive transitions atomic: roll debit with event reservation, single active session per guild, winner resolution, puzzle completion on win, and exclusive marriage with claim debit. Discord sends and edits remain outside transactions.
- Focused tests should cover odds anchors and monotonicity, weighted selection with unavailable events, simultaneous rolls, live-card exclusion, event input authorization, deadlines, no-claim winners, countdown/reveal timing, restart cancellation, old-message input, puzzle reuse by guild, and removal of an event from the roster. Test modules through the same interface used by the coordinator.

## Author review

Author review complete for the approved design: one shared coordinator owns quota and claim invariants; event modules own only their local interaction. The design permits addition, disabling, and deletion of one-prize events without editing sensitive roll and marriage paths. The first release contains Doors, Treasure Hunt, and Clue Reveal. Meteor Shower exceeds the one-prize interface and remains a later extension. The five-second mystery card is the shared event introduction.
