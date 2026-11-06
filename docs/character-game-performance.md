# Character-game performance changes

The performance work has three independent commits: explicit legacy-vault
retirement tooling, fresh bulk server-leaderboard membership, and prepared
catalog searches. Candidate selection, eligibility, resource spending, reward
recovery and the six-second staged item reveals are unchanged.

## Legacy vault retirement

Follow the final-schema retirement procedure in `legacy-vault-abandonment.md`.
Deployment alone does not retire production data. The operation archives and
removes only the two reviewed exceptions and their notices/contract, retaining
affection legacy markers and all other player data. Without the contract, the
existing validator returns before reading vault history. Older backups retain
their validation path.

## Leaderboards

Each new command calculates current scores and requests fresh candidate members
in batches of at most 100 IDs. There is no membership TTL cache. All batches share
a five-second deadline. Completed results preserve score order and filter absent
members; failed requests produce a retry message instead of partial standings.
Already-open cards keep their existing pagination snapshot.

## Search preparation

The catalog cache prepares normalized character names/aliases and full/direct-only
franchise names once per snapshot. Public lookup signatures and match precedence
remain unchanged; ad-hoc live harem lists still use fresh metadata. WeakMaps keep
prepared fields out of returned character/card data without retaining discarded
snapshots. The exposed revision format remains compatible.

The cache checks the durable revision and franchise freshness on access. Rebuilds
read all models and freshness state in one SQLite transaction. Franchise commands
use that coherent snapshot, including its direct-only mode. Failed rebuilds throw
instead of serving obsolete data. Startup prepares the initial snapshot after
recovery and before enabling game commands.

## Validation

Local full suite: 1,725 passed, one skipped, zero failures. Catalog typecheck and
existing deployment safety checks pass. VPS measurements use the production Node
version, disposable SQLite snapshots and intercepted Discord writes. First
response generation and handler completion are recorded separately; neither
includes Discord message-delivery latency. Real membership-network samples are
reported separately from simulated command processing.
