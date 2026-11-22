# Collection profile card design

Phase 2 proposal for the guild character game. The visual reference is the [approved Index frame](https://www.figma.com/design/dmYRK1QvESy9QuCuj8zVc5/Collection-Profile?node-id=3-4). Use its 1440 × 1080 layout, including its spacing, portrait crops, two equal ranking tables, and trailing affection hearts.

## Player experience

`!profile` displays the caller’s current collection in the guild where they invoked the command. It uses the configured game prefix and the player’s guild display name and avatar.

The bot first replies with this exact text.

```text
Rendering your profile card...
-# Loading collection stats...
```

After collection data is ready, edit the same reply and replace its second line with `-# Preparing portraits...`. Once portrait loading and fallbacks are ready, replace that line with `-# Rendering image...`. Finish by clearing the progress text and putting `profile-card.png` inside an embed on the same reply. The embed title is `<display name>'s Profile Card`.

The subtitle is **Waifu Roller**. Put `// TODO: add profile titles feature later` next to the fixed subtitle in production code.

## Data and edge cases

| Field | Rule |
| --- | --- |
| Characters | Count all of the caller’s current marriages in this guild. Archived characters still owned by the player count. |
| Server Rank | Use the caller’s position on the existing total-married server leaderboard, including its guild membership filter and tie order. A player with zero characters is `Unranked`. |
| Soulmate | Show the selected, currently owned character with their affection. Show `No soulmate selected` for an empty selection. |
| Top characters | Show up to five currently owned characters by affection descending, with the existing name and ID tie-break. Keep zero-affection characters eligible and show each score with a trailing heart. |
| Top franchises | Show up to five effective catalog franchises by distinct owned character count descending. Count each owned character once per franchise it belongs to and break ties by franchise name, then ID. Show rank, franchise name, and right-aligned count. |

The current [affection overview](../lib/characterAffection.js#L85), [total-married leaderboard](../lib/serverLeaderboard.js#L28), and [effective franchise mapping](../lib/catalogFinalSchema.js#L349) provide the game rules. Use the read paths so opening a profile has no effect on rewards. The character table shows `No characters collected yet` when empty and the franchise table shows `No franchises yet` when empty. A shorter collection shows its available rows.

A missing or undecodable portrait keeps its slot, with a dimmed background and a centered question mark. The name and score remain visible. A failure that prevents an accurate card or its upload replaces the status line with a short error on the same message when Discord still permits editing it.

## Rendering design

| Option | Consequence |
| --- | --- |
| Build and draw inside the command handler | Straightforward entry point, with data and layout tightly coupled to Discord edits. |
| Read the current collection, prepare portraits, and draw through a renderer that accepts plain data | Keeps the handler focused on progress and the final embed. Allows deterministic layout tests without a live Discord message or database. |
| Put rendering in a separate service or queue | Gives rendering a separate runtime at the cost of another service and a message delivery protocol. |

Use the second option inside the existing bot process. The command owns the three progress stages. Scope collection reads to the invoking guild and player. The renderer receives the resolved stats and portraits, draws with `skia-canvas`, and returns an in-memory PNG buffer. Send it with the existing Discord.js [buffer attachment pattern](../commands/utility/astra-upload-test.js#L15) and an `attachment://profile-card.png` image URL on the embed.

Register the approved card fonts from local assets so the render uses the same type on Windows and Linux. Measure text before drawing. Soulmate names can use a compact size and two lines, with the score below. Ranked character names use a compact size if needed and stay on one line. Use an ellipsis when the allowed width or line count is exhausted. Keep artwork crops inside their slots.

Prepare the avatar and relevant character portraits with a bounded timeout and reuse a portrait within the request when the soulmate also appears in Top characters. Keep records and names in the render model independent of portrait availability. The renderer uses the approved Skia Canvas approach, with no additional image-processing library required for this layout.

## Verification before shipping

- Check the exact three progress states, their order, the final embed title and image, and failure handling using a single message ID.
- Verify current guild ownership, leaderboard rank parity, affection ties and zeroes, multi-franchise counting, fewer than five rows, and empty states.
- Check the 1440 × 1080 PNG at full size and 360 px wide, including a long name such as Tsukishiro Yanagi and one missing portrait.
- Verify that the native Skia package installs on the Ubuntu deployment target with Node 22 and can load the fonts and export the PNG.

## Design review

Self-approved for user review on 2026-11-22. The proposal matches the approved Index layout, progress copy, final embed, subtitle and TODO, and missing-portrait treatment. Verified the guild ownership, rank, affection, franchise, and Discord attachment references against the branch base.
