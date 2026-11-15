import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRankingOperationArgs, runRankingOperation } from '../lib/catalogRankingOperation.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installEmptyFinalCatalog, validateFinalCatalogSchema as validatePredecessor } from '../lib/catalogPreRankingSchema.js';
import { openFinalCatalogReadOnly } from '../lib/catalogDb.js';
import { readRankingInputs } from '../lib/catalogRankingInputs.js';
test('ranking operation requires explicit inputs and rejects ambiguous modes and unacknowledged commit', () => {
  const base = ['--db', 'working.sqlite', '--danbooru-csv', 'dan.csv', '--mudae-csv', 'mudae.csv', '--report', 'new.jsonl'];
  assert.equal(parseRankingOperationArgs(base).commit, undefined);
  assert.throws(() => parseRankingOperationArgs([...base, '--commit']), /requires/);
  assert.throws(() => parseRankingOperationArgs([...base, '--rehearse', '--commit']), /exclusive/);
  assert.throws(() => parseRankingOperationArgs([...base, '--db', 'other']), /duplicate/);
  assert.throws(() => parseRankingOperationArgs([...base, '--force']), /Unknown/);
});

test('offline operation inventories, rolls back, commits and retries with durable review evidence', { skip: process.version !== 'v22.23.2' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'ranking-operation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'working.sqlite'), danbooru = join(dir, 'danbooru.csv'), mudae = join(dir, 'mudae.csv');
  const id = '00000000-0000-4000-8000-000000000001';
  const db = new DatabaseSync(path);
  installEmptyFinalCatalog(db);
  db.prepare("INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')").run(id);
  db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source) VALUES(?,1,0,1,'generated')").run(id);
  db.exec("INSERT INTO catalog_meta VALUES('game_maintenance','drain')"); db.close();
  writeFileSync(danbooru, `character_id,full_name,tag,danbooru_post_count\n${id},Example,series,149200\n`);
  writeFileSync(mudae, `character_id,full_name,mudae_name,mudae_rank,mudae_character_url,mudae_gallery_image_urls\n${id},Example,Example,1,https://mudae.net/character/1/example,ignored-gallery\n`);
  const base = { db: path, 'danbooru-csv': danbooru, 'mudae-csv': mudae };
  const run = (name, extra = {}) => runRankingOperation({ ...base, report: join(dir, `${name}.jsonl`), ...extra });
  const inventory = run('inventory');
  assert.equal(inventory.outcome, 'read-only'); assert.equal(inventory.result.changes[0].after.efficiency, 2);
  assert.throws(() => run('inventory'), /EEXIST/);
  const rehearsal = run('rehearsal', { rehearse: true });
  assert.equal(rehearsal.outcome, 'rolled-back');
  const reopened = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(validatePredecessor(reopened), true); } finally { reopened.close(); }
  const hashes = readRankingInputs(danbooru, mudae).hashes;
  const commit = { commit: true, actor: 'operator', 'expected-revision': '0',
    'expected-danbooru-hash': hashes.danbooru, 'expected-mudae-hash': hashes.mudae,
    'offline-working-copy': true, 'backup-restore-verified': true, 'writers-stopped': true, 'conversations-drained': true,
    'source-app-commit': 'a'.repeat(40), 'target-app-commit': 'b'.repeat(40), 'source-runtime': 'node22.23.2',
    'target-runtime': 'node22.23.2', 'backup-ref': 'backup-verified', 'restore-ref': 'restore-verified', 'rehearsal-ref': 'rehearsal.jsonl' };
  assert.throws(() => run('stale', { ...commit, 'expected-revision': '1' }), /Stale/);
  const result = run('commit', commit);
  assert.equal(result.outcome, 'committed');
  assert.deepEqual(result.result.preservation.before, result.result.preservation.after);
  const current = openFinalCatalogReadOnly(path);
  try { assert.equal(current.prepare('SELECT legacy_rank FROM characters').get().legacy_rank, 1); } finally { current.close(); }
  assert.equal(run('retry', commit).outcome, 'already-committed');
  const evidence = readFileSync(join(dir, 'rehearsal.jsonl'), 'utf8');
  assert.match(evidence, /validated-before-commit/); assert.match(evidence, /"danbooru_post_count":149200/);
  assert.doesNotMatch(evidence, /ignored-gallery/);
  assert.throws(() => run('changed', { ...commit, 'expected-danbooru-hash': 'f'.repeat(64) }), /hashes changed/);
});
