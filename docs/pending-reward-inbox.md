# Pending item reward inbox

Use the server's prefix followed by `rewards` (for example `!rewards`) to open
one paginated Components V2 message showing the caller's pending item rewards.
The current item's rarity determines the accent; rarity name/emoji, source, and
pending age are also shown. Normal inventory items already delivered are not
pending rewards.

Overflow rewards offer Accept when space exists, Manage when full, and explicit
Decline. Manage opens an ephemeral inventory selector; choosing an entry discards
that entry and takes the saved reward atomically. Reserved inventory entries are
not selectable. Pagination and private controls expire normally; rerun the
command after expiry/restart. Private panels use the interaction webhook editor.

Keep/Gamble and Recast decisions link to their existing original controls rather
than implicitly selecting an outcome. Unbound rewards await ordinary publication
recovery. The inbox never rebinds the canonical reward message, rerolls a reward,
or resets a deadline. Settlement validates both the inbox owner/message scope
and the saved canonical reward scope and uses existing transactional settlement
and per-reward write serialization. Old cards cannot settle a reward twice.
Canonical card updates are best-effort; recovery handles failed updates. A
private confirmation failure does not report a committed replacement as unsaved
or prevent refreshing the inbox.

Affection views point to the prefix-aware rewards command for selected pending
rewards. Owed entitlements without a selected item still use the existing `aff`
retry mechanism. No schema migration or new background worker is needed.

Validation: Node 22.23.2 full suite (1,780 passed, one skipped), catalog typecheck,
focused inbox/affection tests, diff checks, and independent review. No live
Discord interaction acceptance test was performed before publication.
