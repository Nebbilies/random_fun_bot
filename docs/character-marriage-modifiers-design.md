# Marriage Command Modifiers — Design Proposal

## Goal

Extend the player marriage list command (`!mm` / `!mymarry`) with composable modifiers:
- `a`: Group owned characters by anime franchise.
- `i`: Display characters individually as full cards with Previous/Next navigation.
- `r`: Sort by catalog rank (existing modifier, composable with `a` and `i`).

Restructure the marriage command routing to support dynamic modifier combinations and enable future modifiers without introducing separate command files.

## Agreed Language and Rules

- **Modifier syntax**: Letters appended directly to the base command (e.g. `!mm`, `!mmr`, `!mma`, `!mmar`, `!mmra`, `!mmi`, `!mmir`, `!mmri`, `!mmai`). Order of modifier letters is insensitive.
- **Precedence**: When `a` and `i` are both supplied, `i` takes precedence and `a` is ignored (e.g. `!mmai` runs individual card view `i`).
- **Unrecognized modifiers**: Commands matching `^mm([a-z]*)$` or `^mymarry([a-z]*)$` with unrecognized flags are rejected with a clear usage message.
- **Rank formatting**: Whenever characters are sorted by rank (`r` modifier present), the rank number is bolded: `**#<rank>** - <Name>`.
- **Franchise view (`a`)**:
  - Franchises are listed in alphabetical order (A–Z).
  - Heading format: `**<Franchise Name> - <Count>**`.
  - Characters within each franchise:
    - With `r` (`!mmar` / `!mmra`): sorted by catalog rank ascending (`**#<rank>** - <Name>`).
    - Without `r` (`!mma`): sorted by marriage time (`married_at DESC`, `<Name>`).
  - Characters not associated with any catalog franchise are grouped under `Other - <Count>` at the end.
  - Paginated at 20 characters per page with Previous/Next buttons. If a franchise spans across a page split, its heading repeats with `(continued)` (e.g. `**<Franchise Name> (continued) - <Count>**`).
  - Top thumbnail displays the highest-ranked character across the entire harem, consistent with `!mm`.
- **Individual card view (`i`)**:
  - Header: `# [Character Name](site_url)` (or `# Character Name` if no site URL).
  - Details:
    - `**Anime:** <Anime Name>`
    - `**Rank:** #<rank> • **Favorites:** <favorites>` (no aliases included)
  - Image: Primary catalog image attached as media gallery item.
  - Footer: `<@user>'s harem • Character X of Y`.
  - Controls: Previous and Next buttons (disabled at start/end boundaries).
  - Sort order: by marriage time (`married_at DESC`) by default, or by catalog rank (`character.rank ASC`) when `r` is present.

## Architecture and Storage

- No database schema migrations required. Existing `marriages`, `characters`, `character_anime`, `franchise_anime`, and `franchises` tables supply all required data.
- `lib/characterMarriage.js`:
  - Enhance `listMarriages` to include `favourites`, `site_url`, and `anime_titles`.
  - Add `listMarriagesByFranchise` to group marriages by franchise with deduplicated character appearances and alphabetical franchise ordering.
- `commands/mm.js`:
  - `parseMarriageCommand(commandName)` parses base and flags, validates letters, and determines layout (`list`, `franchise`, `individual`) and sort (`time`, `rank`).
  - Unified view rendering and component collector handling for all layouts.
- `index.js`:
  - Dynamically route `/^(mm|mymarry)([a-z]*)$/` to `commands/mm.js`.
