# Phase 2 item rollout

Implementation branch: `feat/items-phase-2`. See the approved design and implementation plan in this directory. Verification results are recorded separately when complete.

## Deployment behavior

Normal writable final-v12 startup installs the recognized additive ownership-history and reward-source extensions under the existing first-start migration lock. No manual destructive identity conversion is required for an already-current final database. The upgrader validates the exact predecessor and resulting schema; unknown or partially installed layouts fail closed. Read-only tools do not install extensions and report that writable startup is needed.

History starts empty at installation. Existing owners qualify if they lose a character afterward; earlier losses cannot be reconstructed. Records follow retained stable identities and are separate per server/former owner. Enlarging the Chronicle period can expose older recorded losses; it cannot invent pre-deployment history. Current ownership remains authoritative.

## Operator settings

The Configuration portal exposes both items' starting charges/reward eligibility, Chit's independent tier weights and Chronicle's history window. Defaults: one charge per copy; Common/Rare/Epic/Legendary/??? weights 69.9/17.5/10/2.5/0.1; Chronicle period seven days. Normal vault odds are unchanged. Existing inventory entries and started actions retain their captured terms.

Chit is passive: a genuine mystery winner with no available claim receives a saved item reward after the character reveal. Extra bypass claim tokens count as available claims. Receiving another Chit does not recurse. It is not a compensation vault and never invokes Lens, Recast or Double or Nothing. Overflow uses the existing replacement/decline controls; declining does not refund the spent Chit.

Chronicle uses the existing prefix-command/inventory activation and an owner-only confirmation. It creates fresh ownership without altering normal claim state. Only currently unowned, published, available characters with a qualifying recorded loss can return.

The latest maintained item-list release announces these items above the catalog container. Names remain masked independently until discovered in the viewing server.

## Recovery and limitations

Database transactions protect costs, outcomes, ownership changes and retry identities. Recovery must never redraw a Chit reward or repeat a Chronicle acquisition. Chit announcement recovery is gated by the durable character-reveal acknowledgement, including terminal mystery sessions with pending reveal obligations.

Discord and SQLite do not share a transaction. Saved canonical messages/nonces reduce duplicate sends, but a sufficiently delayed retry after a successful Discord send whose acknowledgement was lost can duplicate presentation or a ping. It must not duplicate inventory rewards or charges.

An older binary may reject the extended exact schema. Do not automatically drop the new tables/triggers to downgrade: doing so would destroy history continuity. Prefer a compatible build that disables the new items while retaining history and recovery support. Take normal deployment backups before upgrading.

Development uses temporary/in-memory databases and fake Discord transports only. No live database migration, bot startup or live Discord action is part of implementation verification.
