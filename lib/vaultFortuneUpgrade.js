import { validateFinalCatalogSchema } from './catalogFinalSchema.js';
import { FORTUNE_DDL } from './vaultFortuneSchema.js';

/** Dedicated offline connection only. Validates the exact pre-Fortune v12 schema,
 * owns an immediate transaction, and rehearses with rollback unless explicitly committed.
 * No startup caller; no reward settlement, network or catalog edits. */
export function upgradeFortuneCatalog(db, { dryRun = true } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    validateFinalCatalogSchema(db, { readOnly: false, fortune: false });
    db.exec(FORTUNE_DDL);
    validateFinalCatalogSchema(db, { readOnly: false });
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { dryRun, committed: !dryRun, catalogVersion: 12, fortuneVersion: 1 };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
