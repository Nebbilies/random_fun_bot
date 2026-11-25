import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openCatalog,
  createFinalCatalog,
  publishCatalog,
} from "../lib/catalogDb.js";
import {
  previewCatalogMutation,
  confirmCatalogMutation,
} from "../lib/catalogMutations.js";
import { createCatalogCache } from "../lib/catalogCache.js";
import { bindSourceCatalogStaging } from "../lib/sourceCatalogPublication.js";
import { findCharacters } from "../lib/gameCharacterLookup.js";
import { findFranchises } from "../lib/franchiseLookup.js";

const auth = { account: "concurrent-editor", role: "moderator" };
// Re-execute this file as a real SQLite writer, not an in-process connection or worker thread.
if (process.argv[2] === "--catalog-writer") {
  const db = openCatalog(process.argv[3]);
  db.exec("PRAGMA busy_timeout=10000");
  process.send({ type: "ready", pid: process.pid });
  process.once("message", (job) => {
    process.send({ type: "attempting", pid: process.pid });
    let outcome;
    try {
      const result =
        job.operation === "publish"
          ? publishCatalog(db, () => {
              // A marker in the other read model commits in the same publication snapshot.
              db.exec(
                "UPDATE franchises SET display_name='Published franchise' WHERE id=1",
              );
            })
          : confirmCatalogMutation(db, job.options);
      outcome = { type: "result", ok: true, result, pid: process.pid };
    } catch (error) {
      outcome = {
        type: "result",
        ok: false,
        error: error.message,
        pid: process.pid,
      };
    }
    db.close();
    process.send(outcome, () => process.disconnect());
  });
} else {
  test(
    "independent processes serialize stale confirmations and publication on authoritative v12",
    { timeout: 45000 },
    async (t) => {
      const directory = mkdtempSync(
        join(tmpdir(), "catalog-competing-writers-"),
      );
      const path = join(directory, "synthetic.sqlite");
      const children = [];
      let db;
      t.after(async () => {
        for (const child of children) if (child.exitCode === null) child.kill();
        await Promise.all(children.map((child) => child.done));
        db?.close();
        rmSync(directory, { recursive: true, force: true });
      });
      db = createFinalCatalog(path);
      db.exec(`PRAGMA journal_mode=WAL;
      INSERT INTO character_identities(id,name_full) VALUES('aaaaaaaa-0000-4000-8000-000000000001','Imported');
      INSERT INTO character_sources VALUES('anilist','1','aaaaaaaa-0000-4000-8000-000000000001');
      INSERT INTO characters(id,rank,tie_order,favourites,name_full) VALUES('aaaaaaaa-0000-4000-8000-000000000001',1,1,100,'Imported');
      INSERT INTO franchises(id,display_name,created_at) VALUES(1,'Synthetic franchise','synthetic');`);
      db.exec("BEGIN IMMEDIATE");
      try {
        bindSourceCatalogStaging(db);
        db.exec(
          "INSERT INTO stage_characters(id,favourites,name_full) VALUES(1,200,'Published')",
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      db.close();
      db = openCatalog(path); // Normal startup validates authoritative final DDL.
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 12);
      const id = db.prepare("SELECT id FROM characters").get().id;
      const cache = createCatalogCache(db);
      const initial = cache.get();
      function preview(alias) {
        return previewCatalogMutation(db, {
          ...auth,
          operation: "edit",
          now: 1000,
          input: {
            characterId: id,
            aliases: [alias],
            franchiseIds: [1],
            referenceUrl: "https://example.test/curated",
          },
        });
      }
      function options(p, key, now = 1001) {
        return {
          ...auth,
          previewId: p.previewId,
          payloadHash: p.payloadHash,
          idempotencyKey: key,
          now,
        };
      }
      function writer() {
        const child = fork(
          fileURLToPath(import.meta.url),
          ["--catalog-writer", path],
          { stdio: ["ignore", "pipe", "pipe", "ipc"] },
        );
        children.push(child);
        const inbox = [];
        const waiters = new Map();
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("message", (message) => {
          const resolve = waiters.get(message.type);
          if (resolve) {
            waiters.delete(message.type);
            resolve(message);
          } else inbox.push(message);
        });
        child.done = new Promise((resolve) =>
          child.once("exit", (code, signal) => resolve({ code, signal })),
        );
        child.wait = (type) =>
          new Promise((resolve, reject) => {
            const index = inbox.findIndex((message) => message.type === type);
            if (index >= 0) return resolve(inbox.splice(index, 1)[0]);
            const timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Writer ${child.pid} timed out: ${type}\n${stderr}`,
                  ),
                ),
              15000,
            );
            waiters.set(type, (value) => {
              clearTimeout(timer);
              resolve(value);
            });
            child.done.then(({ code, signal }) => {
              if (waiters.has(type)) {
                clearTimeout(timer);
                waiters.delete(type);
                reject(new Error(`Writer exited ${code}/${signal}: ${stderr}`));
              }
            });
          });
        return child;
      }
      async function compete(jobs) {
        const workers = jobs.map(() => writer());
        await Promise.all(workers.map((child) => child.wait("ready")));
        assert.equal(
          new Set(workers.map((child) => child.pid)).size,
          jobs.length,
        );
        // Hold the actual SQLite write lock until every process has entered its API call.
        db.exec("BEGIN IMMEDIATE");
        try {
          workers.forEach((child, i) => child.send(jobs[i]));
          await Promise.all(workers.map((child) => child.wait("attempting")));
          // Allow blocked BEGIN IMMEDIATE calls to contend; this is not the ordering oracle.
          await new Promise((resolve) => setTimeout(resolve, 75));
        } finally {
          db.exec("COMMIT");
        }
        const outcomes = await Promise.all(
          workers.map((child) => child.wait("result")),
        );
        for (const child of workers)
          assert.deepEqual(await child.done, { code: 0, signal: null });
        return outcomes;
      }
      const previews = [preview("Winner Alpha"), preview("Winner Beta")];
      assert.equal(previews[0].revision, previews[1].revision);
      const jobs = previews.map((p, i) => ({
        operation: "confirm",
        options: options(p, `race-${i}`),
      }));
      const outcomes = await compete(jobs);
      assert.equal(outcomes.filter((row) => row.ok).length, 1);
      const winner = outcomes.findIndex((row) => row.ok);
      assert.match(outcomes[1 - winner].error, /Stale/i);
      assert.equal(
        db.prepare("SELECT count(*) n FROM catalog_mutations").get().n,
        1,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM catalog_confirmation_results").get()
          .n,
        1,
      );
      const alias = winner === 0 ? "Winner Alpha" : "Winner Beta";
      const edited = cache.get();
      assert.notEqual(edited, initial);
      assert.equal(findCharacters(edited.characterIndex, alias)[0].id, id);
      assert.equal(
        findFranchises(edited.franchiseIndex, "Synthetic franchise")[0].id,
        1,
      );

      // A completely new process must replay the durable result even after expiry.
      const replay = writer();
      await replay.wait("ready");
      replay.send({
        operation: "confirm",
        options: {
          ...jobs[winner].options,
          now: previews[winner].expiresAt + 1,
        },
      });
      const retry = await replay.wait("result");
      assert.equal(retry.ok, true);
      assert.deepEqual(retry.result, outcomes[winner].result);
      assert.deepEqual(await replay.done, { code: 0, signal: null });
      assert.equal(cache.get(), edited);

      const next = preview("Publication Curated");
      const publicationRace = await compete([
        { operation: "confirm", options: options(next, "publication-edit") },
        { operation: "publish" },
      ]);
      assert.equal(publicationRace[1].ok, true, publicationRace[1].error);
      assert.equal(publicationRace[1].result, 1);
      if (!publicationRace[0].ok) {
        assert.match(publicationRace[0].error, /Stale/i);
        // Re-preview explicitly; never silently retry stale input as a new write.
        const fresh = preview("Publication Curated");
        const child = writer();
        await child.wait("ready");
        child.send({
          operation: "confirm",
          options: options(fresh, "publication-fresh"),
        });
        assert.equal((await child.wait("result")).ok, true);
        assert.deepEqual(await child.done, { code: 0, signal: null });
      }
      assert.equal(
        db.prepare("SELECT revision FROM catalog_state").get().revision,
        3,
      );
      assert.equal(
        db.prepare("SELECT source_revision FROM catalog_state").get()
          .source_revision,
        1,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM catalog_mutations").get().n,
        2,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM catalog_confirmation_results").get()
          .n,
        2,
      );
      assert.equal(
        db.prepare("SELECT alias FROM character_curated_aliases").get().alias,
        "Publication Curated",
      );
      assert.equal(
        db.prepare("SELECT reference_url FROM character_curation").get()
          .reference_url,
        "https://example.test/curated",
      );
      assert.equal(
        db
          .prepare("SELECT franchise_id FROM character_franchise_memberships")
          .get().franchise_id,
        1,
      );
      const final = cache.get();
      assert.equal(final.revision, "release:3");
      assert.equal(final.characterIndex[0].name_full, "Published");
      assert.equal(final.characterIndex[0].favourites, 200);
      assert.equal(
        findCharacters(final.characterIndex, "Publication Curated")[0].id,
        id,
      );
      assert.equal(
        findFranchises(final.franchiseIndex, "Published franchise")[0].id,
        1,
      );
      assert.equal(
        findFranchises(final.franchiseIndex, "Synthetic franchise").length,
        0,
      );
      assert.equal(cache.get(), final);
      assert.equal(edited.characterIndex[0].name_full, "Imported"); // Previously returned snapshot stays immutable.
      assert.equal(edited.franchiseIndex[0].name, "Synthetic franchise");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(
        db.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
      db.close();
      db = openCatalog(path);
      assert.deepEqual(createCatalogCache(db).get(), final);
      assert.equal(
        db.prepare("SELECT count(*) n FROM catalog_mutations").get().n,
        2,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM catalog_confirmation_results").get()
          .n,
        2,
      );
      t.diagnostic(
        JSON.stringify({
          confirmationRace: outcomes.map((row) =>
            row.ok ? "committed" : row.error,
          ),
          durableRetry: "exact",
          publicationRace: publicationRace.map((row) =>
            row.ok ? "committed" : row.error,
          ),
          revision: 3,
          mutations: 2,
          cache: final.revision,
        }),
      );
    },
  );
}
