import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, basename, join } from 'node:path';
import { realpathSync, statSync, existsSync, openSync, closeSync, writeSync,
  fsyncSync, mkdtempSync, linkSync, unlinkSync, rmSync, chmodSync, createReadStream } from 'node:fs';
import { validateFinalCatalogSchema } from './catalogFinalSchema.js';
import { inspectCatalogRuntimeRestart } from './catalogRuntimeRecovery.js';
import { inspectLegacyVaultAbandonment, LEGACY_VAULT_ABANDONMENT_KEY as key } from './legacyVaultAbandonment.js';

const reviewed = [17317, 17358];
export const RETIREMENT_HELP = `Retire reviewed final-schema legacy vault exceptions. Read-only dry-run by default.
--database EXISTING --roll-ids 17317,17358
Apply additionally requires --apply --writers-stopped --backup NEW.sqlite --archive NEW.jsonl --operator LABEL --reason TEXT
Stop every bot/portal writer first. Backup/archive paths must be new, outside the database and its sidecars.
Only the reviewed rolls, their notices and abandonment contract are removed. No refunds or player changes.
An uncertain outcome requires read-only inspection; never assume rollback or overwrite backup/evidence.
`;
export function parseVaultRetirementArgs(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    database: { type: 'string' }, 'roll-ids': { type: 'string' }, apply: { type: 'boolean' },
    'writers-stopped': { type: 'boolean' }, backup: { type: 'string' }, archive: { type: 'string' },
    operator: { type: 'string' }, reason: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) return values;
  if (!values.database || !values['roll-ids']) throw Error('Explicit --database and --roll-ids are required');
  const ids = values['roll-ids'].split(',').map(Number).sort((a, b) => a - b);
  if (!/^\d+,\d+$/.test(values['roll-ids']) || JSON.stringify(ids) !== JSON.stringify(reviewed)) throw Error('Only reviewed roll IDs 17317,17358 may be retired together');
  if (values.apply) {
    for (const name of ['writers-stopped', 'backup', 'archive', 'operator', 'reason']) {
      if (!values[name] || typeof values[name] === 'string' && (!values[name].trim() || values[name].length > 4096)) throw Error(`Apply requires --${name}`);
    }
  }
  return values;
}
function inspect(db, readOnly) {
  validateFinalCatalogSchema(db, { readOnly });
  const contract = db.prepare('SELECT value FROM catalog_meta WHERE key=?').get(key)?.value;
  const rolls = db.prepare('SELECT * FROM character_rolls WHERE id IN (?,?) ORDER BY id').all(...reviewed);
  if (contract === undefined) {
    if (rolls.length) throw Error('Inconsistent retirement: reviewed rolls remain without abandonment evidence');
    return null;
  }
  const validation = inspectLegacyVaultAbandonment(db);
  if (validation.blockers.length) throw Error(validation.blockers.join('\n'));
  if (JSON.stringify([...validation.ids].sort((a, b) => a - b)) !== JSON.stringify(reviewed)) throw Error('Unexpected abandonment entries; only the two reviewed rolls may be retired');
  const runtime = inspectCatalogRuntimeRestart(db);
  if (!runtime.ready) throw Error(`Restart readiness failed: ${JSON.stringify(runtime.blockers)}`);
  const notices = db.prepare('SELECT * FROM roll_notices WHERE roll_id IN (?,?) ORDER BY roll_id,user_id').all(...reviewed);
  return { contract, rolls, notices };
}
function syncDirectory(path) {
  if (process.platform === 'win32') return; // Windows does not expose directory fsync through Node.
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function append(fd, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  fsyncSync(fd);
}
function newPath(path) { return join(realpathSync(dirname(resolve(path))), basename(resolve(path))); }
const sidecars = path => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Explicit operation only. Never called by startup, deployment or normal commands. */
export async function runVaultRetirement(options) {
  const o = parseVaultRetirementArgs(Object.entries(options).filter(([, v]) => v !== false && v !== undefined)
    .flatMap(([k, v]) => v === true ? [`--${k}`] : [`--${k}`, String(v)]));
  if (o.help) return { help: RETIREMENT_HELP };
  const database = realpathSync(resolve(o.database));
  const sourceStat = statSync(database);
  if (!sourceStat.isFile() || sourceStat.nlink !== 1) throw Error('Database must be a regular file without hardlink aliases');
  let db = new DatabaseSync(database, { readOnly: true });
  let initial;
  try {
    db.exec('BEGIN');
    initial = inspect(db, true);
    db.exec('COMMIT');
  } finally { db.close(); }
  if (!initial) return { outcome: 'not-applicable', rollIds: reviewed };
  if (!o.apply) return { outcome: 'dry-run', rollIds: reviewed, ...initial };
  const backup = newPath(o.backup), archive = newPath(o.archive);
  const paths = [...sidecars(database), ...sidecars(resolve(o.database))];
  const equal = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (sidecars(backup).some(existsSync) || existsSync(archive)
    || paths.some(path => equal(path, backup) || equal(path, archive))
    || sidecars(backup).some(path => equal(path, archive))) throw Error('Backup and archive must be separate new paths, not database/sidecar aliases');
  const operationId = randomUUID(), startedAt = Date.now();
  let archiveFd, temporary, reader, transaction = false, commitAttempted = false, committed = false;
  let result, failure;
  try {
    db = new DatabaseSync(database);
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE'); transaction = true;
    if (statSync(database).ino !== sourceStat.ino) throw Error('Database identity changed; inspect before retrying');
    const current = inspect(db, false);
    if (JSON.stringify(current) !== JSON.stringify(initial)) throw Error('Legacy records changed after inspection');
    temporary = mkdtempSync(join(dirname(backup), '.vault-retirement-'));
    const copy = join(temporary, 'backup.sqlite');
    reader = new DatabaseSync(database, { readOnly: true });
    await sqliteBackup(reader, copy);
    reader.close(); reader = undefined;
    chmodSync(copy, 0o600);
    const fd = openSync(copy, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(copy, backup); unlinkSync(copy); syncDirectory(dirname(backup));
    const backupSha256 = await digest(backup);
    archiveFd = openSync(archive, 'wx', 0o600);
    append(archiveFd, { phase: 'before-retirement', outcome: 'uncertain', operationId, startedAt,
      database, backup, backupSha256, operator: o.operator, reason: o.reason, rollIds: reviewed, ...current });
    syncDirectory(dirname(archive));
    db.prepare('DELETE FROM roll_notices WHERE roll_id IN (?,?)').run(...reviewed);
    const deleted = db.prepare('DELETE FROM character_rolls WHERE id IN (?,?)').run(...reviewed);
    if (Number(deleted.changes) !== reviewed.length || db.prepare('DELETE FROM catalog_meta WHERE key=? AND value=?').run(key, current.contract).changes !== 1) throw Error('Retirement changed an unexpected record count');
    validateFinalCatalogSchema(db, { readOnly: false });
    const runtime = inspectCatalogRuntimeRestart(db);
    if (!runtime.ready) throw Error(`Post-retirement restart readiness failed: ${JSON.stringify(runtime.blockers)}`);
    append(archiveFd, { phase: 'validated-before-commit', outcome: 'uncertain', operationId });
    commitAttempted = true;
    db.exec('COMMIT'); transaction = false; committed = true;
    result = { outcome: 'committed', operationId, rollIds: reviewed, backup, archive, backupSha256 };
    append(archiveFd, { phase: 'outcome', ...result });
  } catch (error) {
    failure = error;
    let rollbackFailed = false;
    if (transaction) { try { db.exec('ROLLBACK'); transaction = false; } catch { rollbackFailed = true; } }
    const outcome = committed || rollbackFailed || commitAttempted ? 'uncertain' : 'rolled-back';
    result = { outcome, operationId, rollIds: reviewed, backup, archive, error: error.message };
    if (archiveFd !== undefined) { try { append(archiveFd, { phase: 'outcome', ...result }); } catch { /* Precommit archive remains authoritative evidence of uncertainty. */ } }
  } finally {
    for (const close of [() => reader?.close(), () => db?.close(), () => { if (archiveFd !== undefined) closeSync(archiveFd); },
      () => { if (temporary) rmSync(temporary, { recursive: true, force: true }); }]) {
      try { close(); } catch (error) { failure ??= error; if (committed) result = { ...result, outcome: 'uncertain' }; }
    }
  }
  if (failure) {
    const error = new Error(`Legacy retirement outcome=${result.outcome}. ${result.outcome === 'uncertain' ? 'NEVER assume rollback; inspect read-only. ' : ''}${failure.message}`, { cause: failure });
    error.operationReport = result;
    throw error;
  }
  return result;
}
