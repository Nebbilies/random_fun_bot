import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { installEmptyFinalCatalog } from '../lib/catalogFinalSchema.js';
import { getConfigView, saveConfigSection } from '../lib/gameConfig.js';
import { captureAppearanceInTransaction, completeAppearanceInTransaction } from '../lib/characterAffection.js';
import { getResolvedItemDefinition, getResolvedItemDefinitions, ITEM_TIERS } from '../lib/itemRoster.js';
import { revealVaultReward, decideVaultReward, getVaultReward, bindVaultRewardMessage } from '../lib/vaultRewards.js';
import { reservePaidVaultSession, drawVaultSessionOutcome } from '../lib/vaultSessions.js';
import { getInventory, decrementItemCharge, addItemToInventory, removeItemFromInventory } from '../lib/itemStorage.js';
import { resolveMysteryConsolation, isConsolationRewardPublishable, inspectMysteryConsolation } from '../lib/mysteryConsolation.js';
import { recoverVaultRewards, onVaultInteraction } from '../lib/vaultRuntime.js';
import { activateLens, refundUnpresentedLens, getLens, armRecast, getRecast, presentRecast, inspectFortuneRuntime } from '../lib/vaultFortune.js';
import { bindVaultSessionMessage } from '../lib/vaultSessions.js';
import { flushAffectionRewardsInTransaction, recoverSelectedAffectionRewards, inspectAffectionRewards, retryOwedAffectionRewards } from '../lib/affectionRewards.js';

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  installEmptyFinalCatalog(db);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='reward_grants'").get());
  db.prepare("INSERT INTO character_identities(id,name_full,creation_method) VALUES('00000000-0000-4000-8000-000000000002','Soulmate','manual')").run();
  db.prepare("INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES('1','00000000-0000-4000-8000-000000000002','2','date')").run();
  db.prepare("INSERT INTO character_affection VALUES('1','2','00000000-0000-4000-8000-000000000002',2100,0)").run();
  db.prepare("INSERT INTO player_soulmates VALUES('1','2','00000000-0000-4000-8000-000000000002',0,43200000,1)").run();
  return db;
}

test('selected milestones acquire once and retain receipts after inventory consumption', t => {
  const db = fixture(t);
  db.prepare("INSERT INTO character_identities(id,name_full,creation_method) VALUES('00000000-0000-4000-8000-000000000001','Test','manual')").run();
  const item = getResolvedItemDefinition(db, '1', 'golden_whistle');
  db.prepare(`INSERT INTO affection_entitlements(source_key,guild_id,user_id,character_id,milestone_key,threshold,
    tier,item_id,outcome_json,reward_id,state,earned_at,channel_id) VALUES(?,?,?,?,?,?,?,?,?,'aff-test','selected',100,'20')`)
    .run('milestone-1','1','2','00000000-0000-4000-8000-000000000001','500',500,item.tier,item.id,
      JSON.stringify({ tier:item.tier,tierData:ITEM_TIERS[item.tier],item }));
  db.exec('BEGIN IMMEDIATE');
  const rewards = flushAffectionRewardsInTransaction(db, { guildId:'1',userId:'2',now:200 });
  db.exec('COMMIT');
  assert.equal(rewards.length,1);
  assert.equal(rewards[0].state,'delivered');
  assert.equal(rewards[0].vaultId.includes(':'),false);
  assert.equal(getInventory(db,'1','2',200)[0].charges,3);
  const entry = getInventory(db,'1','2',200)[0];
  for (let n=0;n<3;n++) decrementItemCharge(db,entry.id);
  recoverSelectedAffectionRewards(db,{now:300});
  assert.equal(getInventory(db,'1','2',300).length,0);
  const copy = db.prepare('SELECT * FROM reward_copies').get();
  assert.equal(copy.inventory_id,entry.id);
  assert.equal(copy.acquired_at,200);
  db.exec('PRAGMA query_only=ON');
  assert.deepEqual(inspectAffectionRewards(db).blockers,[]);
});

