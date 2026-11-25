# Fortune rollout audit — implementation follow-up

Status: Historical review log. All listed runtime and provenance findings were fixed with regression tests. Final review also found that ephemeral follow-ups require interaction-webhook editing (not ordinary Message.edit); fixed and tested in db4d241. Final release validation is recorded in docs/fortune-validation.md. Offline-only migration recommendations below are superseded by the user's correction: small additive Fortune tables migrate automatically on ordinary writable startup. Unknown schemas still fail safely.

## Final provenance follow-up (sa-8)

P1 chosen Recast while reward remains recast passes validator, strands reward; chosen terminal reward must match persisted selection, unresolved reward must match decision original.
P2 bidirectional hold provenance: armed Recast must match hold kind/owner/source; Lens hold/source owner must match vault session, not just each other. Assigned sa-10 fixes/tests.

## Independent runtime review (sa-6)

P1: canonical Lens refund inspection must force REST: channel.messages.fetch({ message: session.messageId, force: true }); default fetch can return stale discord.js cache and falsely refund shown Lens.

P1: async Lens publication races slot selection: gated Lens update can finish AFTER reward update and overwrite a delivered reward with an enabled vault card. Serialize canonical-card writes per vault across Lens/selection/recovery and reconcile latest durable state before unlocking. Review reproduced delivered reward with no recovery pending but stale vault UI.

P1: Lens renders candidate item name/description directly, bypasses getVaultItemPresentation special Kaimetsu mask. Apply guild-aware presentation mask while persisting real outcomes. Preview alone is not discovery.

P2: automatic followUp Recast adapter disables editReply, leaving charged prompt without actual deadline. Retain returned followUp Message and edit that private message after presentRecast; never edit original public reply.

Review ran 24 focused tests passing but reproduced race independently. Fix each with regression test before PR.

Read-only audit while implementation was in progress. These are not final review results.

1. Validate holds across inventory owner/item/kind, Lens/vault or armed/Recast provenance, positive Recast charges, and absence of dual item_action_costs escrow. Terminal historical records may reference deleted source IDs. Restart preflight must block corrupt/orphan holds without mutation.
2. Explicit `deadline IS NOT NULL` is needed in presented/chosen Recast CHECK clauses: SQLite accepts NULL CHECK results. Validate timestamps/durations and selected index against actual pool size.
3. Require exactly one supported fortune_schema version row; table existence alone is insufficient.
4. Provide guarded offline upgrade script/procedure and actionable startup error. Existing character identity migration refuses v12 reruns, so it cannot serve as the Fortune operator entry point.
5. Upgrade tests should use file-backed pre-Fortune schema fixture independent of the evolving target, and cover dry-run, committed/repeat/refused upgrade, caller-owned transaction rejection, late rollback, normal/strict read-only/writable opening and old snapshot preservation.
6. File-backed Lens tests should cover zero-charge holds, full-inventory refund, multi-charge source and terminal historical entries with deleted source.

Checkpoint typecheck output is in `.fortune-typecheck.log` (initial TS errors in vaultRuntime, while code still being written). Full suite checkpoint in `.fortune-baseline-tests.log` had 1143 passes, one skipped, only failure was new vaultFortune test module being written during run. Focused original baseline was 34/34.

Runtime review caution: spreading a real discord.js interaction instance into `{ ...interaction }` drops prototype methods/getters (notably `message`/`editReply` etc.); avoid this pattern for followUp/private-prompt adapters. Pass explicit bound methods and canonical public message. Initial resume prompts should show the actual deadline after presentation, not just a pre-presentation statement.

Deployment CI uses scripts/deploy.sh with no schema-upgrade step. Do not auto-upgrade live DB, but clearly warn that merging requires the offline Fortune upgrade before starting new code or the final-schema validator will reject old v12. PR should call this out prominently.

Confirmed: zero-charge rows are permitted by current authoritative inventory DDL. Focused baseline schema/storage/Fortune suites passed 101 tests during the audit.
