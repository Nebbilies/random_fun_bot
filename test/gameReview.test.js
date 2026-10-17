import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openCatalog, setMeta } from '../lib/catalogDb.js';
import { getRollStatus, getClaimStatus, setMaxRolls } from '../lib/characterRolls.js';
import { createReviewServer } from '../scripts/reviewCharacterTags.js';

test('review portal applies capped rolls and global claim resets with validated requests', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'game-review-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  setMeta(db, 'import_phase', 'complete');
  const server = createReviewServer({ db, port: 0 });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${origin}/api/game/${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  assert.match(await fetch(`${origin}/`).then((response) => response.text()), /href="\/game"/);
  assert.match(await fetch(`${origin}/franchise`).then((response) => response.text()), /href="\/game"/);
  const page = await fetch(`${origin}/game`).then((response) => response.text());
  assert.match(page, /Add rolls to everyone/);
  assert.match(page, /Reset claims for everyone/);
  const now = Date.now();
  const period = Math.floor(now / 3_600_000);
  const insert = db.prepare('INSERT INTO roll_allowances VALUES (?, ?, ?, ?)');
  insert.run('1', '101', period, 6);
  insert.run('1', '102', period, 1);
  insert.run('1', '103', period - 1, 7);
  insert.run('2', '101', period, 10);
  insert.run('3', '101', period, 7);
  setMaxRolls(db, '2', 12);
  setMaxRolls(db, '3', 3);
  const claimPeriod = Math.floor((now + 7 * 3_600_000) / (3 * 3_600_000));
  db.prepare('INSERT INTO claim_allowances VALUES (?, ?, ?)').run('1', '101', claimPeriod);
  db.prepare('INSERT INTO claim_allowances VALUES (?, ?, ?)').run('2', '102', claimPeriod);
  db.prepare('INSERT INTO daily_roll_claims VALUES (?, ?, ?)').run('1', '101', 1);
  for (const amount of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await post('add-rolls', { amount })).status, 400);
  }
  assert.equal((await post('add-rolls', { amount: 3 }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('reset-claims', {}, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('add-rolls', { amount: 3 }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('add-rolls', { amount: 3 })).status, 200);
  assert.equal(getRollStatus(db, '1', '101', now).remaining, 4);
  assert.equal(getRollStatus(db, '1', '102', now).remaining, 7);
  assert.equal(getRollStatus(db, '1', '103', now).remaining, 7);
  assert.equal(getRollStatus(db, '1', '104', now).remaining, 7);
  assert.equal(getRollStatus(db, '2', '101', now).remaining, 5);
  assert.equal(getRollStatus(db, '3', '101', now).remaining, 3);
  assert.equal(getClaimStatus(db, '1', '101', now).canClaim, false);
  assert.equal((await post('reset-claims', {})).status, 200);
  assert.equal(getClaimStatus(db, '1', '101', now).canClaim, true);
  assert.equal(getClaimStatus(db, '2', '102', now).canClaim, true);
  assert.equal(getRollStatus(db, '1', '101', now).remaining, 4);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM daily_roll_claims').get().n, 1);
  assert.equal((await post('reset-claims', {})).status, 200);
});
