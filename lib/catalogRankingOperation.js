import { DatabaseSync } from "node:sqlite";
import { basename, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import {
  safeDatabasePath,
  createEvidence,
} from "./catalogConversionOperation.js";
import { readRankingInputs } from "./catalogRankingInputs.js";
import {
  inventoryCharacterRanking,
  migrateCharacterRanking,
} from "./catalogRankingMigration.js";
import { hasCharacterRanking } from "./catalogFinalSchema.js";
import { validateFinalCatalogSchema as validatePredecessor } from "./catalogPreRankingSchema.js";
import { assertCatalogRuntimeRestartReady } from "./catalogRuntimeRecovery.js";

const FLAGS = [
  "commit",
  "rehearse",
  "offline-working-copy",
  "backup-restore-verified",
  "writers-stopped",
  "conversations-drained",
];
const REFS = [
  "source-app-commit",
  "source-runtime",
  "target-app-commit",
  "target-runtime",
  "backup-ref",
  "restore-ref",
  "rehearsal-ref",
];
const VALUES = [
  "db",
  "danbooru-csv",
  "mudae-csv",
  "report",
  "actor",
  "expected-revision",
  "expected-danbooru-hash",
  "expected-mudae-hash",
  ...REFS,
];
export const RANKING_OPERATION_HELP = `Explicit offline character ranking cutover. No startup migration or network.
--db WORKING.sqlite --danbooru-csv FILE --mudae-csv FILE --report NEW.jsonl
Default is read-only inventory; --rehearse converts then rolls back.
--commit additionally requires --actor LABEL --expected-revision INTEGER
--expected-danbooru-hash SHA256 --expected-mudae-hash SHA256
--offline-working-copy --backup-restore-verified --writers-stopped --conversations-drained
--source-app-commit HEX --source-runtime REF --target-app-commit HEX --target-runtime REF
--backup-ref REF --restore-ref REF --rehearsal-ref REF
Commit requires Node 22.23.2 and persisted game_maintenance=drain. Only separately named offline working copies are writable.
Reports are exclusively created and fsynced. Preserve uncertain outcome evidence and inspect read-only before retrying.
`;

export function parseRankingOperationArgs(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]))
    return { help: true };
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith("--") ? args[i].slice(2) : "";
    if (![...FLAGS, ...VALUES].includes(key) || Object.hasOwn(out, key))
      throw new Error(`Unknown or duplicate argument: ${args[i]}`);
    if (FLAGS.includes(key)) out[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for --${key}`);
      out[key] = value;
    }
  }
  for (const key of ["db", "danbooru-csv", "mudae-csv", "report"])
    if (!out[key]) throw new Error(`--${key} is required`);
  if (out.commit && out.rehearse)
    throw new Error("Modes are mutually exclusive");
  if (out.commit) {
    for (const key of [
      ...FLAGS.filter((k) => !["commit", "rehearse"].includes(k)),
      ...VALUES.filter(
        (k) => !["db", "danbooru-csv", "mudae-csv", "report"].includes(k),
      ),
    ]) {
      if (!out[key]) throw new Error(`--commit requires --${key}`);
    }
    if (
      !/^\d+$/.test(out["expected-revision"]) ||
      !Number.isSafeInteger(Number(out["expected-revision"]))
    )
      throw new Error("Invalid expected revision");
    for (const key of ["expected-danbooru-hash", "expected-mudae-hash"])
      if (!/^[0-9a-f]{64}$/.test(out[key]))
        throw new Error("Invalid expected input hash");
    for (const key of [...REFS, "actor"])
      if (
        !/^[a-z0-9][a-z0-9._:/@+\-]{0,119}$/i.test(out[key]) ||
        out[key].includes("://")
      )
        throw new Error(`Invalid non-secret reference --${key}`);
    for (const key of ["source-app-commit", "target-app-commit"])
      if (!/^[0-9a-f]{7,64}$/i.test(out[key]))
        throw new Error(`Invalid --${key}`);
  }
  return out;
}

export function runRankingOperation(options) {
  const o = parseRankingOperationArgs(
    Object.entries(options).flatMap(([key, value]) =>
      value === true ? [`--${key}`] : [`--${key}`, String(value)],
    ),
  );
  const path = safeDatabasePath(o.db);
  if (path.toLowerCase() !== resolve(o.db).toLowerCase())
    throw new Error(
      "Refusing database aliases; use the canonical offline working-copy path",
    );
  if (o.commit && process.version !== "v22.23.2")
    throw new Error("Commit requires pinned Node v22.23.2");
  const reportPath = resolve(
    realpathSync(dirname(resolve(o.report))),
    basename(o.report),
  );
  if (
    [path, `${path}-wal`, `${path}-shm`, `${path}-journal`].some(
      (p) => p.toLowerCase() === reportPath.toLowerCase(),
    )
  )
    throw new Error("Report must be separate from database and sidecars");
  const inputs = readRankingInputs(o["danbooru-csv"], o["mudae-csv"]);
  if (
    o.commit &&
    (inputs.hashes.danbooru !== o["expected-danbooru-hash"] ||
      inputs.hashes.mudae !== o["expected-mudae-hash"])
  )
    throw new Error("Input hashes changed");
  const evidence = createEvidence(reportPath);
  let db,
    result,
    failure,
    outcome = "uncertain";
  const base = {
    operation: "character-ranking-bootstrap",
    hashes: inputs.hashes,
    runtime: process.version,
    sources: {
      danbooru: basename(o["danbooru-csv"]),
      mudae: basename(o["mudae-csv"]),
    },
    actor: o.actor ?? "inventory",
    references: Object.fromEntries(
      REFS.filter((k) => o[k]).map((k) => [k, o[k]]),
    ),
  };
  try {
    evidence.append({ ...base, phase: "start", outcome });
    db = new DatabaseSync(path, { readOnly: !o.commit && !o.rehearse });
    if (
      o.commit &&
      db
        .prepare("SELECT value FROM catalog_meta WHERE key='game_maintenance'")
        .get()?.value !== "drain"
    )
      throw new Error("Persisted game_maintenance=drain required");
    if (!o.commit && !o.rehearse && !hasCharacterRanking(db)) {
      const inventory = inventoryCharacterRanking(db, inputs);
      result = {
        identities: inventory.current.length,
        revision: inventory.state.revision,
        hashes: inputs.hashes,
        changes: inventory.changes,
        targetedRules: inventory.rules,
        committed: false,
      };
      outcome = "read-only";
    } else {
      result = migrateCharacterRanking(db, {
        inputs,
        actor: o.actor ?? "rehearsal",
        dryRun: !o.commit,
        expectedRevision:
          o["expected-revision"] === undefined
            ? undefined
            : Number(o["expected-revision"]),
        beforeCommit(connection, result) {
          if (
            o.commit &&
            connection
              .prepare(
                "SELECT value FROM catalog_meta WHERE key='game_maintenance'",
              )
              .get()?.value !== "drain"
          )
            throw new Error("Persisted drain changed");
          assertCatalogRuntimeRestartReady(connection);
          evidence.append({
            ...base,
            phase: "validated-before-commit",
            outcome: "uncertain",
            result,
          });
        },
      });
      outcome = result.noOp
        ? "already-committed"
        : result.committed
          ? "committed"
          : "rolled-back";
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      db?.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (outcome === "uncertain") {
    let inspect;
    try {
      inspect = new DatabaseSync(path, { readOnly: true });
      if (hasCharacterRanking(inspect)) {
        const retry = migrateCharacterRanking(inspect, {
          inputs,
          actor: o.actor ?? "inspection",
        });
        if (retry.noOp) outcome = "committed";
      } else {
        validatePredecessor(inspect);
        outcome = "not-committed";
      }
    } catch {
      /* Preserve uncertainty until an operator can inspect authoritative state. */
    } finally {
      try {
        inspect?.close();
      } catch {
        /* Keep the primary failure. */
      }
    }
  }
  const report = {
    ...base,
    phase: "outcome",
    outcome,
    result,
    error: failure?.message,
  };
  try {
    evidence.append(report);
  } catch (error) {
    failure = new Error(
      `Evidence outcome write failed; database outcome=${outcome}. Preserve report and inspect read-only. ${error.message}`,
      { cause: failure ?? error },
    );
  }
  try {
    evidence.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    failure.operationReport = report;
    throw failure;
  }
  return report;
}