test('affection milestone original-card replacement preserves durable copy receipts and rejects retired inbox controls', async t => {
  const db = fixture(t);
  const now = Date.now();
  for (let n = 0; n < 5; n++) addItemToInventory(db, '1', '2', 'hourglass_of_haste', 1, { now });
  const item = getResolvedItemDefinition(db, '1', 'golden_whistle');
  db.prepare(`INSERT INTO affection_entitlements(source_key,guild_id,user_id,character_id,milestone_key,threshold,
    tier,item_id,outcome_json,reward_id,state,earned_at,channel_id) VALUES(?,?,?,?,?,?,?,?,?,'aff-card','selected',?,'20')`)
    .run('milestone-card','1','2','00000000-0000-4000-8000-000000000002','500',500,item.tier,item.id,
      JSON.stringify({ tier:item.tier,tierData:ITEM_TIERS[item.tier],item }), now);
  db.exec('BEGIN IMMEDIATE');
  flushAffectionRewardsInTransaction(db, { guildId:'1',userId:'2',now });
  db.exec('COMMIT');
  bindVaultRewardMessage(db, 'aff-card', '20', '30');
  const inventoryId = getInventory(db, '1', '2', now)[0].id;
  const replies = [];
  const interaction = { guildId:'1',user:{id:'2'},channelId:'20',message:{id:'30'},
    customId:'vault:aff-card:replace',values:[String(inventoryId)],
    isButton:()=>false,isStringSelectMenu:()=>true,
    update:async()=>{},reply:async payload=>replies.push(payload) };
  for (const customId of ['rewards:accept:aff-card', 'rewardreplace:choose']) {
    assert.equal(await onVaultInteraction(db, { ...interaction, customId }), false);
    assert.equal(getVaultReward(db, 'aff-card').state, 'overflow');
    assert.equal(db.prepare("SELECT acquired_at FROM reward_copies WHERE reward_id='aff-card'").get().acquired_at, null);
  }
  assert.equal(await onVaultInteraction(db, interaction, { now:()=>now+1 }), true);
  const settled = getVaultReward(db, 'aff-card');
  assert.equal(settled.state, 'delivered');
  assert.equal(settled.messageId, '30');
  assert.equal(settled.channelId, '20');
  assert.equal(db.prepare("SELECT acquired_at FROM reward_copies WHERE reward_id='aff-card'").get().acquired_at, now+1);
  await onVaultInteraction(db, { ...interaction, values:['accept'] }, { now:()=>now+2 });
  assert.match(JSON.stringify(replies), /stale/);
  assert.equal(getInventory(db, '1', '2', now+1).length, 5);
  assert.equal(inspectAffectionRewards(db).blockers.length, 0);
});

test('empty milestone tier remains owed; owner retry resolves fixed gifts and later the restored tier', t=>{
  const db=fixture(t);
  db.prepare('UPDATE player_soulmates SET character_id=NULL').run();
  db.exec('BEGIN IMMEDIATE');
  captureAppearanceInTransaction(db,{sourceKey:'appearance',guildId:'1',userId:'2',channelId:'20',characterId:'00000000-0000-4000-8000-000000000002',now:100});
  // Existing progress is 2100 in this fixture; use a fresh zero relationship.
  db.prepare('UPDATE character_affection SET total=0').run();
  completeAppearanceInTransaction(db,{sourceKey:'appearance',now:101,rewardRoster:[]});
  db.exec('COMMIT');
  const commons=getResolvedItemDefinitions(db,'1').filter(item=>item.tier==='common');
  const save=values=>saveConfigSection(db,{guildId:'1',section:'items',values,expectedRevision:getConfigView(db,'1').revision});
  // Defensive empty tier cannot be produced through the validated portal.
  for (const item of commons) db.prepare('INSERT INTO game_config_overrides(scope_id,key,value_json) VALUES(?,?,?)')
    .run('1',`items.${item.id}.rewardEligible`,'false');
  const first=retryOwedAffectionRewards(db,{guildId:'1',userId:'2',now:200,random:()=>0});
  assert.equal(first.owed.length,1);
  assert.equal(first.owed[0].tier,'common');
  assert.equal(getInventory(db,'1','2',200).length,2);
  save({[`items.${commons[0].id}.rewardEligible`]:true});
  assert.equal(retryOwedAffectionRewards(db,{guildId:'1',userId:'2',now:300,random:()=>0}).owed.length,0);
  assert.equal(getInventory(db,'1','2',300).length,3);
  assert.equal(inspectAffectionRewards(db).blockers.length,0);
});

