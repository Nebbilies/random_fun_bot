# DuckDuckGo tag matching: brainstorm and design proposal

## Goal and current evidence

Reduce the number of AniList characters that need manual Danbooru tag approval. Search rank alone is not proof of identity; the chosen rule accepts the first search result that resolves to one verified character tag, then audits the resulting approvals.

The current catalog has 15,000 characters and 4,324 without decisions. Of those, 1,789 have no saved Danbooru candidate, 437 have one, and 2,098 have multiple. The existing Google matcher was stopped by an automated-traffic challenge before saving any attempts.

A read-only DuckDuckGo Lite pilot used the existing query format, `character name + first anime title + danbooru`, on five undecided characters. All five initial searches returned HTTP 200. The first two results identified the correct character tag for X, Alisa Ilichina Amiella, and Richeh. They did not do so for Broly or Hakkekkyuu U-1146. None of the three correct tags passed the old automatic identity rules. All three would pass the newly chosen single-character-tag rule. A second, Danbooru-only query returned HTTP 202 without results on its last three searches. Five examples are too few to establish bulk reliability or a safe approval rate.

## Constraints and failure cases

- Never overwrite a manual decision or reprocess an approved character.
- Accept only active Danbooru character tags after checking Danbooru's API. A search title or post count cannot substitute for the tag check.
- A result may be a series page, a post with several character tags, an alias, an unrelated namesake, or a stale link.
- A single verified character tag may still belong to an unrelated namesake. The chosen rule trusts the result ranking for identity, so the sample must be manually audited before bulk use.
- A search page may return a challenge, HTTP 202/429, no organic results, or changed markup. These are operational failures, not evidence that a character has no matching tag.
- Keep requests slow and resumable. Do not try to bypass a challenge.
- The current Google matcher and its empty attempt table are uncommitted local work; preserve them unless their replacement is explicitly part of the approved implementation plan.

## Options

1. **Approve the first Danbooru search hit without checking its tag.** A series page could be mistaken for a character. Reject.
2. **Verify that the hit resolves to exactly one active character tag, then approve it.** Higher yield, including the three correct pilot results. This is the user's chosen rule; it still needs an audited sample because category does not prove identity.
3. **Require matching character and series names too.** Lower false-match risk, but the current rules approved zero of five correct pilot results. Do not use for this search pass.

## Recommended design

Start with `character name + danbooru`. If neither of its first two organic results resolves to one active character tag, try `character name + first anime title + danbooru` and inspect its first two organic results. Wait between the two searches to limit request rate. Unwrap redirect URLs and inspect only links to supported Danbooru hosts. Reuse the current Danbooru post, tag, and alias lookups rather than duplicating them. Use Node's built-in `fetch`; no browser or new package is needed for this search source.

Approve the first result that resolves to exactly one active Danbooru character tag. A series-only tag is skipped. An active alias resolves to its canonical character tag. A post qualifies only when it contains exactly one character tag. No separate AniList name or anime-title match is required, even when the spelling or translated title differs. Unsupported or ambiguous results remain for manual review; save any verified candidate as a suggestion.

Record the primary query and its first two URLs, plus reasons and URLs from any fallback search, the verified candidate, and the decision reason so runs can resume and reviewers can audit them. A blocked or malformed search must stop the run without recording a character attempt. Existing manual decisions always win. Keep unresolved characters in the review queue and preserve their existing candidates.

## Example result flow

For each of the first two DuckDuckGo results, unwrap its destination, inspect its Danbooru URL type, and ask the Danbooru API for authoritative tags. If a result is a series page, stale, or ambiguous, try the next result. Never treat a search result title as a verified tag.

| Result type | Example | Verification and outcome |
| --- | --- | --- |
| Tag search page | `https://danbooru.donmai.us/posts?tags=x_%28to_be_hero_x%29` for AniList's X | Read the `tags` parameter, then check that `x_(to_be_hero_x)` exists as one active character tag. Approve it. A preceding `posts?tags=to_be_hero_x` result is a series tag and must be skipped. |
| Alias page | `https://danbooru.donmai.us/tag_aliases/126168` for AniList's Tooka Yatogami | Fetch `/tag_aliases/126168.json`. It records the active alias `yatogami_tooka` to `yatogami_tohka`. Verify that the destination is an active character tag, then approve the canonical tag. This character is already approved locally; the URL illustrates a possible future search result, not one observed in the five-character pilot. |
| Post page | `https://danbooru.donmai.us/posts/11965047` for AniList's Richeh | Fetch `/posts/11965047.json`. Its one character tag is `richeh_(tongari_boushi_no_atelier)`. Verify it is active, then approve it. The different English and Japanese anime titles do not block approval. |

A post with several character tags remains ambiguous. An inactive alias, a tag in the wrong category, or a link outside supported Danbooru hosts cannot authorize an automatic approval.

Begin with a read-only sample spread across characters with zero, one, and multiple saved candidates, rather than the first ranks alone. Audit every proposed automatic approval in the sample. Proceed to database writes only if the sample produces at least five correct automatic approvals per 50 searches, no incorrect approvals in the audited sample, and search responses remain usable. If HTTP 202 recurs before a useful sample can finish, stop and reconsider the search source. Report searches, usable responses, verified tags, proposed approvals, and review suggestions separately.

## Chosen decision

The user chose automatic approval for a verified character tag without a separate anime-title check. The tradeoff is a possible false match when a search result points to a different character. Audit every proposed approval in the initial sample, including any namesakes, before writing bulk decisions.

An earlier five-character read-only run used the anime query first and completed three checks: Jimihen matched through the name-only fallback, while Jirou Azuma and Rikka Isurugi matched through the anime query. DuckDuckGo challenged the fourth character's fallback query, so that character and the fifth were not completed. No database decisions were written. The user then chose to try the name-only query first and the anime query second.
