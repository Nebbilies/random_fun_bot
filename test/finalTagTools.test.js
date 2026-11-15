import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog, openFinalCatalog, openCatalog, saveDecision, setMeta } from '../lib/catalogDb.js';
import { matchTags, refreshAliasCounts, removeSavedAliasSources, approveSearchedByCount } from '../scripts/matchCharacterTags.js';
import { matchGoogleTags } from '../scripts/matchGoogleTags.js';
import { matchDuckDuckGoTags } from '../scripts/matchDuckDuckGoTags.js';

import { captureRankingTagEvidence } from '../lib/catalogRankingEvidence.js';

const id = '12345678-1234-4123-8123-123456789abc';
const tag = { name: 'test_person', category: 4, is_deprecated: false, post_count: 100 };
const url = 'https://danbooru.donmai.us/posts?tags=test_person';
const quiet = () => {};
function fixture(t, { empty = false, legacy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'final-tag-tools-'));
  const path = join(dir, 'synthetic.sqlite');
  const db = legacy ? openCatalog(path) : createFinalCatalog(path);
  const connections = [db];
  t.after(() => { for (const connection of connections) connection.close(); rmSync(dir, { recursive: true, force: true }); });
  if (!empty && !legacy) {
    db.prepare("INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')").run(id);
    db.prepare(`INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full)
      VALUES (?,1,0,1,'generated','Test Person')`).run(id);
  }
  return { db, path, connections };
}
function options(db, onVerify = quiet) {
  const verify = async () => {
    assert.equal(db.isTransaction, false, 'verification must not hold the writer');
    await onVerify();
    return tag;
  };
  return { db, limit: 1, delayMs: 0, log: quiet, apply: true,
    api: { candidates: async () => [await verify()], exactTag: verify, verifyRankingTag: async name => captureRankingTagEvidence(name, await verify()), aliases: async () => [] },
    fetchImpl: async () => ({ status: 200, text: async () =>
      `<a class="result-link" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}">Result</a>` }),
    page: {
      goto: async () => ({ status: () => 200 }), title: async () => 'Results', url: () => 'https://www.google.com/search',
      locator: () => ({ count: async () => 0, first: () => ({ waitFor: async () => {} }),
        evaluateAll: async () => [{ url, title: 'Result' }] }),
    },
  };
}
const tools = { character: matchTags, Google: matchGoogleTags, DuckDuckGo: matchDuckDuckGoTags };
const revision = db => db.prepare('SELECT revision FROM catalog_state WHERE singleton=1').get().revision;
const snapshot = db => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);

for (const [name, run] of Object.entries(tools)) {
  for (const marker of [null, 'scanning']) test(`${name}: manual-only final ignores import marker ${marker}`, async t => {
    const { db, path } = fixture(t);
    if (marker) setMeta(db, 'import_phase', marker);
    const before = revision(db);
    await run(options(db));
    assert.equal(db.prepare('SELECT tag_name FROM tag_decisions WHERE character_id=?').get(id).tag_name, tag.name);
    assert.equal(revision(db), before + 1);
    const reopened = openFinalCatalog(path);
    reopened.close(); // No unrecognized schema additions.
  });
  test(`${name}: empty final and zero limit do no work`, async t => {
    const { db } = fixture(t, { empty: true });
    await run(options(db, () => assert.fail('empty catalog performed verification')));
    // Seed maintenance work too: a zero limit must skip character prepasses.
    db.prepare("INSERT INTO character_identities(id,creation_method) VALUES (?,'manual')").run(id);
    db.prepare(`INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full)
      VALUES (?,1,0,1,'generated','Test Person')`).run(id);
    db.prepare('INSERT INTO tag_candidates VALUES (?,?,0,?)').run(id, tag.name, 'Active alias from old');
    const before = snapshot(db);
    await run({ ...options(db, () => assert.fail('zero limit performed verification')), limit: 0 });
    assert.deepEqual(snapshot(db), before);
  });
  test(`${name}: legacy still requires completed publication`, async t => {
    const { db } = fixture(t, { legacy: true });
    await assert.rejects(run(options(db)), /Publish/);
    setMeta(db, 'import_phase', 'complete');
    await run(options(db));
  });
  for (const status of ['no_match', 'approve']) test(`${name}: fresh human ${status} survives async verification`, async t => {
    const { db, path, connections } = fixture(t);
    setMeta(db, 'import_phase', 'complete');
    const human = openFinalCatalog(path);
    connections.push(human);
    const before = revision(db);
    let decided = false;
    await run(options(db, () => {
      if (decided) return;
      decided = true;
      saveDecision(human, id, status, status === 'approve' ? 'human_tag' : null, 'manual', status === 'approve' ? captureRankingTagEvidence('human_tag', { ...tag, name: 'human_tag' }) : null);
    }));
    const decision = db.prepare('SELECT * FROM tag_decisions WHERE character_id=?').get(id);
    assert.equal(decision.source, 'manual');
    assert.equal(decision.status, status);
    assert.equal(decision.tag_name, status === 'approve' ? 'human_tag' : null);
    assert.equal(revision(db), before + 1, 'skipped automation must not bump revision');
    assert.equal(db.prepare('SELECT count(*) n FROM duckduckgo_tag_attempts').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM tag_candidates').get().n, 0);
  });
}

test('character maintenance preserves human decisions made during alias verification', async t => {
  const { db, path, connections } = fixture(t);
  const human = openFinalCatalog(path);
  connections.push(human);
  db.prepare('INSERT INTO tag_candidates VALUES (?,?,0,?)').run(id, tag.name, 'Active alias from old');
  db.prepare('INSERT INTO tag_candidates VALUES (?,?,0,?)').run(id, 'old', 'Character-tag name search');
  db.prepare('INSERT INTO tag_match_progress VALUES (?,?)').run(id, 'synthetic');
  const before = revision(db);
  await refreshAliasCounts(db, { exactTag: async () => {
    assert.equal(db.isTransaction, false);
    saveDecision(human, id, 'no_match');
    return tag;
  } }, quiet);
  removeSavedAliasSources(db, quiet);
  await approveSearchedByCount(db, quiet, options(db).api);
  assert.equal(revision(db), before + 1);
  assert.equal(db.prepare('SELECT status FROM tag_decisions').get().status, 'no_match');
  assert.equal(db.prepare('SELECT count(*) n FROM tag_candidates').get().n, 2);
  assert.equal(db.prepare('SELECT sum(post_count) n FROM tag_candidates').get().n, 0);
});

test('Google and DuckDuckGo honor shared completed attempts without source collision or repeat work', async t => {
  const { db } = fixture(t);
  setMeta(db, 'import_phase', 'complete');
  const opts = options(db);
  opts.api.exactTag = async () => null;
  await matchGoogleTags(opts); // Manual outcome is still a completed shared attempt.
  const before = snapshot(db);
  await matchGoogleTags(options(db, () => assert.fail('repeated Google verification')));
  await matchDuckDuckGoTags(options(db, () => assert.fail('shared attempt was ignored')));
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.prepare('SELECT count(*) n FROM duckduckgo_tag_attempts').get().n, 1);
});