test('vault Favor then Echo use captured benefits and independent copies; overflow cannot attach Recast', t=>{
  const db=fixture(t);
  for (let n=0;n<4;n++) addItemToInventory(db,'1','2','hourglass_of_haste',1,{now:100});
  const session=reservePaidVaultSession(db,{guildId:'1',userId:'2',channelId:'20',now:100});
  const outcome=drawVaultSessionOutcome(session,()=>0);
  const reward=revealVaultReward(db,{vaultId:session.vaultId,guildId:'1',userId:'2',channelId:'20',outcome,now:200,random:()=>0});
  assert.equal(reward.reward.tier,'rare');
  const child=db.prepare('SELECT reward_id FROM reward_copies WHERE ordinal=1').get();
  assert.ok(child);
  assert.equal(getVaultReward(db,child.reward_id).state,'overflow');
  assert.equal(getInventory(db,'1','2',200).length,5);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vault_sessions').get().n,1);
  bindVaultRewardMessage(db,child.reward_id,'20','30');
  const discard=getInventory(db,'1','2',200)[0];
  removeItemFromInventory(db,discard.id);
  const accepted=decideVaultReward(db,{vaultId:child.reward_id,guildId:'1',userId:'2',channelId:'20',messageId:'30',action:'accept',now:300,random:()=>{throw Error('redraw');}});
  assert.equal(accepted.reward.state,'delivered');
  assert.equal(db.prepare('SELECT acquired_at FROM reward_copies WHERE ordinal=1').get().acquired_at,300);
  assert.equal(inspectAffectionRewards(db).blockers.length,0);
});


test('missing old vault capture stays unmodified; a new lost gamble has no copies', t=>{
  const db=fixture(t);
  const old=reservePaidVaultSession(db,{guildId:'1',userId:'2',channelId:'20',now:100});
  const captured={...old.captured}; delete captured.affectionVersion;
  db.prepare('UPDATE vault_sessions SET captured_json=? WHERE vault_id=?').run(JSON.stringify(captured),old.vaultId);
  db.prepare("INSERT INTO affection_legacy_sources VALUES('vault',?,100)").run(old.vaultId);
  const oldReward=revealVaultReward(db,{vaultId:old.vaultId,guildId:'1',userId:'2',channelId:'20',outcome:drawVaultSessionOutcome(old,()=>0),now:200,random:()=>{throw Error('old perk draw');}});
  assert.equal(oldReward.reward.tier,'common');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reward_grants').get().n,0);
  const source=addItemToInventory(db,'1','2','double_or_nothing',1,{now:200}).item;
  const session=reservePaidVaultSession(db,{guildId:'1',userId:'2',channelId:'20',now:200});
  const scope={vaultId:session.vaultId,guildId:'1',userId:'2',channelId:'20',messageId:'30'};
  revealVaultReward(db,{...scope,outcome:drawVaultSessionOutcome(session,()=>0),now:201});
  let draws=0;
  assert.equal(decideVaultReward(db,{...scope,action:'gamble',now:202,random:()=>++draws===1?0:.99}).reward.state,'lost');
  assert.equal(getInventory(db,'1','2',202).find(item=>item.id===source.id).charges,1);
  assert.equal(db.prepare('SELECT state FROM reward_grants').get().state,'lost');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reward_copies').get().n,0);
  assert.equal(inspectAffectionRewards(db).blockers.length,0);
});

test('Chit parent and Echo cannot announce before the saved character reveal acknowledgement', async t=>{
  const db=fixture(t);
  addItemToInventory(db,'1','2','consolation_chit',1,{now:100});
  const session={id:1,guildId:'1',eventChannelId:'20'};
  db.exec('BEGIN IMMEDIATE');
  const decision=resolveMysteryConsolation(db,{session,winnerId:'2',canClaim:false,now:200,random:()=>0});
  db.exec('COMMIT');
  const runtime={resolved:{type:'winner',winnerId:'2'},consolation:decision};
  db.prepare(`INSERT INTO mystery_sessions(id,guild_id,origin_roll_id,event_id,character_id,rank_snapshot,roller_id,event_channel_id,
    state,state_json,started_at,deadline_at,winner_id) VALUES(1,'1',1,'doors','00000000-0000-4000-8000-000000000002',1,'2','20','resolved',?,100,200,'2')`)
    .run(JSON.stringify({runtime}));
  const childId=db.prepare('SELECT reward_id FROM reward_copies WHERE ordinal=1').get().reward_id;
  assert.equal(getVaultReward(db,decision.rewardId).reward.tier,'rare');
  assert.equal(isConsolationRewardPublishable(db,getVaultReward(db,childId)),false);
  let sends=0;
  const channel={send:async()=>{sends++;return {id:String(100+sends),edit:async()=>{}};}};
  await recoverVaultRewards(db,{channels:{fetch:async()=>channel}},{now:()=>201});
  assert.equal(sends,0);
  runtime.prizeMessageId='99'; runtime.consolationRevealAcknowledged=true;
  db.prepare('UPDATE mystery_sessions SET state_json=?').run(JSON.stringify({runtime}));
  await recoverVaultRewards(db,{channels:{fetch:async()=>channel}},{now:()=>202});
  assert.equal(sends,2);
  assert.equal(getInventory(db,'1','2',202).find(item=>item.item_id==='consolation_chit').charges,1);
  assert.equal(inspectAffectionRewards(db).blockers.length,0);
});

