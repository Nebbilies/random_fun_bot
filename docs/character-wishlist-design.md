# Character wishlist — design

## Goal

Let a player declare up to seven characters they want, and announce it when one of them
is rolled in their server, so wishlisters can react to a roll they would otherwise miss.

## Agreed language

- **Wish** — one player's declared intent to obtain one character in one server. The
  character identity (AniList id) is resolved and fixed when the wish is made.
- **Wishlist** — a player's bounded set of wishes in one server, at most seven.
- **Wish match** — a roll whose character appears on at least one wishlist in that server.

`GLOSSARY.md` owns the definitions; this document owns the rules. No ADR is recorded:
the seven-slot cap and the per-server scope are one constant and one migration away from
being different, so they are not hard to reverse.

## Commands

| Command                        | Effect                                                    |
| ------------------------------ | --------------------------------------------------------- |
| `!wish <name or #rank>`        | Resolve against the character catalog and add the wish.   |
| `!wish remove <name or #rank>` | Remove one wish. Matches only the caller's own entries.   |
| `!wish clear`                  | Remove every wish the caller holds in this server.        |
| `!wish`                        | Show the wishlist.                                        |
| `!wl`, `!wishlist`             | Show the wishlist. Argument-free aliases of bare `!wish`. |

`remove` and `clear` are keywords only as the first argument. A character literally named
`Remove` or `Clear` is still reachable with `#rank`.

All five are ordinary message commands and belong to the game-command allowlist in
`index.js`, so the landmine roll cannot swallow them.

## Rules

- A wishlist holds at most seven wishes per player per server. Adding an eighth is
  refused with the current count and the removal command; nothing is replaced silently.
- Re-adding a wish already on the list reports that it is already there and does not
  consume anything.
- Wishing for a character that is owned, including by the caller, is allowed. The list is
  a target list; ownership is orthogonal.
- Adding resolves through the `!char` search: one match saves immediately, no match
  reports the failure, and several matches open a picker labelled `#rank • Name`. The
  picker reuses the `!char` interaction pattern — a collector on the reply, locked to the
  command author, one hour of life — but has no pages or modal, because a wishlist can
  hold at most seven entries. Picking edits the same message into the wishlist view, so
  the reply doubles as the confirmation.
- Removing resolves against the caller's own wishes only, never the whole catalog. Several
  matches open the same picker restricted to those entries.
- A wishlist is per server. The seven slots mean the same thing in every server, but the
  set of wishes does not cross servers, matching character ownership.
- Wishes outlive catalog publication. Publication deletes and reinserts `characters`
  rows, so the table keeps no foreign key to `characters` (as with `marriages`); a wished
  character that leaves the catalog keeps its name from `character_identities` and is
  shown as `#? • Name (not in catalog)` until the character returns.

## Roll presentation

A wish match adds one line above the roll card and one accent color.

- The line is `⭐ <@a>, <@b>, <@c>'s Wish` in a single text display above the card
  container, in the same message. It names every matching player and nothing else — no
  count, no separate message.
- An escape card that is also a wish match shows the escape text first and the wish line
  second. The escape text is actionable and time-boxed, so it keeps the top slot.
- Accent precedence: married brown `0x8b4513` > wish green `0x57f287` > escape purple
  `0x9b59b6` > default pink `0xe91e63`. Brown is a terminal state the card stays in, so
  it overwrites everything; green is the headline of the roll in progress; purple only
  describes a sixty-second window that green already sits inside.
- The wish line is rendered on every escape-card refresh so it does not flicker, but only
  the first render adds the matching players to `allowedMentions`. Refreshes pass them
  with pinging suppressed.
- Mentions are always an explicit id list with `parse: []`; nothing is parsed from the
  card text. No numeric cap on how many wishlisters may be named.
- A wish match is announced on: normal rolls (`!w`, `!h`, `!ru`, `!mu`), the escape card
  from a roll, and an item-forced escape. Not on mystery reveals or vault rewards, which
  hide the character by design, and not on the separate `has married X` announcement,
  which already pings the new owner.

## Storage

Catalog database `PRAGMA user_version = 8`.

```sql
CREATE TABLE IF NOT EXISTS character_wishes (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, character_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, character_id)
);
CREATE INDEX IF NOT EXISTS character_wishes_by_character
  ON character_wishes (guild_id, character_id);
```

The primary key makes a duplicate wish impossible; the character index makes the
roll-time lookup one indexed read. The cap is enforced in application code inside the
existing immediate transaction rather than by a trigger.

## Deferred

`!wl` lists rank and name only. Ownership status will arrive with a separate
owned-waifu view.
