import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DanbooruApi } from '../lib/danbooruApi.js';
import { chooseTag, chooseTagByCount } from '../lib/danbooruTagMatcher.js';
import { getMeta, openCatalog, saveDecision, transaction } from '../lib/catalogDb.js';
import { formatNumber } from '../lib/formatNumber.js';
import { hasCharacterRanking } from '../lib/catalogFinalSchema.js';

export function removeSavedAliasSources(db, log = console.log) {
  const removed = db.prepare(`DELETE FROM tag_candidates
    WHERE post_count = 0
      AND NOT EXISTS (SELECT 1 FROM tag_decisions d
        WHERE d.character_id = tag_candidates.character_id AND d.source != 'automatic')
      AND EXISTS (
      SELECT 1 FROM tag_candidates canonical
      WHERE canonical.character_id = tag_candidates.character_id
        AND canonical.reason = 'Active alias from ' || tag_candidates.tag_name
    )`).run().changes;
  if (removed) log(`Removed ${removed} zero-post alias names from saved candidates.`);
  return removed;
}

export function approveSearchedByCount(db, log = console.log, api = null) {
  if (hasCharacterRanking(db)) return approveRankedSavedCandidates(db, api, log);
  const pending = db.prepare(`SELECT c.* FROM characters c
    JOIN tag_match_progress p ON p.character_id = c.id
    LEFT JOIN tag_decisions d ON d.character_id = c.id
    WHERE d.character_id IS NULL ORDER BY c.rank`).all();
  const candidates = db.prepare('SELECT tag_name AS name, post_count, reason FROM tag_candidates WHERE character_id = ?');
  let approved = 0;
  for (const row of pending) {
    const character = {
      name: row.name_full,
      alternatives: JSON.parse(row.name_alternatives || '[]'),
      animeTitles: JSON.parse(row.anime_titles || '[]'),
    };
    const tags = candidates.all(row.id).map((tag) => ({
      ...tag, aliasFrom: tag.reason.startsWith('Active alias from ')
        ? tag.reason.slice('Active alias from '.length) : null,
    }));
    const verdict = chooseTagByCount(character, tags);
    if (!verdict) continue;
    const saved = transaction(db, () => {
      if (db.prepare('SELECT 1 FROM tag_decisions WHERE character_id = ?').get(row.id)) return false;
      saveDecision(db, row.id, 'approve', verdict.tag, 'automatic');
      return true;
    });
    if (!saved) continue;
    log(`Character #${formatNumber(row.rank)}: ${row.name_full} - auto approved ${verdict.tag} (saved match).`);
    approved++;
  }
  if (approved) log(`Approved ${approved} previously searched characters by post counts.`);
  return approved;
}

async function approveRankedSavedCandidates(db, api, log) {
  if (!api) throw new Error('Fresh Danbooru verifier required for ranked approvals');
  const pending = db.prepare(`SELECT c.* FROM characters c JOIN tag_match_progress p ON p.character_id=c.id
    LEFT JOIN tag_decisions d ON d.character_id=c.id WHERE d.character_id IS NULL ORDER BY c.rank`).all();
  let count = 0;
  for (const row of pending) {
    const tags = db.prepare('SELECT tag_name AS name,post_count FROM tag_candidates WHERE character_id=?').all(row.id);
    const verdict = chooseTagByCount({ name: row.name_full, alternatives: JSON.parse(row.name_alternatives || '[]'), animeTitles: JSON.parse(row.anime_titles || '[]') }, tags);
    if (!verdict) continue;
    const evidence = await api.verifyRankingTag(verdict.tag, { allowCopyright: false });
    transaction(db, () => {
      if (db.prepare('SELECT 1 FROM tag_decisions WHERE character_id=?').get(row.id)) return;
      saveDecision(db, row.id, 'approve', verdict.tag, 'automatic', evidence); count++;
    });
  }
  if (count) log(`Approved ${count} saved candidates with fresh ranking evidence.`);
  return count;
}

