import { parseArgs } from "node:util";
import { basename, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createEvidence } from "../lib/catalogConversionOperation.js";
import {
  projectRankingMaintenance,
  previewRankingMaintenance,
  confirmRankingMaintenance,
} from "../lib/catalogRankingMaintenance.js";
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      db: { type: "string" },
      report: { type: "string" },
      actor: { type: "string" },
      commit: { type: "boolean" },
      "refresh-danbooru": { type: "boolean" },
      all: { type: "boolean" },
      ids: { type: "string" },
      "expected-revision": { type: "string" },
      "idempotency-key": { type: "string" },
      "preview-id": { type: "string" },
      "payload-hash": { type: "string" },
      "save-preview": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Manual ranking maintenance: --db FILE --report NEW.jsonl [--refresh-danbooru (--all | --ids UUID,...)] [--save-preview --actor LABEL --expected-revision N]. Confirm with --commit --actor LABEL --preview-id UUID --payload-hash SHA256 --idempotency-key KEY. Default is read-only projection. No bootstrap/reset.",
    );
    return;
  }
  if (!values.db || !values.report)
    throw new Error("Explicit --db and --report required");
  if (values.commit && values["save-preview"])
    throw new Error("Commit and save-preview are mutually exclusive");
  if (values["refresh-danbooru"] && Boolean(values.all) === Boolean(values.ids))
    throw new Error("Refresh requires exactly one of --all or --ids");
  if (!values["refresh-danbooru"] && (values.all || values.ids))
    throw new Error("Selection requires --refresh-danbooru");
  if (
    values.commit &&
    (values["refresh-danbooru"] ||
      !values.actor ||
      !values["preview-id"] ||
      !values["payload-hash"] ||
      !values["idempotency-key"])
  )
    throw new Error(
      "Commit requires an existing bound preview and attribution; no HTTP on confirmation",
    );
  if (
    values["save-preview"] &&
    (!values.actor ||
      !/^\d+$/.test(values["expected-revision"] ?? "") ||
      !Number.isSafeInteger(Number(values["expected-revision"])))
  )
    throw new Error("Save-preview requires actor and expected revision");
  const databasePath = realpathSync(values.db);
  const reportPath = resolve(
    realpathSync(dirname(resolve(values.report))),
    basename(values.report),
  );
  if (
    [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      `${databasePath}-journal`,
    ].some((path) => path.toLowerCase() === reportPath.toLowerCase())
  )
    throw new Error("Report must be separate from database and sidecars");
  const evidence = createEvidence(reportPath);
  let db, result, failure;
  try {
    evidence.append({
      phase: "start",
      operation: "ranking-maintenance",
      actor: values.actor ?? "inventory",
      outcome: "uncertain",
    });
    db = new DatabaseSync(databasePath, {
      readOnly: !values.commit && !values["save-preview"],
    });
    db.exec("PRAGMA foreign_keys=ON");
    if (values.commit)
      result = confirmRankingMaintenance(db, {
        account: values.actor,
        role: "admin",
        previewId: values["preview-id"],
        payloadHash: values["payload-hash"],
        idempotencyKey: values["idempotency-key"],
      });
    else {
      const options = {
        refresh: values["refresh-danbooru"] === true,
        ids: values.ids?.split(",") ?? null,
        expectedRevision:
          values["expected-revision"] === undefined
            ? undefined
            : Number(values["expected-revision"]),
      };
      result = values["save-preview"]
        ? await previewRankingMaintenance(db, {
            ...options,
            account: values.actor,
            role: "admin",
          })
        : await projectRankingMaintenance(db, options);
    }
    evidence.append({
      phase: "outcome",
      outcome: values.commit
        ? "committed"
        : values["save-preview"]
          ? "preview-saved"
          : "read-only",
      result,
    });
  } catch (error) {
    failure = error;
    try {
      evidence.append({
        phase: "outcome",
        outcome: "inspect-required",
        error: error.message,
      });
    } catch {
      /* Preserve start evidence. */
    }
  } finally {
    try {
      db?.close();
    } finally {
      evidence.close();
    }
  }
  if (failure) throw failure;
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
