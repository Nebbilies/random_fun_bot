# Kaimetsu design

Status: Design approved by the user and implemented. The rules below are the agreed feature contract; focused tests cover gameplay, transaction safety, runtime confirmation, tier odds, and discovery presentation.

## Item and tier

- Item name: **Kaimetsu**.
- New rarity tier: literally **???**, with a black accent and ⚫ marker. The tier name remains ??? after discovery.
- Normal description, exactly: `Divorce half the harem of EVERY user.`
- Scope is the guild where the item is used, never other guilds.
- One charge. Any holder may use it; no administrator restriction.
- Use existing prefix commands and inventory controls, not slash commands. Use Components V2 for the destructive confirmation.

## Vault odds

Default distribution per opened vault:

| Tier | Probability |
| --- | ---: |
| Common | 59.9% |
| Rare | 20% |
| Epic | 15% |
| Legendary | 5% |
| ??? | 0.1% |

Kaimetsu's probability is funded by reducing Common by 0.1 percentage points, not by proportionally reducing all existing tiers. These are vault-opening odds, not the probability that a normal roll produces a vault. Preserve the existing runtime configuration system; defaults must total 100, rather than adding 0.1 to a total of 100.

## Discovery

Use existing permanent guild-wide acquisition discovery. The first successful acquisition by any player discovers Kaimetsu for that guild; merely revealing or declining a pending vault reward does not. Consuming all copies does not undo discovery.

Before discovery, use the following exact strings wherever Kaimetsu is presented, including the guild item list and pending vault reward previews:

Name:

```text
?̴͡?̕?̸
```

Description:

```text
D̑͢͞iͧ͡ͅv̸̰̑?̴̮ͫ?̺͑͞?͍̍͝?͉ͮ͝?̸͈̅?̴͈̃?̷̖̅?̫ͯ̕ ?̫̋͠?̵͚͘?̛́ͅ?̛̫ͮ?̴͑͟l͖̃͞f̷̭̿ ṱ̵̀ḫ̷̒è̶̢ h̶̜̓a̘̍͝?̷̲̈?͍̈́͠?̸̧ͫ?̵̖̊m̶̗ͯ ơ̧̄f͙ͤ̕ E̶͙͘?͍̆͠?̷̬̋?̻̾͡?̛̈͜?̵̧̆Y̴̰̒ ?͉̽͞?̮́͠s̵̯̀?̸̢͛?̸͙̆r̵̟ͫ.̨̎̕.
```

After discovery, display the normal name and description. Other undiscovered items retain their existing plain question-mark masking. Discovery in one guild must not reveal Kaimetsu in another.

## Activation and selection

Opening a vault awards an inventory item; it never triggers the destructive effect. The holder must explicitly use Kaimetsu and confirm a warning stating that it affects every stored harem in this guild, including their own.

At accepted confirmation:

1. Read current guild ownership and soulbinding state, not a stale preview snapshot.
2. Include every stored harem in the guild, including the activator's, departed members' collections, and any other stored owners. Do not require current membership lookups.
3. For each owner, form the pool of all non-soulbound owned characters.
4. Select `floor(pool size / 2)` characters uniformly at random without replacement, independently for each owner.
5. Divorce selected characters, returning them to the unowned pool. No transfer, extra divorce gamble, or automatic claim card.

Examples: an eligible pool of 1 loses 0, 3 loses 1, and 10 loses 5. An owner with 10 characters, 2 soulbound, loses 4 of the remaining 8, regardless of how many of those 8 are busy.

## Protections and conflicting interactions

Soulbinding is the only character protection that grants immunity. Mirror Shield, Counterfeit Crown, and temporary theft protection neither block nor redirect Kaimetsu and are not consumed as defensive payments. Ordinary cleanup of invalid state, such as a Crown whose decoy no longer belongs to its owner, must still occur.

Busy status grants no immunity and does not reduce the eligible pool. Selected characters may be involved in live escapes, pending trades/gifts, or Hostage challenges. Safely cancel conflicting interactions involving selected characters, invalidating their controls so they cannot subsequently modify ownership. Unrelated interactions continue.

A cancelled Hostage challenge causes no additional divorce or exchange. An already-consumed Hostage Note remains spent; cancellation must not refund it. Respect exact marriage identities so delayed interactions cannot act on later remarriages.

## Costs, consistency, and results

- Cancelled or expired confirmations consume nothing.
- If the guild-wide calculated loss is zero, consume nothing.
- Successful use consumes one charge exactly once.
- Consumption, divorces, and conflicting-interaction cancellations must succeed together or leave everything unchanged. Plan carefully around persistent ownership/challenges and in-memory escapes/trades so rollback cannot leave partial cancellations.
- Follow the existing durable action/replay boundary: repeated confirmation, process recovery, or delivery retry must not repeat divorces or spend another charge.
- A committed effect is not undone merely because announcing it fails; persist the result for safe delivery recovery.
- Public result names the activator and reports total characters divorced and number of affected owners. Do not mass-ping owners or publish a complete character list.

## Verification targets

- Tier metadata, black rendering, ordering/filtering, configuration acceptance, and default vault distribution.
- Kaimetsu receives exactly the intended default 0.1% share; existing Rare/Epic/Legendary probabilities remain unchanged.
- Exact corrupted strings on undiscovered item list and vault previews; normal strings after acquisition; guild isolation and permanent discovery.
- Award versus activation separation, owner-bound confirmation, one charge, cancellation, expiry, and zero-loss behavior.
- Floor rounding and random selection without replacement per owner, including activator and departed owners, with no cross-guild effects.
- Soulbound immunity; other defenses do not protect, redirect, or spend themselves.
- Busy characters remain eligible; selected-character escapes/trades/gifts/Hostage challenges cancel safely; unrelated interactions survive.
- No Hostage refund or secondary punishment after cancellation; stale interaction controls cannot alter later ownership.
- Atomic rollback, duplicate-confirmation/restart safety, and announcement recovery.
