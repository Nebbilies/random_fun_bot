import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createFinalCatalog, openCatalog } from "../lib/catalogDb.js";

test("runtime catalog waits for a brief writer and fails after five seconds of sustained contention", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-lock-timeout-"));
  const path = join(directory, "catalog.sqlite");
  createFinalCatalog(path).close();
  const db = openCatalog(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const writer = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 200);
  `,
    { eval: true, workerData: path },
  );
  t.after(() => writer.terminate());
  const exited = once(writer, "exit");
  await once(writer, "message");
  db.exec("BEGIN IMMEDIATE; COMMIT");
  await exited;
  const blocker = new DatabaseSync(path);
  try {
    blocker.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    assert.throws(() => db.exec("BEGIN IMMEDIATE"), /database is locked/);
    assert.ok(
      performance.now() - started >= 4800,
      "runtime connection must tolerate a lock for five seconds",
    );
    assert.equal(db.isTransaction, false);
  } finally {
    if (blocker.isTransaction) blocker.exec("ROLLBACK");
    blocker.close();
  }
  db.exec("BEGIN IMMEDIATE; COMMIT");
});
