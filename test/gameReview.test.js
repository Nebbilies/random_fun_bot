import assert from 'node:assert/strict';
import { authConfig, authenticatedFetch as fetch } from './helpers/portalAuth.js';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { openCatalog, setMeta } from '../lib/catalogDb.js';
import { getRollStatus, getClaimStatus, setMaxRolls } from '../lib/characterRolls.js';
import { getGuildRates } from '../lib/guildRates.js';
import { createReviewServer } from '../web/reviewCharacterTags.js';
import { ITEM_ROSTER } from '../lib/itemRoster.js';
import { getInventory } from '../lib/itemStorage.js';

test('review portal applies capped rolls and global claim resets with validated requests', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'game-review-'));
  const db = openCatalog(join(directory, 'catalog.sqlite'));
  setMeta(db, 'import_phase', 'complete');
  const server = createReviewServer({ db, port: 0, authConfig });
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}` ;
  const post = (path, body, headers = {}) => fetch(`${origin}/api/game/${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  assert.match(await fetch(`${origin}/`).then((response) => response.text()), /href="\/game"/);
  assert.match(await fetch(`${origin}/franchise`).then((response) => response.text()), /href="\/game"/);
  const page = await fetch(`${origin}/game`).then((response) => response.text());
  assert.match(page, /Add rolls to everyone/);
  assert.match(page, /Reset claims for everyone/);
  assert.match(page, /href="\/config"/);
  assert.doesNotMatch(page, /id="setRatesForm"/);
  assert.match(page, /id="giveItemForm"/);
  assert.match(page, /id="itemUserId"/);
  assert.match(page, /<select id="itemSelect"/);
  const itemsResponse = await fetch(`${origin}/api/game/items`);
  assert.equal(itemsResponse.status, 200);
  const items = await itemsResponse.json();
  assert.equal(items.length, ITEM_ROSTER.length);
  assert.deepEqual(items.map((item) => item.id), ITEM_ROSTER.map((item) => item.id));
  const multiCharge = ITEM_ROSTER.find((item) => item.maxCharges > 1);
  assert.ok(multiCharge);
  const grant = { guildId: '123456789012345678', userId: '987654321098765432', itemId: multiCharge.id };
  assert.equal((await post('give-item', grant, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('give-item', grant, { 'content-type': 'text/plain' })).status, 415);
  for (const invalid of [null, [], {}, { ...grant, guildId: '' }, { ...grant, userId: 123 },
    { ...grant, userId: 'abc' }, { ...grant, userId: '1'.repeat(21) }, { ...grant, itemId: 'missing' }]) {
    assert.equal((await post('give-item', invalid)).status, 400);
  }
  const malformed = await fetch(`${origin}/api/game/give-item`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.equal(getInventory(db, grant.guildId, grant.userId).length, 0);
  const granted = await post('give-item', grant);
  assert.equal(granted.status, 200);
  assert.equal((await granted.json()).item.charges, multiCharge.maxCharges);
  assert.equal(getInventory(db, grant.guildId, grant.userId)[0].item_id, multiCharge.id);
  assert.equal(getInventory(db, 'other-server', grant.userId).length, 0);
  for (let index = 1; index < 5; index++) assert.equal((await post('give-item', grant)).status, 200);
  const full = await post('give-item', grant);
  assert.equal(full.status, 409);
  assert.match((await full.json()).error, /Inventory is full/);
  assert.equal(getInventory(db, grant.guildId, grant.userId).length, 5);
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
  db.prepare('INSERT INTO daily_roll_claims(guild_id,user_id,period) VALUES (?, ?, ?)').run('1', '101', 1);
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

  // Test /api/game/rates API
  const ratesGet = await fetch(`${origin}/api/game/rates`);
  assert.equal(ratesGet.status, 200);
  const initialRates = await ratesGet.json();
  assert.deepEqual(initialRates, []);

  // Post invalid guild rates
  assert.equal((await post('rates', { guildId: 'invalid', vaultRate: 0.05 })).status, 400);
  assert.equal((await post('rates', { guildId: '12345', vaultRate: -0.1 })).status, 400);
  assert.equal((await post('rates', { guildId: '12345', vaultRate: 1.5 })).status, 400);
  assert.equal((await post('rates', { guildId: '12345', vaultRate: 0.05 }, { origin: 'http://evil.example' })).status, 403);

  // Post valid guild rates
  const saveRes = await post('rates', { guildId: '12345', vaultRate: 0.05, prankRate: 0.02 });
  assert.equal(saveRes.status, 200);
  const savedData = await saveRes.json();
  assert.equal(savedData.guildId, '12345');
  assert.equal(savedData.vaultRate, 0.05);
  assert.equal(savedData.prankRate, 0.02);

  // Verify cached / persisted rate
  assert.equal(getGuildRates(db, '12345').vaultRate, 0.05);
  assert.equal(getGuildRates(db, '12345').prankRate, 0.02);

  // Fetch rates for that specific guild
  const singleGet = await fetch(`${origin}/api/game/rates?guildId=12345`);
  assert.equal(singleGet.status, 200);
  const singleData = await singleGet.json();
  assert.equal(singleData.vaultRate, 0.05);
  assert.equal(singleData.prankRate, 0.02);

  // Fetch all rates
  const allGet = await fetch(`${origin}/api/game/rates`);
  const allList = await allGet.json();
  assert.equal(allList.length, 1);
  assert.equal(allList[0].guildId, '12345');
});
