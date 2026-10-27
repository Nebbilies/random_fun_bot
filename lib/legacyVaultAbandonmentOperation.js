import { realpathSync, statSync, existsSync, readFileSync, openSync, closeSync, writeSync, fsyncSync,
  mkdtempSync, rmSync, linkSync, unlinkSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { validateLegacyConversionSchema } from './characterIdentityMigration.js';
import { LEGACY_VAULT_ABANDONMENT_KEY, ABANDONABLE_VAULT_ROLL_IDS, createVaultAbandonmentEntry,
  inspectLegacyVaultAbandonment } from './legacyVaultAbandonment.js';

export const ABANDONMENT_HELP = `Clone-only bounded legacy vault abandonment (authoritative v10).
--database SOURCE --output NEW-CLONE --roll-ids ID[,ID...]
--abandon-without-refund-or-replacement --offline-working-copy --writers-stopped --backup-restore-verified
--reason TEXT --operator LABEL --report NEW-EXTERNAL.jsonl
Allowed observed IDs: ${ABANDONABLE_VAULT_ROLL_IDS.join(',')}. Select only reviewed rows present in this source.
Only explicitly selected observed IDs are eligible. Source is read-only, output must not exist.
Retains vault rows/state and original bindings; adds versioned catalog_meta evidence only.
No refunds, replacements, inventory/payment mutations, delivery claims or network.
Preserve the fsynced external report. Missing outcome means UNCERTAIN; inspect read-only.
`;
const flags = ['abandon-without-refund-or-replacement', 'offline-working-copy', 'writers-stopped', 'backup-restore-verified'];
const values = ['database', 'output', 'roll-ids', 'reason', 'operator', 'report'];
export function parseVaultAbandonmentArgs(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true };
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (![...flags, ...values].includes(key) || Object.hasOwn(o, key)) throw Error(`Unknown/duplicate argument ${args[i]}`);
    if (flags.includes(key)) o[key] = true;
    else { const value = args[++i]; if (!value || value.startsWith('--')) throw Error(`Missing --${key}`); o[key] = value; }
  }
  for (const key of [...flags, ...values]) if (!o[key]) throw Error(`Required --${key}`);
  if (!/^\d+(,\d+)*$/.test(o['roll-ids'])) throw Error('Invalid --roll-ids');
  const ids = o['roll-ids'].split(',').map(Number);
  if (ids.some(id => !ABANDONABLE_VAULT_ROLL_IDS.includes(id)) || new Set(ids).size !== ids.length) throw Error('Only unique explicitly authorized observed roll IDs are permitted');
  for (const key of ['reason', 'operator']) if (!o[key].trim() || o[key].length > 1000) throw Error(`Invalid --${key}`);
  return o;
}
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const newPath = path => join(realpathSync(dirname(resolve(path))), basename(path));
const sidecars = path => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];
const equal = (a, b) => a.toLowerCase() === b.toLowerCase();
function append(fd, record) {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
  for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
  fsyncSync(fd);
}

