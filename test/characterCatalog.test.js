import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openCatalog, keepCandidate, publishCatalog, reportCharacterTag, saveDecision, getMeta, setMeta } from '../lib/catalogDb.js';
import { chooseTag, chooseTagByCount, normalizeTag, searchNames } from '../lib/danbooruTagMatcher.js';
import { hydrateOneBatch, scanOnePage } from '../scripts/importCharacterCatalog.js';
import { approveSearchedByCount } from '../scripts/matchCharacterTags.js';
import { createReviewServer } from '../web/reviewCharacterTags.js';
import { DanbooruApi } from '../lib/danbooruApi.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'character-catalog-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('keeps highest favourites with stable ID tie break and replays safely', (t) => {
  const db = fixture(t);
  for (const [id, favourites] of [[3, 10], [2, 20], [1, 10], [4, 30]]) {
    keepCandidate(db, { id, favourites }, 3);
  }
  keepCandidate(db, { id: 2, favourites: 20 }, 3);
  assert.deepEqual(db.prepare('SELECT id FROM stage_characters ORDER BY favourites DESC, id ASC').all().map((row) => row.id), [4, 2, 1]);
  keepCandidate(db, { id: 8, favourites: null }, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stage_characters').get().n, 3);
});

test('failed publication leaves prior catalog and manual decisions intact', (t) => {
  const db = fixture(t);
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES (9, 1, 99, 'Old')`).run();
  saveDecision(db, 9, 'approve', 'old_tag');
  keepCandidate(db, { id: 1, favourites: 100 }, 3);
  assert.throws(() => publishCatalog(db, () => { throw Error('interrupted'); }), /interrupted/);
  assert.equal(db.prepare('SELECT name_full FROM characters WHERE id = 9').get().name_full, 'Old');
  assert.equal(db.prepare('SELECT tag_name FROM tag_decisions WHERE character_id = 9').get().tag_name, 'old_tag');
});

test('successful publication assigns ranks and retains manual mappings', (t) => {
  const db = fixture(t);
  saveDecision(db, 7, 'approve', 'seven_(anime)');
  keepCandidate(db, { id: 7, favourites: 4 }, 2);
  keepCandidate(db, { id: 3, favourites: 9 }, 2);
  db.prepare('UPDATE stage_characters SET name_full = ? WHERE id = ?').run('Seven', 7);
  db.prepare('UPDATE stage_characters SET name_full = ? WHERE id = ?').run('Three', 3);
  assert.equal(publishCatalog(db), 2);
  assert.deepEqual(db.prepare('SELECT id FROM characters ORDER BY rank').all().map((row) => row.id), [3, 7]);
  assert.equal(db.prepare('SELECT tag_name FROM tag_decisions WHERE character_id = 7').get().tag_name, 'seven_(anime)');
});

test('unique title-qualified Danbooru tag is accepted, ambiguous name stays pending', () => {
  const character = { name: 'Emilia', alternatives: [], animeTitles: ['Re:ZERO -Starting Life in Another World-'] };
  const qualified = chooseTag(character, [
    { name: 'emilia_(re_zero)', post_count: 1000 },
    { name: 'emilia_(another_series)', post_count: 2000 },
  ]);
  assert.equal(qualified.status, 'automatic');
  assert.equal(qualified.tag, 'emilia_(re_zero)');
  assert.equal(chooseTag({ ...character, animeTitles: [] }, [
    { name: 'emilia_(re_zero)', post_count: 1000 },
    { name: 'emilia_(another_series)', post_count: 2000 },
  ]).tag, 'emilia_(another_series)');
  assert.equal(normalizeTag('Astra Yao'), 'astra_yao');
  assert.deepEqual(searchNames({ name: 'Satoru Gojou', alternatives: [] }), ['satoru_gojou', 'gojou_satoru']);
});

test('post-count approval requires two candidates, a count or ratio lead, and a matching name', () => {
  const character = { name: 'Rem', alternatives: [], animeTitles: [] };
  const matching = { name: 'rem_(re:zero)', post_count: 2_000 };
  assert.equal(chooseTagByCount(character, [matching, { name: 'rem_(other)', post_count: 1_500 }]).tag, matching.name);
  assert.equal(chooseTagByCount(character, [matching, { name: 'rem_(other)', post_count: 1_501 }]), null);
  assert.equal(chooseTagByCount(character, [
    { name: 'rem_(re:zero)', post_count: 100 }, { name: 'rem_(other)', post_count: 20 },
  ]).tag, matching.name);
  assert.equal(chooseTagByCount(character, [
    { name: 'rem_(re:zero)', post_count: 99 }, { name: 'rem_(other)', post_count: 9 },
  ]), null);
  assert.equal(chooseTagByCount(character, [
    { name: 'rem_(re:zero)', post_count: 100 }, { name: 'rem_(other)', post_count: 0 },
  ]), null);
  assert.equal(chooseTagByCount(character, [
    { name: 'rem_(re:zero)', post_count: 100 }, { name: 'rem_(other)', post_count: 21 },
  ]), null);
  assert.equal(chooseTagByCount(character, [matching]), null);
  assert.equal(chooseTagByCount(character, [matching, { name: 'rem_old', post_count: 0, aliasFrom: 'rem_old' }]).tag, matching.name);
  assert.equal(chooseTagByCount(character, [
    { name: 'remielle_dan', post_count: 8_173 }, matching,
  ]), null);
});

test('count approval backfills searched characters and preserves manual decisions', (t) => {
  const db = fixture(t);
  setMeta(db, 'import_phase', 'complete');
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full) VALUES
    (1, 1, 1, 'Rem'), (2, 2, 1, 'Shinobu Oshino'),
    (3, 3, 1, 'Manual'), (4, 4, 1, 'Rin Tohsaka')`).run();
  db.prepare(`INSERT INTO tag_match_progress (character_id, matched_at) VALUES
    (1, 'now'), (2, 'now'), (3, 'now'), (4, 'now')`).run();
  db.prepare(`INSERT INTO tag_candidates (character_id, tag_name, post_count) VALUES
    (1, 'remielle_dan', 8173), (1, 'rem_(re:zero)', 2465),
    (2, 'oshino_shinobu', 6798), (2, 'oshino_shinobu_(other)', 29),
    (3, 'manual', 9000), (3, 'manual_(other)', 10),
    (4, 'tohsaka_rin', 100), (4, 'tohsaka_rin_(other)', 10)`).run();
  saveDecision(db, 3, 'approve', 'manual', 'manual');
  assert.equal(approveSearchedByCount(db, () => {}), 2);
  assert.equal(approveSearchedByCount(db, () => {}), 0);
  assert.equal(db.prepare('SELECT tag_name FROM tag_decisions WHERE character_id = 1').get(), undefined);
  assert.deepEqual({ ...db.prepare('SELECT tag_name, source FROM tag_decisions WHERE character_id = 2').get() },
    { tag_name: 'oshino_shinobu', source: 'automatic' });
  assert.equal(db.prepare('SELECT source FROM tag_decisions WHERE character_id = 3').get().source, 'manual');
  assert.equal(db.prepare('SELECT tag_name FROM tag_decisions WHERE character_id = 4').get().tag_name, 'tohsaka_rin');
});

