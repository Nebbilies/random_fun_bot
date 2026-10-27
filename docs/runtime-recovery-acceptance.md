# Runtime recovery: separate acceptance scope

Runtime recovery is a reliability feature introduced alongside manual catalog management. It is not a new requirement of the original manual-character design. Keep its acceptance and limitations separate from catalog mutation and migration acceptance. The already integrated recovery code remains in this release because removing it would strand supported paid actions after a restart.

## Supported behavior

| Runtime | Acceptance evidence |
| --- | --- |
| Reserved ordinary delivery, durable presentation and canonical claim binding | `test/pendingRollRecovery.test.js`, `test/rollDeliveryPublishedTerms.test.js` |
| Open escape and paid Whistle/Siren recovery with original terms and deadlines | `test/escapeRuntimeRecovery.test.js`, `test/binocularsRecovery.test.js` |
| Versioned mystery phases and determined outcomes | `test/mysteryRuntimeRecovery.test.js`, `test/mysterySnapshotIntegrity.test.js` |
| Paid/unopened vaults and Golden Hour costs | `test/vaultSessionRecovery.test.js`, `test/paidVaultRecovery.test.js` |
| Whole-runtime startup refusal/recovery boundaries | `test/catalogRuntimeRestart.test.js`, `test/runtimeRestartSafety.test.js` |

Database costs and awards must not duplicate on retry. Recovery must not reselect a character, reset a deadline, or invent a historical outcome. Read-only preflight runs before Discord login; supported recovery runs before game ingress and retries transient transport failures.

## Explicit limits

- Discord delivery between send and database acknowledgement is not proven exactly once. Nonce deduplication is time limited.
- Trade/gift conversations remain in memory and expire on restart without transferring ownership.
- Ambiguous historical paid states require reviewed reconciliation. Migration does not infer refunds from inventory IDs or remaining charges.
- Bounded legacy vault abandonment is an explicit operator decision recorded separately. It preserves rows, has no compensation, and cannot waive unrelated missing terms or corrupt state.

Do not expand this scope into universal historical recovery, a general undo system, or a replacement payment ledger as part of catalog work. New reliability behavior requires its own concrete acceptance case.
