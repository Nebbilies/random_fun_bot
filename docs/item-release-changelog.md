# Item release changelog

`itemlist` displays the latest maintained release in `lib/itemReleases.js`, independently of its rarity filter and catalog page.

## Publishing a release

1. Register the new item definitions and their portal configuration.
2. Add an `ITEM_RELEASES` record with a fixed ISO date (`YYYY-MM-DD`) and the new item IDs. Use the actual release date; never `Date.now()` in rendering.
3. Run `node --test test/itemReleases.test.js test/itemList.test.js`.

Example:

```js
{ date: '2026-10-28', itemIds: ['fortunes_lens', 'fortunes_recast'] }
```

The latest date wins even if records are not ordered. Keep one record per release date. Invalid dates, duplicate item IDs, and unknown definitions are rejected rather than silently publishing misleading text.

The formatter derives counts, names, and rarity groups from registered definitions, supports single-item and mixed-rarity releases, escapes Markdown in names, and bounds very long announcements. Large releases summarize omitted names and direct readers to the catalog.

Each name follows **guild item discovery**, not the requesting player's inventory. An undiscovered name is `???`; acquiring the item anywhere in the server permanently reveals its name. Merely previewing Lens or Recast choices does not discover items. Catalog changes alone never generate a new announcement.

The initial release record is dated 28/10/2026, the implementation preparation date. Update that fixed date before publication if the actual release moves.