test('checkpoint advances only after a complete anime page and replay is idempotent', async (t) => {
  const db = fixture(t);
  setMeta(db, 'scan_range_start', 1);
  setMeta(db, 'scan_page', 1);
  setMeta(db, 'scan_max_id', 1);
  const api = {
    animePage: async () => ({ pageInfo: { hasNextPage: false }, media: [
      { id: 1, characters: { pageInfo: { hasNextPage: true }, nodes: [{ id: 4, favourites: 42 }] } },
    ] }),
    extraCharacters: async () => ({ pageInfo: { hasNextPage: false }, nodes: [{ id: 5, favourites: 43 }] }),
  };
  await scanOnePage(db, api);
  assert.equal(getMeta(db, 'scan_range_start'), '501');
  assert.deepEqual(db.prepare('SELECT id FROM stage_characters ORDER BY id').all().map((row) => row.id), [4, 5]);
  setMeta(db, 'scan_range_start', 1);
  await scanOnePage(db, api);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stage_characters').get().n, 2);
});

test('hydration removes characters that disappeared from AniList and continues', async (t) => {
  const db = fixture(t);
  keepCandidate(db, { id: 1, favourites: 10 });
  keepCandidate(db, { id: 2, favourites: 20 });
  const logs = [];
  const api = {
    characterDetails: async () => [{
      id: 2, name: { full: 'Present', alternative: [] }, dateOfBirth: {},
      media: { pageInfo: { hasNextPage: false }, nodes: [{
        id: 20, title: { romaji: 'Eligible' }, format: 'TV', status: 'FINISHED',
        averageScore: 70, popularity: 20_000,
      }] },
    }],
  };

  assert.equal(await hydrateOneBatch(db, api, (message) => logs.push(message)), true);
  assert.deepEqual(db.prepare('SELECT id, name_full FROM stage_characters ORDER BY id').all().map((row) => ({ ...row })), [
    { id: 2, name_full: 'Present' },
  ]);
  assert.match(logs.join('\n'), /removed missing AniList character IDs: 1/i);
});

