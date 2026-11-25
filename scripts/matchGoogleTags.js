import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import {
  getMeta,
  openCatalog,
  saveDecision,
  transaction,
} from "../lib/catalogDb.js";
import { hasCharacterRanking } from "../lib/catalogFinalSchema.js";
import { DanbooruApi } from "../lib/danbooruApi.js";
import { inspectDanbooruResult } from "../lib/danbooruSearchResult.js";
import { normalizeTag, searchNames } from "../lib/danbooruTagMatcher.js";
import { formatNumber } from "../lib/formatNumber.js";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function googleQuery(row) {
  const firstAnime = JSON.parse(row.anime_titles || "[]")[0];
  return [row.name_full, firstAnime, "danbooru"].filter(Boolean).join(" ");
}

function destination(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname === "www.google.com" && url.pathname === "/url") {
      const target = url.searchParams.get("url") || url.searchParams.get("q");
      return target ? new URL(target).href : url.href;
    }
    return url.href;
  } catch {
    return raw;
  }
}

async function googleResults(page, query) {
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", query);
  const response = await page.goto(url.href, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  const title = await page.title();
  if (
    /\/sorry\//.test(page.url()) ||
    /unusual traffic|before you continue|not a robot/i.test(title) ||
    (await page.locator('form[action*="/sorry/"]').count())
  )
    throw new Error(
      "Google presented an automated-traffic challenge; no decision was saved",
    );
  if (!response || response.status() >= 400)
    throw new Error(
      `Google search HTTP ${response?.status() ?? "no response"}`,
    );
  await page
    .locator("#search, #rso")
    .first()
    .waitFor({ state: "attached", timeout: 15_000 });
  const links = await page
    .locator("#search a:has(h3), #rso a:has(h3)")
    .evaluateAll((anchors) =>
      anchors
        .filter(
          (anchor) => !anchor.closest("#tads, #bottomads, [data-text-ad]"),
        )
        .map((anchor) => ({
          url: anchor.href,
          title: anchor.querySelector("h3")?.textContent?.trim() || "",
        }))
        .filter((item) => item.url && item.title),
    );
  const seen = new Set();
  const organic = [];
  for (const link of links) {
    const href = destination(link.url);
    if (seen.has(href)) continue;
    seen.add(href);
    organic.push({ ...link, url: href });
    if (organic.length === 2) break;
  }
  if (!organic.length)
    throw new Error(`Google returned no readable organic results for ${query}`);
  return organic;
}

function animeMatches(character, copyrightTags) {
  const titles = character.animeTitles
    .map(normalizeTag)
    .filter((title) => title.length >= 4);
  return copyrightTags
    .map(normalizeTag)
    .filter((tag) => tag.length >= 4)
    .some((tag) =>
      titles.some((title) => title.includes(tag) || tag.includes(title)),
    );
}

function identityReason(character, tag, aliasFrom, copyrightTags) {
  const names = searchNames(character);
  const canonical = normalizeTag(tag.name);
  const alias = normalizeTag(aliasFrom);
  const name = names.find(
    (value) =>
      canonical === value ||
      canonical.startsWith(`${value}_`) ||
      alias === value ||
      alias.startsWith(`${value}_`),
  );
  if (!name) return null;
  if (animeMatches(character, copyrightTags))
    return "Character name and post copyright match";
  const suffix = canonical.startsWith(`${name}_`)
    ? canonical.slice(name.length + 1)
    : "";
  if (
    suffix.length >= 4 &&
    character.animeTitles.some((title) => normalizeTag(title).includes(suffix))
  )
    return "Character name and series suffix match";
  if (name.includes("_") && (canonical === name || alias === name))
    return "Exact multiword character name or alias";
  return null;
}

async function inspectResult(api, character, result) {
  const checked = await inspectDanbooruResult(api, result.url);
  if (!checked.tag) return { reason: checked.reason };
  const identity = identityReason(
    character,
    checked.tag,
    checked.aliasFrom,
    checked.copyrightTags,
  );
  return identity
    ? { tag: checked.tag.name, reason: identity }
    : { reason: "Character or anime identity is ambiguous" };
}

function saveAttempt(db, row, query, results, outcome, evidence = null) {
  return transaction(db, () => {
    if (
      db
        .prepare("SELECT 1 FROM tag_decisions WHERE character_id = ?")
        .get(row.id)
    )
      return false;
    if (
      db
        .prepare("SELECT 1 FROM duckduckgo_tag_attempts WHERE character_id = ?")
        .get(row.id)
    )
      return false;
    // Historical shared search-attempt contract: one completed search per character,
    // regardless of engine. Do not add an engine-specific table to authoritative v12.
    db.prepare(
      `INSERT INTO duckduckgo_tag_attempts
      (character_id, query, first_url, second_url, outcome, tag_name, details, searched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      query,
      results[0]?.url ?? null,
      results[1]?.url ?? null,
      outcome.tag ? "approved" : "manual",
      outcome.tag ?? null,
      outcome.details,
      new Date().toISOString(),
    );
    if (outcome.tag)
      saveDecision(db, row.id, "approve", outcome.tag, "automatic", evidence);
    return true;
  });
}

export async function matchGoogleTags({
  db,
  api,
  page,
  limit = 25,
  delayMs = 10_000,
  dryRun = false,
  log = console.log,
}) {
  if (limit === 0) {
    log(
      "Google search complete: 0 approved, 0 left for manual review, 0 searched.",
    );
    return;
  }
  if (
    db.prepare("PRAGMA user_version").get().user_version !== 12 &&
    getMeta(db, "import_phase") !== "complete"
  )
    throw new Error("Publish the catalog before matching tags");
  const pending = db
    .prepare(
      `SELECT c.* FROM characters c
    LEFT JOIN tag_decisions d ON d.character_id = c.id
    LEFT JOIN duckduckgo_tag_attempts a ON a.character_id = c.id
    WHERE d.character_id IS NULL AND a.character_id IS NULL
    ORDER BY c.rank LIMIT ?`,
    )
    .all(limit);
  let approved = 0;
  let manual = 0;
  for (const [index, row] of pending.entries()) {
    if (index) await sleep(delayMs);
    const character = {
      name: row.name_full,
      alternatives: JSON.parse(row.name_alternatives || "[]"),
      animeTitles: JSON.parse(row.anime_titles || "[]"),
    };
    const query = googleQuery(row);
    log(
      `Character #${formatNumber(row.rank)}: ${row.name_full} - searching Google: ${query}`,
    );
    const results = await googleResults(page, query);
    const reasons = [];
    let match = null;
    for (const [resultIndex, result] of results.entries()) {
      const checked = await inspectResult(api, character, result);
      reasons.push(`#${resultIndex + 1}: ${checked.reason} (${result.url})`);
      if (checked.tag) {
        match = { tag: checked.tag, resultIndex: resultIndex + 1 };
        break;
      }
    }
    const outcome = { tag: match?.tag ?? null, details: reasons.join("; ") };
    const evidence =
      !dryRun && outcome.tag && hasCharacterRanking(db)
        ? await api.verifyRankingTag(outcome.tag, { allowCopyright: false })
        : null;
    if (!dryRun && !saveAttempt(db, row, query, results, outcome, evidence)) {
      log(
        `Character #${formatNumber(row.rank)}: ${row.name_full} - already decided; skipped.`,
      );
      continue;
    }
    if (match) {
      approved++;
      log(
        `Character #${formatNumber(row.rank)}: ${row.name_full} - ${dryRun ? "would auto approve" : "auto approved"} ${match.tag} from Google result #${match.resultIndex} (${results[match.resultIndex - 1].url}).`,
      );
    } else {
      manual++;
      log(
        `Character #${formatNumber(row.rank)}: ${row.name_full} - left for manual approval - ${outcome.details}`,
      );
    }
  }
  log(
    `Google search complete: ${approved} approved, ${manual} left for manual review, ${pending.length} searched.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let db;
  let browser;
  try {
    const { values } = parseArgs({
      options: {
        limit: { type: "string", default: "25" },
        "delay-ms": { type: "string", default: "10000" },
        browser: { type: "string", default: "chrome" },
        "dry-run": { type: "boolean", default: false },
      },
    });
    const limit = Number(values.limit);
    const delayMs = Number(values["delay-ms"]);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 15_000)
      throw new Error("--limit must be an integer between 0 and 15000");
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 600_000)
      throw new Error("--delay-ms must be an integer between 0 and 600000");
    if (!["chrome", "msedge"].includes(values.browser))
      throw new Error("--browser must be chrome or msedge");
    db = openCatalog();
    if (limit === 0) {
      await matchGoogleTags({ db, limit });
    } else {
      browser = await chromium.launch({
        channel: values.browser,
        headless: true,
      });
      const context = await browser.newContext({ locale: "en-US" });
      const page = await context.newPage();
      const api = new DanbooruApi({ db: values["dry-run"] ? null : db });
      await matchGoogleTags({
        db,
        api,
        page,
        limit,
        delayMs,
        dryRun: values["dry-run"],
      });
    }
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    db?.close();
  }
}
