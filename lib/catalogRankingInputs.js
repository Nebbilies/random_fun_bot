import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isCharacterId } from "./characterIdentity.js";
import {
  nullableRankingInteger,
  validateMudaeCharacterUrl,
} from "./catalogRanking.js";

const DANBOORU_HEADERS = [
  "character_id",
  "full_name",
  "tag",
  "danbooru_post_count",
];
const MUDAE_HEADERS = [
  "character_id",
  "full_name",
  "mudae_name",
  "mudae_rank",
  "mudae_character_url",
  "mudae_gallery_image_urls",
];
const missing = (value) => value.trim() === "" || value.trim() === "NULL";

/** Strict quoted CSV decoder. The ignored gallery field is consumed without retaining its content. */
function csv(bytes, headers) {
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^\ufeff/, "");
  const records = [];
  let record = [],
    cell = "",
    quoted = false,
    closed = false,
    started = false,
    header = true;
  const retain = () =>
    header || headers[record.length] !== "mudae_gallery_image_urls";
  const field = () => {
    record.push(cell);
    cell = "";
    closed = false;
    started = false;
  };
  const row = () => {
    field();
    if (record.length !== headers.length)
      throw new Error("Invalid CSV column count");
    if (header) {
      if (record.some((name, i) => name !== headers[i]))
        throw new Error("Invalid CSV headers");
      header = false;
    } else
      records.push(
        Object.fromEntries(
          headers
            .filter((h) => h !== "mudae_gallery_image_urls")
            .map((h) => [h, record[headers.indexOf(h)]]),
        ),
      );
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          if (retain()) cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (retain()) cell += ch;
    } else if (ch === ",") field();
    else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row();
    } else if (ch === '"' && !started && !closed) {
      quoted = true;
      started = true;
    } else {
      if (closed || ch === '"') throw new Error("Malformed CSV quoting");
      started = true;
      if (retain()) cell += ch;
    }
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (started || closed || record.length) row();
  if (header) throw new Error("Missing CSV headers");
  return records;
}

function integer(value, label, min = 0) {
  if (missing(value)) return null;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid ${label}`);
  return nullableRankingInteger(Number(value), label, min);
}
function indexed(records) {
  const out = new Map();
  for (const row of records) {
    const id = row.character_id;
    if (!isCharacterId(id) || id !== id.toLowerCase())
      throw new Error("Invalid CSV UUID");
    if (out.has(id)) throw new Error("Duplicate CSV UUID");
    out.set(id, row);
  }
  return out;
}

export function parseRankingInputs(danbooruBytes, mudaeBytes) {
  const danbooru = indexed(csv(danbooruBytes, DANBOORU_HEADERS));
  const mudae = indexed(csv(mudaeBytes, MUDAE_HEADERS));
  if (
    danbooru.size !== mudae.size ||
    [...danbooru.keys()].some((id) => !mudae.has(id))
  )
    throw new Error("CSV UUID sets differ");
  const nameMismatches = [];
  const records = [...danbooru].map(([id, row]) => {
    const other = mudae.get(id);
    if (row.full_name !== other.full_name) nameMismatches.push(id);
    const tag = missing(row.tag) ? null : row.tag;
    if (tag !== null && !/^(?!.*[*,A-Z])[\x21-\x7E]{2,120}$/.test(tag))
      throw new Error("Invalid CSV tag");
    const count = integer(row.danbooru_post_count, "Danbooru count");
    if ((tag === null) !== (count === null))
      throw new Error("CSV tag/count presence mismatch");
    return {
      id,
      tag,
      danbooru_post_count: count,
      mudae_claim_rank: integer(other.mudae_rank, "Mudae claim rank", 1),
      mudae_character_url: validateMudaeCharacterUrl(
        missing(other.mudae_character_url) ? null : other.mudae_character_url,
      ),
    };
  });
  return {
    records,
    nameMismatches,
    hashes: {
      danbooru: createHash("sha256").update(danbooruBytes).digest("hex"),
      mudae: createHash("sha256").update(mudaeBytes).digest("hex"),
    },
  };
}

export function readRankingInputs(danbooruPath, mudaePath) {
  return parseRankingInputs(
    readFileSync(danbooruPath),
    readFileSync(mudaePath),
  );
}
