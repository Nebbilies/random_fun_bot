# Batch character trade, gift, and divorce design

## Goal

Let players submit several character names in the existing prefix commands. Resolve every name, show the entire batch, then apply the confirmed changes together.

## Options

| Input | Fits best | Tradeoff |
| --- | --- | --- |
| Names separated by `$` | Players who know which characters they want | Misspelled or shared names can require a picker. |
| Discord string multi-select | Players browsing a small harem | Each menu holds up to 25 options. Larger harems need pagination, selection tracking across pages, and a review step. |

Use typed lists with the existing harem display. Use single-select menus for individual names that need clarification.

## Player flow

- `!trade @user` and its `!me` alias keep the current conversation. The initiator submits their batch, the recipient submits theirs, and the initiator confirms the exchange. The two sides can have different counts, with at least one character per side.
- `!give @user` prompts the giver for a batch and the recipient for confirmation.
- `!divorce Makima$Power` requests a divorce for both characters. The existing administrator targeting syntax and permission checks also apply to batch requests.
- `Makima$Power` and `Makima $ Power` are equivalent. Split on `$`, trim surrounding whitespace, and flag empty entries. A single name still works. The existing `#rank` lookup can identify a character whose name contains a literal `$`.
- Allow up to 10 characters per trade side, gift, or divorce request.
- Resolve each entry against the appropriate owner's harem using the existing name and rank lookup. Handle ambiguous entries one at a time, with the input name shown above its select menu. Let players page through lists with more than 25 matches. Ask them to choose any fuzzy match in a batch explicitly. Preserve single-name matching behavior.
- Report an unmatched entry or a duplicate character and ask for a corrected list. Detect duplicates by character ID after resolution so a name and an alias for the same character also count as a duplicate. Replacing a trade or gift answer invalidates its earlier pickers.
- Show each selected character's name and rank before confirmation. List the two sides of a trade separately and label each by its current owner. Keep existing confirmation roles, trade and gift text replies, buttons, cancellation, and expiry.

## Ownership and failure handling

- Keep character IDs opaque, and record each selected character's current marriage ID and owner. Register every accepted trade or gift selection with the existing pending transfer registry. An exact marriage match anywhere in either side lets Kaimetsu cancel the entire session after its own commit.
- Recheck every selected marriage and the action's existing eligibility rules at confirmation. Recheck administrator permission for divorce on behalf of another owner. Apply the whole batch in one SQLite transaction. A stale marriage, a failed eligibility check, or a write failure leaves all ownership changes in that batch unapplied.
- Reuse transfer checks, exact-marriage divorce semantics, the ownership history clock, and Crown invalidation. Use the current catalog schema and command registration.
- Report the character and reason for an eligibility failure when available. Expired or superseded controls cannot apply ownership changes. A repeated confirmation can apply the batch at most once.

## Acceptance checks

- Equivalent spaced and unspaced lists work across all three commands. Empty entries, too many entries, duplicate aliases, unresolved names, and stale picker interactions receive clear responses.
- A valid two-for-one trade applies both sides together. A valid gift or divorce applies every selected character together. Confirmations list every selected character and follow existing consent rules.
- When a later character is blocked or a later write fails, earlier characters keep their owners and the operation leaves no partial ownership history or Crown changes.
- Pending trade and gift reservations include all accepted selections and are cleared when the session ends. Kaimetsu can cancel a session through any exact marriage in either side.
- Existing single-character tests and both UUID and legacy character ID paths pass.