test('Recast evidence stays pre-Favor; newly armed Recast never attaches to either overflow copy', t=>{
  const db=fixture(t);
  const source=addItemToInventory(db,'1','2','fortunes_recast',2,{now:100}).item;
  for (let n=0;n<4;n++) addItemToInventory(db,'1','2','hourglass_of_haste',1,{now:100});
  armRecast(db,{guildId:'1',userId:'2',inventoryId:source.id,now:100});
  const session=reservePaidVaultSession(db,{guildId:'1',userId:'2',channelId:'20',now:100});
  const scope={vaultId:session.vaultId,guildId:'1',userId:'2',channelId:'20',messageId:'30'};
  assert.equal(revealVaultReward(db,{...scope,outcome:drawVaultSessionOutcome(session,()=>0),now:200,random:()=>0}).state,'recast');
  assert.equal(db.prepare('SELECT state FROM reward_grants').get().state,'captured');
  assert.equal(presentRecast(db,{...scope,now:201,random:()=>0}).status,'presented');
  assert.equal(getInventory(db,'1','2',201).find(item=>item.id===source.id).charges,2);
  const decision=getRecast(db,session.vaultId);
  db.prepare('UPDATE player_soulmates SET character_id=NULL').run();
  const final=decideVaultReward(db,{...scope,action:'recast',choice:0,now:202,random:()=>0});
  assert.equal(final.reward.state,'overflow');
  assert.equal(final.reward.reward.tier,'rare');
  const grant=db.prepare('SELECT * FROM reward_grants').get();
  assert.equal(JSON.parse(grant.pre_perk_outcome_json).item.id,decision.alternatives[0].id);
  assert.equal(inspectFortuneRuntime(db).blockers.length,0);
  armRecast(db,{guildId:'1',userId:'2',inventoryId:source.id,now:203});
  const discard=getInventory(db,'1','2',203).find(item=>item.id!==source.id);
  decideVaultReward(db,{...scope,action:'replace',inventoryId:discard.id,now:204});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM fortune_recasts').get().n,1);
  assert.equal(inspectAffectionRewards(db).blockers.length,0);
});

test('terminal perk receipts are inspected read-only and missing new capture is a blocker', t=>{
  const db=fixture(t);
  const session=reservePaidVaultSession(db,{guildId:'1',userId:'2',channelId:'20',now:100});
  revealVaultReward(db,{vaultId:session.vaultId,guildId:'1',userId:'2',channelId:'20',outcome:drawVaultSessionOutcome(session,()=>0),now:200,random:()=>0});
  db.exec('PRAGMA query_only=ON');
  assert.equal(inspectAffectionRewards(db).blockers.length,0);
  db.exec('PRAGMA query_only=OFF');
  db.prepare("UPDATE affection_decisions SET triggered=0 WHERE effect='echo'").run();
  db.exec('PRAGMA query_only=ON');
  assert.ok(inspectAffectionRewards(db).blockers.some(issue=>issue.table==='reward_grants'));
  db.exec('PRAGMA query_only=OFF');
  db.prepare('DELETE FROM reward_copies').run(); db.prepare('DELETE FROM reward_grants').run();
  assert.ok(inspectAffectionRewards(db).blockers.some(issue=>issue.detail==='Missing new-source reward capture'));
});

test('a conserved provisional Lens never manufactures a refund charge', t=>{
  const db=fixture(t);
  const source=addItemToInventory(db,'1','2','fortunes_lens',1,{now:100}).item;
  const session=reservePaidVaultSession(db,{guildId:'1',userId:'2',channelId:'20',now:100,timeoutMs:1000});
  bindVaultSessionMessage(db,session.vaultId,'30');
  activateLens(db,{vaultId:session.vaultId,guildId:'1',userId:'2',channelId:'20',messageId:'30',now:200,random:()=>0});
  assert.equal(getInventory(db,'1','2',200)[0].charges,1);
  refundUnpresentedLens(db,session.vaultId,{absent:true,now:1100});
  assert.equal(getLens(db,session.vaultId).state,'refunded');
  assert.equal(getInventory(db,'1','2',1100)[0].charges,1);
  assert.equal(db.prepare('SELECT actual_debit FROM reward_use_costs WHERE inventory_id=?').get(source.id).actual_debit,0);
});
