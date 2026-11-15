import { realpathSync, statSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { inventoryCharacterIdentities, convertLegacyCatalogToFinal } from './characterIdentityMigration.js';
import { assertCatalogRuntimeRestartReady } from './catalogRuntimeRecovery.js';

export const CONVERSION_HELP = `Offline catalog conversion: authoritative v10 -> pre-ranking v12 ONLY. Never use production or the recovery backup.
This is a prerequisite: the new application also requires the explicit character ranking cutover with approved CSVs.
Usage: node scripts/migrateCharacterIdentities.js --database /path/offline-working.sqlite
  [--rehearse | --commit]
Default: read-only inventory. --rehearse: conversion with unconditional rollback.
--commit requires ALL of:
  --offline-working-copy --backup-restore-verified --writers-stopped --conversations-drained
  --source-app-commit HEX --source-runtime REF --target-app-commit HEX --target-runtime REF
  --backup-ref REF --restore-ref REF --rehearsal-ref REF --report /path/new-operation.jsonl
References are non-secret artifact labels (letters/digits and ._:/@+- only), not credentials or URLs.
Persisted game_maintenance=drain is required for commit, checked under BEGIN IMMEDIATE.
Report is exclusively created and fsynced before database writes. Preserve it even on failure.
Never rerun conversion on v12: inspect with the predecessor validator/runtime guard before the ranking cutover.
No settlement, refunds, delivery acknowledgement clearing, network calls or service orchestration.
`;
const flags = new Set(['rehearse', 'commit', 'offline-working-copy', 'backup-restore-verified', 'writers-stopped', 'conversations-drained']);
const refs = ['source-app-commit', 'source-runtime', 'target-app-commit', 'target-runtime', 'backup-ref', 'restore-ref', 'rehearsal-ref'];
const acks = ['offline-working-copy', 'backup-restore-verified', 'writers-stopped', 'conversations-drained'];
export function parseConversionArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if ((!flags.has(key) && !refs.includes(key) && !['database', 'report'].includes(key)) || Object.hasOwn(result, key)) {
      throw new Error(`Unknown or duplicate argument: ${args[i]}`);
    }
    if (flags.has(key)) result[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for --${key}`);
      result[key] = value;
    }
  }
  if (!result.database) throw new Error('--database is required');
  if (result.commit && result.rehearse) throw new Error('--commit and --rehearse are mutually exclusive');
  if (result.commit) {
    for (const key of [...acks, ...refs, 'report']) if (!result[key]) throw new Error(`--commit requires --${key}`);
    for (const key of refs) {
      const pattern = key.endsWith('app-commit') ? /^[a-f0-9]{7,64}$/i : /^[a-z0-9][a-z0-9._:/@+\-]{0,159}$/i;
      if (!pattern.test(result[key]) || result[key].includes('://')) throw new Error(`Invalid non-secret reference --${key}`);
    }
  } else if ([...acks, ...refs, 'report'].some(key => Object.hasOwn(result, key))) {
    throw new Error('Commit acknowledgements/references/report are only accepted with --commit');
  }
  return result;
}
export function safeDatabasePath(database) {
  const requested = resolve(database);
  const production = resolve(dirname(fileURLToPath(import.meta.url)), '../data/bot.sqlite');
  const refused = path => path.toLowerCase() === production.toLowerCase() || basename(path).toLowerCase() === 'bot.sqlite';
  if (refused(requested)) throw new Error('Refusing production/default bot.sqlite; use a separately named offline working copy');
  const path = realpathSync(requested);
  if (refused(path)) throw new Error('Refusing production/default bot.sqlite (including symlink aliases)');
  const stat = statSync(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Working copy must be a regular file, not a hard-linked database');
  return path;
}
function measurements(db) {
  const counts = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    counts[name] = db.prepare(`SELECT count(*) n FROM "${name.replaceAll('"', '""')}"`).get().n;
  }
  return { version: db.prepare('PRAGMA user_version').get().user_version, counts,
    sequences: db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all() };
}
// A single append-only resource: start/validated records survive lost final evidence.
// A start or validated record without an outcome means UNCERTAIN, never rollback.
export function createEvidence(path) {
  const fd = openSync(path, 'wx', 0o600);
  return { append(record) {
    const data = Buffer.from(`${JSON.stringify(record)}\n`);
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
    fsyncSync(fd);
  }, close() { closeSync(fd); } };
}
export function runCatalogConversion(options) {
  // Revalidate programmatic callers through the same strict operator boundary.
  const args = Object.entries(options).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)]);
  const o = parseConversionArgs(args);
  const path = safeDatabasePath(o.database);
  if (!o.commit) {
    const db = new DatabaseSync(path, { readOnly: !o.rehearse });
    try { return o.rehearse ? convertLegacyCatalogToFinal(db) : inventoryCharacterIdentities(db); }
    finally { db.close(); }
  }
  const reportPath = join(realpathSync(dirname(resolve(o.report))), basename(o.report));
  if ([path, `${path}-wal`, `${path}-shm`, `${path}-journal`].some(p => p.toLowerCase() === reportPath.toLowerCase())) {
    throw new Error('Report must be separate from database and SQLite sidecars');
  }
  const operationId = randomUUID(), startedAt = new Date().toISOString();
  const evidence = createEvidence(reportPath);
  const base = { operationId, database: path, reportPath, sourceVersion: 10, targetVersion: 12,
    references: Object.fromEntries(refs.map(key => [key, o[key]])),
    acknowledgements: Object.fromEntries(acks.map(key => [key, true])), startedAt, nodeRuntime: process.version };
  let db, committed = false, result, failure, outcome = 'uncertain';
  try {
    evidence.append({ ...base, phase: 'start', outcome: 'uncertain' });
    // No source normalization, initializer or normal writable opener here.
    db = new DatabaseSync(path);
    if (db.prepare('PRAGMA user_version').get()?.user_version === 12) {
      throw new Error('Already v12: conversion rerun refused; inspect with openCatalogReadOnly and inspectCatalogRuntimeRestart, do not convert again');
    }
    result = convertLegacyCatalogToFinal(db, { dryRun: false, requireDrain: true,
      validateFinalBeforeCommit(connection, before) {
        const runtime = assertCatalogRuntimeRestartReady(connection);
        const after = measurements(connection);
        evidence.append({ ...base, phase: 'validated-before-commit', outcome: 'uncertain',
          validatedAt: new Date().toISOString(), ...before, after,
          validation: { authoritativeFinalSchema: true, integrity: 'ok', foreignKeys: 'ok', persistedDrain: true, runtime } });
      } });
    committed = true; outcome = 'committed';
  } catch (error) { failure = error; }
  finally {
    try { if (db) db.close(); } catch (error) { failure ??= error; }
  }
  // Inspect a NEW read-only connection after closing: never mistake uncommitted
  // schema visible on the writer for a durable commit after a cleanup exception.
  if (!committed) {
    let inspect;
    try {
      inspect = new DatabaseSync(path, { readOnly: true });
      const version = inspect.prepare('PRAGMA user_version').get()?.user_version;
      outcome = version === 10 ? 'not-committed' : 'uncertain';
    } catch { /* retain uncertainty */ }
    finally { try { inspect?.close(); } catch { /* retain primary failure */ } }
  }
  const report = { ...base, phase: 'outcome', finishedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(startedAt), outcome, result,
    error: failure?.message, blockers: failure?.report?.blockers };
  try { evidence.append(report); }
  catch (error) {
    failure = new Error(`Evidence outcome write failed; database outcome=${outcome}. Preserve start record and inspect read-only; NEVER assume rollback. ${error.message}`, { cause: failure ?? error });
  }
  try { evidence.close(); } catch (error) { failure ??= error; }
  if (failure) { failure.operationReport = report; throw failure; }
  return report;
}