export async function runVaultAbandonment(options) {
  const o = parseVaultAbandonmentArgs(Object.entries(options).flatMap(([k, v]) => v === true ? [`--${k}`] : [`--${k}`, String(v)]));
  const requested = resolve(o.database), source = realpathSync(requested), output = newPath(o.output), report = newPath(o.report);
  for (const path of [requested, source, output]) if (basename(path).toLowerCase() === 'bot.sqlite') throw Error('Refusing production/default bot.sqlite');
  const sourceStat = statSync(source);
  if (!sourceStat.isFile() || sourceStat.nlink !== 1) throw Error('Source must be a regular independent file, not a hardlink');
  if (sidecars(source).slice(1).some(existsSync) || sidecars(requested).slice(1).some(existsSync)) throw Error('Source must be offline with no SQLite sidecars; use a verified SQLite backup first');
  if (sidecars(output).some(existsSync) || existsSync(report)
    || sidecars(source).some(p => equal(p, output) || equal(p, report))
    || sidecars(output).some(p => equal(p, report))) throw Error('Source/output/report must be separate new paths, with no aliases or sidecars');
  const sourceSha256 = digest(source), operationId = randomUUID(), acknowledgedAt = Date.now();
  const base = { operationId, source, output, report, sourceSha256, acknowledgedAt,
    reason: o.reason, operator: o.operator, rollIds: o['roll-ids'].split(',').map(Number),
    acknowledgements: Object.fromEntries(flags.map(k => [k, true])) };
  const fd = openSync(report, 'wx', 0o600);
  let temp, reader, writer, published = false, failure, result;
  try {
    append(fd, { ...base, phase: 'start', outcome: 'uncertain' });
    temp = mkdtempSync(join(dirname(output), '.vault-abandonment-'));
    const clone = join(temp, 'clone.sqlite');
    reader = new DatabaseSync(source, { readOnly: true });
    validateLegacyConversionSchema(reader);
    await backup(reader, clone);
    reader.close(); reader = undefined;
    if (digest(source) !== sourceSha256 || statSync(source).ino !== sourceStat.ino
      || sidecars(source).slice(1).some(existsSync)) throw Error('Source changed during clone; writers must remain stopped');
    writer = new DatabaseSync(clone);
    writer.exec('BEGIN IMMEDIATE');
    try {
      validateLegacyConversionSchema(writer);
      if (writer.prepare('SELECT 1 FROM catalog_meta WHERE key=?').get(LEGACY_VAULT_ABANDONMENT_KEY)) throw Error('Existing abandonment contract; refusing overwrite or implicit extension');
      const entries = base.rollIds.map(id => createVaultAbandonmentEntry(writer,
        writer.prepare('SELECT * FROM character_rolls WHERE id=?').get(id), base));
      writer.prepare('INSERT INTO catalog_meta(key,value) VALUES(?,?)').run(LEGACY_VAULT_ABANDONMENT_KEY, JSON.stringify({ version: 1, entries }));
      const validation = inspectLegacyVaultAbandonment(writer);
      if (validation.blockers.length) throw Error(validation.blockers.join('\n'));
      if (writer.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || writer.prepare('PRAGMA foreign_key_check').all().length) throw Error('Clone integrity check failed');
      append(fd, { ...base, phase: 'validated-before-clone-commit', outcome: 'uncertain', entries });
      writer.exec('COMMIT');
    } catch (error) { writer.exec('ROLLBACK'); throw error; }
    writer.close(); writer = undefined;
    // SQLite backup is standalone; never publish a clone dependent on sidecars.
    if (sidecars(clone).slice(1).some(existsSync)) throw Error('Clone has unexpected sidecars');
    const cloneFd = openSync(clone, 'r+'); try { fsyncSync(cloneFd); } finally { closeSync(cloneFd); }
    // Exclusive atomic publication, not rename-overwrite. Temp is on same volume.
    linkSync(clone, output); published = true;
    unlinkSync(clone);
    result = { ...base, phase: 'outcome', outcome: 'published', outputSha256: digest(output) };
  } catch (error) { failure = error; }
  finally {
    try { reader?.close(); writer?.close(); } catch (error) { failure ??= error; }
    try { if (temp) rmSync(temp, { recursive: true, force: true }); } catch (error) { failure ??= error; }
  }
  result ??= { ...base, phase: 'outcome', outcome: published ? 'published' : 'not-published', error: failure?.message };
  try { append(fd, result); }
  catch (error) { failure = new Error(`Evidence outcome write failed; outcome=${result.outcome}. NEVER assume rollback; inspect read-only. ${error.message}`, { cause: failure ?? error }); }
  try { closeSync(fd); } catch (error) { failure ??= error; }
  if (failure) { failure.operationReport = result; throw failure; }
  return result;
}
