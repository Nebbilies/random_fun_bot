import test from "node:test";
import assert from "node:assert/strict";
import { parseRankingInputs } from "../lib/catalogRankingInputs.js";
const id = "00000000-0000-4000-8000-000000000001";
const dan = `character_id,full_name,tag,danbooru_post_count\r\n${id},"Name, with commas",example,0\r\n`;
const mudae = `character_id,full_name,mudae_name,mudae_rank,mudae_character_url,mudae_gallery_image_urls\n${id},"Name\nline",Alias,NULL,https://mudae.net/character/1/example,"[""ignored, url""]"\n`;
test("paired CSV input handles BOM, quoting, line breaks and ignores gallery content", () => {
  const result = parseRankingInputs(
    Buffer.from("\ufeff" + dan),
    Buffer.from(mudae),
  );
  assert.deepEqual(result.records, [
    {
      id,
      tag: "example",
      danbooru_post_count: 0,
      mudae_claim_rank: null,
      mudae_character_url: "https://mudae.net/character/1/example",
    },
  ]);
  assert.equal(result.hashes.danbooru.length, 64);
  assert.ok(!JSON.stringify(result).includes("ignored, url"));
});
test("paired CSV input rejects missing rows, duplicate IDs, invalid counts and bad quoting", () => {
  for (const bad of [
    dan + dan.split("\r\n")[1],
    dan.replace(",0\r", ",\r"),
    dan.replace(",0\r", ",-1\r"),
    dan.replace("example,0", "NULL,0"),
    dan.replace("example,0", '"unterminated,0'),
  ]) {
    assert.throws(() =>
      parseRankingInputs(Buffer.from(bad), Buffer.from(mudae)),
    );
  }
  assert.throws(
    () =>
      parseRankingInputs(
        Buffer.from(dan),
        Buffer.from(mudae.replace(id, id.replace(/1$/, "2"))),
      ),
    /UUID sets/,
  );
  const blank = parseRankingInputs(
    Buffer.from(dan.replace("example,0", ",")),
    Buffer.from(mudae),
  );
  assert.equal(blank.records[0].tag, null);
  assert.equal(blank.records[0].danbooru_post_count, null);
});
