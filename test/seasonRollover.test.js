import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { installEmptyFinalCatalog } from '../lib/catalogFinalSchema.js';
import { installSeasonSchema } from '../lib/seasonSchema.js';
import { captureAppearanceInTransaction, completeAppearanceInTransaction,
  confirmSoulmate, getSoulmateState, getAffectionTotal } from '../lib/characterAffection.js';
import { getInventory } from '../lib/itemStorage.js';
import { applySeasonRollover } from '../features/seasons/seasonRollover.js';
import { pruneSeasonReceipts } from '../features/seasons/seasonPruning.js';
import { getVaultReward } from '../lib/vaultRewards.js';

const a = '12345678-1234-4123-8123-123456789abc';
const b = '12345678-1234-4123-8123-123456789abd';
const moment = Date.now()+60_000;

test('rollover archives the closing collection, keeps an eligible soulmate, and starts the guild once', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  installEmptyFinalCatalog(db);
  for (const [index, id] of [a, b].entries()) {
    db.prepare("INSERT INTO character_identities(id,creation_method,name_full) VALUES (?,'manual',?)").run(id, 'Character ' + index);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full) VALUES (?,?,0,?,'generated',?)")
      .run(id, index + 1, index + 1, 'Character ' + index);
  }
  for (const [guild, player, id] of [['10','101',a],['10','102',b],['20','201',b]]) {
    db.prepare('INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES (?,?,?,?)').run(guild,id,player,'date');
    db.prepare('INSERT INTO character_affection VALUES (?,?,?,?,?)').run(guild,player,id,1537,moment-1000);
    db.prepare('INSERT INTO player_soulmates VALUES (?,?,?,?,?,1)').run(guild,player,id,moment-2000,moment+1000);
  }
  db.prepare("INSERT INTO character_wishes VALUES ('10','101',?,?)").run(b,moment-1000);
  db.prepare(`INSERT INTO vault_rewards(vault_id,guild_id,user_id,channel_id,original_json,state,created_at)
    VALUES ('old-reward','10','101','90','{}','overflow',?)`).run(moment-1000);
  const sourceKey = 'roll:10:123';
  db.exec('BEGIN IMMEDIATE');
  captureAppearanceInTransaction(db,{sourceKey,guildId:'10',channelId:'90',userId:'101',characterId:a,now:moment-1000,random:() => 0});
  db.exec('COMMIT');
  installSeasonSchema(db);
  db.prepare(`INSERT INTO season_rollovers
    (guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester,announced_at)
    VALUES('10',0,1,'announced','90',?,?, 'admin',?)`).run(moment-1000,moment,moment-1000);

  const finish = now => applySeasonRollover(db, { guildId:'10', season:0, members:new Set(['101']), now, random:() => 0 });
  assert.equal(finish(moment-1).status, 'not-due');
  assert.equal(finish(moment).status, 'applied');
  assert.equal(finish(moment+1).status, 'already-applied');
  assert.deepEqual(db.prepare("SELECT season FROM guild_seasons WHERE guild_id='10'").get().season, 1);
  assert.equal(getSoulmateState(db,'10','101').characterId, a);
  assert.equal(getSoulmateState(db,'10','101').switchAvailableAt, 0);
  db.exec('BEGIN IMMEDIATE');
  const delayed = completeAppearanceInTransaction(db,{sourceKey,now:moment+1,random:() => 0});
  db.exec('COMMIT');
  assert.deepEqual(delayed.awards,[]);
  assert.equal(getAffectionTotal(db,'10','101',a), 153);
  assert.equal(getInventory(db,'10','101',moment).length, 1);
  assert.equal(getVaultReward(db,'old-reward'),null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM marriages WHERE guild_id='10'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM character_ownership_losses WHERE guild_id='10'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM character_wishes WHERE guild_id='10'").get().n, 0);
  assert.equal(getAffectionTotal(db,'20','201',b), 1537);
  const profiles = db.prepare('SELECT user_id, summary_json FROM season_profiles ORDER BY user_id').all()
    .map(({ user_id, summary_json }) => [user_id, JSON.parse(summary_json)]);
  assert.deepEqual(profiles.map(([player, card]) => [player, card.characterCount, card.serverRank, card.soulmate.affection]),
    [['101',1,1,1537],['102',1,null,1537]]);
  assert.ok(pruneSeasonReceipts(db,{now:moment+1}) > 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM vault_rewards WHERE vault_id='old-reward'").get().n,0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM vault_rewards WHERE guild_id='10'").get().n,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('the announced season permits one otherwise blocked soulmate switch', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  installEmptyFinalCatalog(db);
  for (const id of [a,b]) {
    db.prepare("INSERT INTO character_identities(id,creation_method,name_full) VALUES (?,'manual','Character')").run(id);
    db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES ('10',?,'101','date')").run(id);
  }
  db.prepare("INSERT INTO player_soulmates VALUES ('10','101',?,?,?,1)").run(a,moment-2000,moment+3000);
  installSeasonSchema(db);
  db.prepare(`INSERT INTO season_rollovers
    (guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester,announced_at)
    VALUES('10',0,1,'announced','90',?,?, 'admin',?)`).run(moment-1000,moment+1000,moment-1000);
  assert.equal(confirmSoulmate(db,{guildId:'10',userId:'101',characterId:b,now:moment,season:0}).status,'selected');
  assert.equal(confirmSoulmate(db,{guildId:'10',userId:'101',characterId:a,now:moment+1,season:0}).status,'cooldown');
});

test('gameplay writes stop at the cutoff for only the closing guild', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  installEmptyFinalCatalog(db);
  installSeasonSchema(db);
  db.exec("INSERT INTO roll_allowances VALUES ('10','101',123,1),('20','201',123,1)");
  assert.equal(db.prepare("SELECT season FROM guild_seasons WHERE guild_id='10'").get().season,1);
  db.exec(`INSERT INTO season_rollovers
    (guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester)
    VALUES ('10',1,1,'announced','90',1,2,'admin')`);
  assert.throws(() => db.exec("UPDATE roll_allowances SET used=2 WHERE guild_id='10'"), /next season is starting/i);
  assert.doesNotThrow(() => db.exec("UPDATE roll_allowances SET used=2 WHERE guild_id='20'"));
});