export async function refreshAliasCounts(db, api, log = console.log) {
  const aliases = db.prepare(`SELECT DISTINCT tag_name FROM tag_candidates
    WHERE reason LIKE 'Active alias from %' AND post_count = 0`).all();
  const update = db.prepare(`UPDATE tag_candidates SET post_count = ?
    WHERE tag_name = ? AND reason LIKE 'Active alias from %' AND post_count = 0
      AND NOT EXISTS (SELECT 1 FROM tag_decisions d
        WHERE d.character_id = tag_candidates.character_id AND d.source != 'automatic')`);
  let refreshed = 0;
  for (const { tag_name } of aliases) {
    const tag = await api.exactTag(tag_name);
    if (!tag || !Number.isInteger(tag.post_count)) continue;
    const changes = tag.post_count > 0 ? update.run(tag.post_count, tag_name).changes : 0;
    refreshed += changes;
  }
  if (refreshed) log(`Refreshed post counts for ${refreshed} saved alias candidates.`);
  return refreshed;
}

export async function matchTags({ db, api, limit = Infinity, log = console.log }) {
  if (limit === 0) { log('Processed 0 characters.'); return; }
  if (db.prepare('PRAGMA user_version').get().user_version !== 12
    && getMeta(db, 'import_phase') !== 'complete') throw new Error('Publish the AniList catalog before matching tags');
  await refreshAliasCounts(db, api, log);
  removeSavedAliasSources(db, log);
  await approveSearchedByCount(db, log, api);
  let processed = 0;
  while (processed < limit) {
    const row = db.prepare(`SELECT c.* FROM characters c
      LEFT JOIN tag_match_progress p ON p.character_id = c.id
      LEFT JOIN tag_decisions d ON d.character_id = c.id
      WHERE p.character_id IS NULL AND (d.character_id IS NULL OR d.source = 'automatic')
      ORDER BY c.rank LIMIT 1`).get();
    if (!row) break;
    const character = {
      name: row.name_full,
      alternatives: JSON.parse(row.name_alternatives || '[]'),
      animeTitles: JSON.parse(row.anime_titles || '[]'),
    };
    const tags = await api.candidates(character);
    const verdict = chooseTag(character, tags);
    const evidence = hasCharacterRanking(db) && verdict.status === 'automatic'
      ? await api.verifyRankingTag(verdict.tag, { allowCopyright: false }) : null;
    const saved = transaction(db, () => {
      const decision = db.prepare('SELECT source FROM tag_decisions WHERE character_id = ?').get(row.id);
      if (decision && decision.source !== 'automatic') return false;
      if (db.prepare('SELECT 1 FROM tag_match_progress WHERE character_id = ?').get(row.id)) return false;
      const insert = db.prepare(`INSERT OR REPLACE INTO tag_candidates
        (character_id, tag_name, post_count, reason) VALUES (?, ?, ?, ?)`);
      for (const tag of tags) insert.run(row.id, tag.name, tag.post_count,
        tag.aliasFrom ? `Active alias from ${tag.aliasFrom}` : 'Character-tag name search');
      if (verdict.status === 'automatic') saveDecision(db, row.id, 'approve', verdict.tag, 'automatic', evidence);
      db.prepare('INSERT INTO tag_match_progress (character_id, matched_at) VALUES (?, ?)')
        .run(row.id, new Date().toISOString());
      return true;
    });
    processed++;
    if (!saved) {
      log(`Character #${formatNumber(row.rank)}: ${row.name_full} - already decided or matched; skipped.`);
      continue;
    }
    if (verdict.status === 'automatic') {
      log(`Character #${formatNumber(row.rank)}: ${row.name_full} - auto approved ${verdict.tag}.`);
    } else {
      const candidates = tags.slice(0, 3).map((tag) => `${tag.name} (${tag.post_count})`).join(', ') || 'none';
      const more = tags.length > 3 ? `, +${tags.length - 3} more` : '';
      log(`Character #${formatNumber(row.rank)}: ${row.name_full} - left for manual approval - tags: ${candidates}${more}.`);
    }
    if (processed % 100 === 0) log(`Matched ${processed} characters this run; latest rank ${formatNumber(row.rank)}.`);
  }
  log(`Processed ${processed} characters. Remaining: ${db.prepare(`SELECT COUNT(*) AS n FROM characters c
    LEFT JOIN tag_match_progress p ON p.character_id = c.id
    LEFT JOIN tag_decisions d ON d.character_id = c.id
    WHERE p.character_id IS NULL AND (d.character_id IS NULL OR d.source = 'automatic')`).get().n}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const db = openCatalog();
  try {
    const arg = process.argv.find((item) => item.startsWith('--limit='));
    const limit = arg ? Number(arg.slice('--limit='.length)) : Infinity;
    if (!(limit >= 0)) throw new Error('--limit must be a non-negative number');
    await matchTags({ db, api: new DanbooruApi({ db }), limit });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
