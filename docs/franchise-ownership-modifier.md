# Franchise ownership lookup modifier

Append `o` to franchise lookups to show each married character's current owner in the current guild:

- `!imao <franchise>`: names with ownership.
- `!imaro <franchise>`: ranks, names, and ownership.
- Flags are order-independent (`!imoa`, `!imora`, etc.); repeated flags are harmless.
- Examples use `!`; commands respect the configured server prefix.

A married row reads `Character 💞 => <@user>` (or `#123 - Character 💞 => <@user>` with ranks). The mention is displayed without pinging. Unmarried characters have no owner suffix, including characters married only in another guild. Owners who left the guild remain owners until the marriage ends.

Ownership is re-read on rendering, including page changes and control expiry; posted results do not update automatically while idle. Franchise chooser labels remain unchanged.

Commands without `o` retain their existing output. Individual `!im` cards, `!char`, and `!mm` are unchanged; this does not introduce `!imo` or `!mmo`.
