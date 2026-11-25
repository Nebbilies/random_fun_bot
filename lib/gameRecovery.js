/** Ordered recovery used by both startup and the non-overlapping periodic worker.
 * Reveal recovery precedes affection materialization and one scheduled reward sweep.
 * @param {{db: any, client: any, imagePicker?: any, startup?: boolean,
 * observer?: any, operations: any}} context
 */
export async function runGameRecovery({
  db,
  client,
  imagePicker,
  startup = false,
  observer,
  operations,
}) {
  const stats = {};
  const stage = (name, work) => (observer ? observer.run(name, work) : work());
  if (startup) {
    await stage("binoculars", () => operations.recoverBinocularsUses(db));
    await stage("item-actions", () =>
      operations.recoverItemActionRuntime(db, client),
    );
  }
  await stage("roll-deliveries", () =>
    operations.recoverPendingRollDeliveries(db, client),
  );
  await stage("forced-escapes", () =>
    operations.recoverForcedEscapes(db, client),
  );
  await stage("open-escapes", () => operations.recoverOpenEscapes(db, client));
  await stage("mysteries", () =>
    operations.recoverMysteryRuntime({ db, client, imagePicker }),
  );
  await stage("vault-sessions", () =>
    operations.recoverVaultSessions(db, client, {
      recoverRewards: false,
      stats,
    }),
  );
  await stage("affection-rewards", () =>
    operations.recoverSelectedAffectionRewards(db),
  );
  await stage("vault-rewards", () =>
    operations.recoverVaultRewards(db, client, { stats }),
  );
  await stage("item-expiry", () => operations.cleanupExpiredItems(db));
  return stats;
}