test('localhost review exposes candidates and saves a validated manual choice', async (t) => {
  const db = fixture(t);
  setMeta(db, 'import_phase', 'complete');
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, anime_titles)
    VALUES (1, 1, 20, 'Example', '["Example Anime"]')`).run();
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, anime_titles)
    VALUES (2, 2, 10, 'Reviewed', '[]'), (3, 3, 5, 'Last', '[]')`).run();
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, anime_titles)
    VALUES (20, 4, 4, 'Automatic', '[]')`).run();
  saveDecision(db, 2, 'no_match');
  saveDecision(db, 20, 'approve', 'automatic', 'automatic');
  db.prepare(`INSERT INTO tag_candidates (character_id, tag_name, post_count) VALUES (1, 'example_(anime)', 10)`).run();
  const previewQueries = [];
  const server = createReviewServer({ db, port: 0,
    api: { exactTag: async (name) => name === 'Example (Anime)' ? { name: 'example_(anime)' } : null },
    fetchImpl: async (url) => {
      previewQueries.push({ tags: url.searchParams.get('tags'), limit: url.searchParams.get('limit') });
      return { ok: true, json: async () => [
        { rating: 'g', tag_string_general: 'other', preview_file_url: 'https://safebooru.donmai.us/group.jpg' },
        { rating: 'g', tag_string_general: 'solo', preview_file_url: 'https://safebooru.donmai.us/solo.jpg' },
      ] };
    },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const row = await (await fetch(`${base}/api/next`)).json();
    assert.equal(row.name, 'Example');
    assert.equal(row.candidates[0].name, 'example_(anime)');
    assert.equal((await (await fetch(`${base}/api/next?after=1`)).json()).rank, 3);
    assert.equal((await (await fetch(`${base}/api/next?before=3`)).json()).rank, 1);
    assert.equal((await (await fetch(`${base}/api/next?last=1`)).json()).rank, 3);
    assert.equal(await (await fetch(`${base}/api/next?before=1`)).json(), null);
    assert.equal(await (await fetch(`${base}/api/next?after=3`)).json(), null);
    assert.equal((await (await fetch(`${base}/api/status`)).json()).queue, 2);
    const preview = await (await fetch(`${base}/api/preview?tag=example_(anime)`)).json();
    const soloPreview = await (await fetch(`${base}/api/preview?tag=example_(anime)&solo=1`)).json();
    assert.deepEqual(preview, ['https://safebooru.donmai.us/group.jpg', 'https://safebooru.donmai.us/solo.jpg']);
    assert.deepEqual(soloPreview, ['https://safebooru.donmai.us/solo.jpg']);
    assert.deepEqual(previewQueries, [
      { tags: 'example_(anime) order:score', limit: '3' },
      { tags: 'example_(anime) order:score', limit: '200' },
    ]);
    const response = await fetch(`${base}/api/decision`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ characterId: 1, status: 'approve', tag: 'Example (Anime)' }) });
    assert.equal(response.status, 200);
    assert.equal(db.prepare('SELECT source FROM tag_decisions WHERE character_id = 1').get().source, 'manual');
    assert.equal(db.prepare('SELECT tag_name FROM tag_decisions WHERE character_id = 1').get().tag_name, 'example_(anime)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reported tags deduplicate viewers, resolve through review, and retain history', async (t) => {
  const db = fixture(t);
  setMeta(db, 'import_phase', 'complete');
  db.prepare(`INSERT INTO characters (id, rank, favourites, name_full, anime_titles)
    VALUES (1, 1, 10, 'Wrong Tag', '[]'), (2, 2, 5, 'Missing Tag', '[]')`).run();
  saveDecision(db, 1, 'approve', 'old_tag', 'automatic');
  assert.equal(reportCharacterTag(db, 1, 'viewer-a'), true);
  assert.equal(reportCharacterTag(db, 1, 'viewer-a'), false);
  assert.equal(reportCharacterTag(db, 1, 'viewer-b'), true);
  assert.equal(reportCharacterTag(db, 2, 'viewer-a'), true);
  const server = createReviewServer({ db, port: 0,
    api: { exactTag: async (tag) => tag === 'correct_tag' ? { name: tag } : null },
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/reports/resolve`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await (await fetch(`${base}/api/status`)).json()).reports, 2);
    const first = await (await fetch(`${base}/api/reports/next`)).json();
    assert.equal(first.name, 'Wrong Tag');
    assert.equal(first.decision.tag_name, 'old_tag');
    assert.equal(first.reportCount, 2);
    assert.equal((await post({ characterId: 1, outcome: 'corrected', tag: 'invalid' })).status, 400);
    assert.equal((await post({ characterId: 1, outcome: 'corrected', tag: 'correct_tag' })).status, 200);
    assert.deepEqual({ ...db.prepare('SELECT tag_name, source FROM tag_decisions WHERE character_id = 1').get() },
      { tag_name: 'correct_tag', source: 'manual' });
    assert.equal((await (await fetch(`${base}/api/reports/next`)).json()).name, 'Missing Tag');
    assert.equal((await post({ characterId: 2, outcome: 'dismissed' })).status, 200);
    assert.equal(await (await fetch(`${base}/api/reports/next`)).json(), null);
    const history = await (await fetch(`${base}/api/reports/history`)).json();
    assert.deepEqual(history.map((row) => row.outcome), ['dismissed', 'corrected']);
    assert.equal(history[1].reportCount, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM character_tag_reports WHERE reporter_id = ?').get('viewer-a').n, 2);
    assert.equal(reportCharacterTag(db, 1, 'viewer-a'), true);
    keepCandidate(db, { id: 2, favourites: 5 });
    db.prepare(`UPDATE stage_characters SET name_full = 'Missing Tag' WHERE id = 2`).run();
    publishCatalog(db);
    assert.equal(db.prepare(`SELECT outcome FROM character_tag_reports WHERE character_id = 1 ORDER BY id DESC LIMIT 1`).get().outcome, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Danbooru character-tag searches are cached and identify the client', async (t) => {
  const db = fixture(t);
  let calls = 0;
  const api = new DanbooruApi({ db, gapMs: 0, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('search[category]'), '4');
    assert.match(options.headers['user-agent'], /random-fun-bot-character-catalog/);
    return { ok: true, json: async () => [{ name: 'gojou_satoru_(jujutsu_kaisen)', category: 4, post_count: 30 }] };
  } });
  const first = await api.searchTags('Gojou Satoru');
  const second = await api.searchTags('Gojou Satoru');
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
});

test('manual tag validation keeps Danbooru parentheses', async (t) => {
  const db = fixture(t);
  const api = new DanbooruApi({ db, gapMs: 0, fetchImpl: async (url) => {
    assert.equal(new URL(url).searchParams.get('search[name]'), 'emilia_(re_zero)');
    return { ok: true, json: async () => [
      { name: 'emilia_(re_zero)', category: 4, is_deprecated: false },
    ] };
  } });
  assert.equal((await api.exactTag('emilia_(re_zero)')).name, 'emilia_(re_zero)');
});
