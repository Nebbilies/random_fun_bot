import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DanbooruApi } from '../lib/danbooruApi.js';
import { inspectDanbooruResult } from '../lib/danbooruSearchResult.js';
import { getMeta, openCatalog, openCatalogReadOnly, saveDecision, transaction } from '../lib/catalogDb.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function queryFor(row) {
  return [row.name_full, 'danbooru'].join(' ');
}

function fallbackQueryFor(row) {
  const firstAnime = JSON.parse(row.anime_titles || '[]')[0];
  return [row.name_full, firstAnime, 'danbooru'].filter(Boolean).join(' ');
}

function resultUrl(raw) {
  const url = new URL(raw.replace(/&(?:amp|#38|#x26);/gi, '&'), 'https://duckduckgo.com');
  if (['duckduckgo.com', 'www.duckduckgo.com'].includes(url.hostname) && url.pathname === '/l/') {
    const destination = url.searchParams.get('uddg');
    if (!destination) throw new Error('DuckDuckGo result has no destination');
    return new URL(destination).href;
  }
  return url.href;
}

export function parseDuckDuckGoResults(html) {
  const results = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1];
    const className = attributes.match(/\bclass\s*=\s*(['"])(.*?)\1/i)?.[2] || '';
    if (!className.split(/\s+/).includes('result-link')) continue;
    const href = attributes.match(/\bhref\s*=\s*(['"])(.*?)\1/i)?.[2];
    if (!href) continue;
    const clickUrl = new URL(href.replace(/&(?:amp|#38|#x26);/gi, '&'), 'https://duckduckgo.com');
    if (!['duckduckgo.com', 'www.duckduckgo.com'].includes(clickUrl.hostname)
      || clickUrl.pathname !== '/l/') continue;
    const url = resultUrl(href);
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({ url, title: match[2].replace(/<[^>]*>/g, '').trim() });
    if (results.length === 2) break;
  }
  return results;
}

export async function duckDuckGoResults(fetchImpl, query) {
  const url = new URL('https://lite.duckduckgo.com/lite/');
  url.searchParams.set('q', query);
  const response = await fetchImpl(url, {
    headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) throw new Error(`DuckDuckGo Lite HTTP ${response.status}; no decision saved`);
  const html = await response.text();
  if (/captcha|unusual traffic|verify you are human|automated requests/i.test(html))
    throw new Error('DuckDuckGo presented a search challenge; no decision saved');
  const results = parseDuckDuckGoResults(html);
  if (!results.length) throw new Error('DuckDuckGo returned no readable organic results; no decision saved');
  return results;
}

function spaced(items, count) {
  return Array.from({ length: Math.min(count, items.length) }, (_, index) =>
    items[Math.floor((index + 0.5) * items.length / Math.min(count, items.length))]);
}

function pendingRows(db, limit, apply) {
  const attemptsJoin = apply
    ? 'LEFT JOIN duckduckgo_tag_attempts a ON a.character_id = c.id' : '';
  const attemptsFilter = apply ? 'AND a.character_id IS NULL' : '';
  const rows = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM tag_candidates tc WHERE tc.character_id = c.id) AS candidate_count
    FROM characters c
    LEFT JOIN tag_decisions d ON d.character_id = c.id
    ${attemptsJoin}
    WHERE d.character_id IS NULL ${attemptsFilter}
    ORDER BY c.rank`).all();
  if (apply) return rows.slice(0, limit);
  const buckets = [[], [], []];
  for (const row of rows) buckets[Math.min(row.candidate_count, 2)].push(row);
  const selected = [];
  for (const [index, bucket] of buckets.entries()) {
    const quota = Math.ceil((limit - selected.length) / (buckets.length - index));
    selected.push(...spaced(bucket, quota));
  }
  if (selected.length < limit) {
    const ids = new Set(selected.map((row) => row.id));
    selected.push(...spaced(rows.filter((row) => !ids.has(row.id)), limit - selected.length));
  }
  return selected.sort((a, b) => a.rank - b.rank);
}

function saveAttempt(db, row, searches, outcome, suggestions) {
  const [{ query, results }] = searches;
  return transaction(db, () => {
    if (db.prepare('SELECT 1 FROM tag_decisions WHERE character_id = ?').get(row.id)
      || db.prepare('SELECT 1 FROM duckduckgo_tag_attempts WHERE character_id = ?').get(row.id)) return false;
    db.prepare(`INSERT INTO duckduckgo_tag_attempts
      (character_id, query, first_url, second_url, outcome, tag_name, details, searched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, query, results[0]?.url ?? null,
        results[1]?.url ?? null, outcome.tag ? 'approved' : 'manual',
        outcome.tag ?? null, outcome.details, new Date().toISOString());
    if (outcome.tag) saveDecision(db, row.id, 'approve', outcome.tag, 'automatic');
    else {
      const insert = db.prepare(`INSERT OR IGNORE INTO tag_candidates
        (character_id, tag_name, post_count, reason) VALUES (?, ?, ?, ?)`);
      for (const { tag, resultIndex, searchIndex } of suggestions)
        insert.run(row.id, tag.name, tag.post_count ?? 0,
          `DuckDuckGo ${searchIndex ? 'anime fallback' : 'name'} result #${resultIndex}`);
    }
    return true;
  });
}

export async function matchDuckDuckGoTags({ db, api, fetchImpl = fetch, limit = 50,
  delayMs = 30_000, apply = false, log = console.log }) {
  if (getMeta(db, 'import_phase') !== 'complete') throw new Error('Publish the catalog before matching tags');
  const pending = pendingRows(db, limit, apply);
  const summary = { searched: 0, approved: 0, manual: 0 };
  for (const [index, row] of pending.entries()) {
    if (index) await sleep(delayMs);
    const queries = [...new Set([queryFor(row), fallbackQueryFor(row)])];
    const searches = [];
    const reasons = [];
    const suggestions = [];
    let match = null;
    for (const [searchIndex, query] of queries.entries()) {
      if (searchIndex) await sleep(delayMs);
      log(`Character #${row.rank}: ${row.name_full} - searching DuckDuckGo: ${query}`);
      let results;
      try { results = await duckDuckGoResults(fetchImpl, query); }
      catch (error) {
        log(`Stopped at character #${row.rank}: ${error.message}`);
        throw error;
      }
      searches.push({ query, results });
      for (const [resultIndex, result] of results.entries())
        log(`  Result #${resultIndex + 1}: ${result.title} (${result.url})`);
      for (const [resultIndex, result] of results.entries()) {
        const checked = await inspectDanbooruResult(api, result.url);
        reasons.push(`${query} result #${resultIndex + 1}: ${checked.reason} (${result.url})`);
        for (const tag of checked.candidates)
          suggestions.push({ tag, resultIndex: resultIndex + 1, searchIndex });
        if (checked.tag) {
          match = { tag: checked.tag.name, searchIndex, resultIndex: resultIndex + 1, url: result.url };
          break;
        }
      }
      if (match) break;
    }
    const outcome = { tag: match?.tag ?? null, details: reasons.join('; ') };
    if (apply && !saveAttempt(db, row, searches, outcome, suggestions)) {
      log(`Character #${row.rank}: ${row.name_full} - already decided; skipped.`);
      continue;
    }
    summary.searched++;
    if (match) {
      summary.approved++;
      log(`Character #${row.rank}: ${row.name_full} - ${apply ? 'auto approved' : 'would auto approve'} ${match.tag} from ${match.searchIndex ? 'anime fallback' : 'name'} result #${match.resultIndex} (${match.url}).`);
    } else {
      summary.manual++;
      log(`Character #${row.rank}: ${row.name_full} - left for manual review - ${outcome.details}`);
    }
  }
  log(`DuckDuckGo ${apply ? 'apply' : 'read-only sample'} complete: ${summary.approved} approvals, ${summary.manual} manual, ${summary.searched} searched.`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let db;
  try {
    const { values } = parseArgs({ options: {
      limit: { type: 'string', default: '50' },
      'delay-ms': { type: 'string', default: '30000' },
      apply: { type: 'boolean', default: false },
    } });
    const limit = Number(values.limit);
    const delayMs = Number(values['delay-ms']);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 15_000)
      throw new Error('--limit must be an integer between 1 and 15000');
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 600_000)
      throw new Error('--delay-ms must be an integer between 0 and 600000');
    db = values.apply ? openCatalog() : openCatalogReadOnly();
    const api = new DanbooruApi({ db: values.apply ? db : null });
    await matchDuckDuckGoTags({ db, api, limit, delayMs, apply: values.apply });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
