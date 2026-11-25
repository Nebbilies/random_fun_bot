# Centralized name search validation

## Scope shipped

Shared `lib/nameSearch.js` matching is used by character, wishlist-removal, and franchise lookups. Existing public array results, exact precedence, rank syntax, caller scopes, and menus are retained. Meaningful word/prefix candidates are combined, followed by bounded typo matching and substring fallback. Rank is only a textual-quality tie-breaker.

Typo-only gifts and trade counteroffers use the existing picker to let the selecting owner accept the corrected identity. A newer typed query invalidates an older picker. Normal literal partial matches keep their prior interaction flow.

No item activation, portal, quiz, schema, or pagination redesign is included. The two existing first-25 ambiguous dropdown limitations remain separate follow-ups, as documented in the revised plan.

## Tests and review

Added tests for exact precedence, shared aliases, surname/prefix ambiguity, typo/transposition matches, Unicode, invalid aliases, numeric distinctions, missing query words, rank grammar, original row identity, prepared/unprepared equivalence, and corrected-transfer acceptance/stale controls.

Independent review found and prompted fixes for franchise exact ordering, full-label matching dropping a query word, alphanumeric version prefixes, preservation of legacy supplementary-character/punctuation exact matches, and repeated prepared-search work. These have regression coverage.

Run the full suite with `npm test` and the checked-JavaScript validation with `npm run typecheck:catalog`. Logs are local artifacts, not repository content. Final results are recorded in the PR.

## Performance smoke check

Windows, local Node 22, synthetic prepared character catalog; no production database read or modified. Fixture: 15,001 characters, each synthetic character has a numbered primary label, numbered alias and shared alias; one real-style `Satoru Gojo` target. Five calls per query, while regression tests were also active:

| Query                | Observed elapsed range |
| -------------------- | ---------------------- |
| Exact `Satoru Gojo`  | 1–3 ms                 |
| Word `gojo`          | 28–44 ms               |
| Typo `gojp`          | 49–112 ms              |
| Unrelated `zzzzzzzz` | 45–74 ms               |

These are smoke measurements, not percentiles or production guarantees. Prepared snapshots cache normalized tokens and character rank order; per-search memoization avoids repeated scoring of shared aliases/word sequences. Fuzzy distance uses bounded bands, length rejection and a conservative absent-code-point lower bound. Exact and meaningful-word matches skip the fuzzy pass.

A 100,001-character stress fixture still took roughly 0.5–1.4 seconds for fuzzy/no-hit calls on this host during concurrent validation. This remains a scaling limitation of synchronous full-catalog scanning, not a claim that arbitrary catalog sizes are inexpensive. There was no production-sized snapshot available; remeasure before using substantially larger catalogs. Candidate sets are never silently truncated to improve these timings.
