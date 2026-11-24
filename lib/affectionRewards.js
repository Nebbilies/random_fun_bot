import { currentSeasonRows } from './seasonSchema.js';
import { createHash } from 'node:crypto';
import { hasAffection, getAffectionBenefits, selectOwedAffectionRewardsInTransaction } from './characterAffection.js';
import { isLegacyAffectionSource } from './affectionSchema.js';
import { resolveAffectionDecisionInTransaction } from './affectionPerks.js';
import { getResolvedItemDefinitions, ITEM_TIERS } from './itemRoster.js';
import { createDirectItemRewardInTransaction, getVaultReward, getItemRewardSource } from './vaultRewards.js';
import { currentSeason, guildsAtCutoff } from '../features/seasons/seasonStore.js';

const id = (prefix, key) => `${prefix}-${createHash('sha256').update(key).digest('hex').slice(0,32)}`;
function requireTransaction(db) { if (!db.isTransaction) throw new Error('Affection reward requires caller transaction'); }
function transaction(db, work) {
  if (db.isTransaction) throw new Error('Affection reward top-level operation requires no transaction');
  db.exec('BEGIN IMMEDIATE');
  try { const result=work(); db.exec('COMMIT'); return result; }
  catch(error) { db.exec('ROLLBACK'); throw error; }
}
function draw(random) {
  const value=random();
  if (!Number.isFinite(value) || value<0 || value>=1) throw new Error('Invalid random value');
  return value;
}
export function normalizeAffectionRewardOutcome(outcome) {
  if (!outcome?.item?.id || outcome.item.tier!==outcome.tier) throw new Error('Invalid affection reward outcome');
  return { ...outcome, tierData:outcome.tierData ?? ITEM_TIERS[outcome.tier] };
}
export function getAffectionRewardGrant(db, rewardId) {
  if (!hasAffection(db)) return null;
  return db.prepare(`SELECT * FROM ${currentSeasonRows(db,'reward_grants')} WHERE parent_reward_id=?`).get(rewardId) ?? null;
}
/** Publication integrity uses the same immutable original/pre-perk/final boundary. */
export function validateAffectionRewardFinalization(db,reward) {
  const grant=getAffectionRewardGrant(db,reward.vaultId);
  if (!grant) return false;
  if (grant.state!=='finalized' || grant.guild_id!==reward.guildId || grant.user_id!==reward.userId
    || grant.original_outcome_json!==JSON.stringify(reward.original) || grant.final_outcome_json!==JSON.stringify(reward.reward)) throw new Error('Invalid reward finalization');
  const before=JSON.parse(grant.pre_perk_outcome_json), final=JSON.parse(grant.final_outcome_json);
  const benefits=JSON.parse(grant.benefits_json), decisions=JSON.parse(grant.decision_json);
  for (const [label,effect] of [['favor','fortunes_favor'],['echo','echo']]) {
    const saved=db.prepare('SELECT chance,triggered FROM affection_decisions WHERE source_key=? AND guild_id=? AND user_id=? AND effect=? AND ordinal=0')
      .get(grant.source_key,grant.guild_id,grant.user_id,effect);
    if (!saved || saved.chance!==benefits[effect] || saved.chance!==decisions[label]?.chance || Boolean(saved.triggered)!==decisions[label]?.triggered) throw new Error('Invalid reward perk receipt');
  }
  if (grant.source_type==='mystery_consolation' && JSON.stringify(before)!==grant.original_outcome_json) throw new Error('Chit pre-perk outcome changed');
  if (JSON.stringify(before)!==JSON.stringify(final)) {
    const next={common:'rare',rare:'epic',epic:'legendary'}[before.tier];
    if (!decisions.favor.triggered || final.tier!==next || !(JSON.parse(grant.pools_json)[next]??[])
      .some(item=>JSON.stringify(item)===JSON.stringify(final.item))
      || JSON.stringify({...final,tier:before.tier,tierData:before.tierData,item:before.item})!==JSON.stringify(before)) throw new Error('Invalid upgraded reward');
  }
  const copies=db.prepare('SELECT * FROM reward_copies WHERE source_key=? ORDER BY ordinal').all(grant.source_key);
  if (copies.length!==(decisions.echo.triggered?2:1) || copies.some((copy,index)=>copy.ordinal!==index || copy.outcome_json!==grant.final_outcome_json)
    || copies[0].reward_id!==reward.vaultId) throw new Error('Invalid final reward copies');
  return true;
}

/** Capture only at the validated source selection/activation, never during recovery. */
export function captureAffectionRewardInTransaction(db, { sourceKey, sourceType, rewardId, guildId, userId, outcome, pools, now }) {
  requireTransaction(db);
  if (!hasAffection(db)) return null;
  const previous=getAffectionRewardGrant(db,rewardId);
  if (previous) {
    if (previous.source_key!==sourceKey || previous.guild_id!==guildId || previous.user_id!==userId
      || previous.original_outcome_json!==JSON.stringify(outcome)) throw new Error('Reward capture scope mismatch');
    return previous;
  }
  const perks=getAffectionBenefits(db,guildId,userId).perks;
  const benefits={ fortunes_favor:perks.fortunes_favor, echo:perks.echo };
  db.prepare(`INSERT INTO reward_grants(source_key,guild_id,user_id,source_type,parent_reward_id,
    original_outcome_json,benefits_json,pools_json,captured_at,state) VALUES(?,?,?,?,?,?,?,?,?,'captured')`)
    .run(sourceKey,guildId,userId,sourceType,rewardId,JSON.stringify(outcome),JSON.stringify(benefits),JSON.stringify(pools),now);
  return getAffectionRewardGrant(db,rewardId);
}
function createCopy(db,grant,rewardId,ordinal,outcome) {
  db.prepare(`INSERT INTO reward_copies(copy_id,source_key,ordinal,reward_id,outcome_json,state)
    VALUES(?,?,?,?,?,'selected')`).run(id('copy',`${grant.source_key}:${ordinal}`),grant.source_key,ordinal,rewardId,JSON.stringify(outcome));
}
/** Existing Gamble/Recast have finished; return the frozen final parent outcome. */
export function finalizeAffectionRewardInTransaction(db,reward,outcome,now,random=Math.random) {
  requireTransaction(db);
  const grant=getAffectionRewardGrant(db,reward.vaultId);
  if (!grant) return outcome;
  if (grant.state==='lost') { if (outcome!==null) throw new Error('Lost reward cannot acquire'); return null; }
  if (grant.state==='finalized') return JSON.parse(grant.final_outcome_json);
  if (!outcome) {
    db.prepare("UPDATE reward_grants SET state='lost',finalized_at=? WHERE source_key=?").run(now,grant.source_key);
    return null;
  }
  const benefits=JSON.parse(grant.benefits_json), pools=JSON.parse(grant.pools_json);
  const favor=resolveAffectionDecisionInTransaction(db,{ sourceKey:grant.source_key,guildId:grant.guild_id,userId:grant.user_id,
    effect:'fortunes_favor',chance:benefits.fortunes_favor,now,random });
  let final=outcome;
  const next={common:'rare',rare:'epic',epic:'legendary'}[outcome.tier];
  const pool=next ? pools[next] ?? [] : [];
  if (favor.triggered && pool.length) final={...outcome,tier:next,tierData:ITEM_TIERS[next],item:pool[Math.floor(draw(random)*pool.length)]};
  const echo=resolveAffectionDecisionInTransaction(db,{sourceKey:grant.source_key,guildId:grant.guild_id,userId:grant.user_id,
    effect:'echo',chance:benefits.echo,now,random});
  db.prepare(`UPDATE reward_grants SET state='finalized',pre_perk_outcome_json=?,final_outcome_json=?,
    decision_json=?,finalized_at=? WHERE source_key=?`).run(JSON.stringify(outcome),JSON.stringify(final),JSON.stringify({favor,echo}),now,grant.source_key);
  createCopy(db,grant,reward.vaultId,0,final);
  if (echo.triggered) {
    const childId=id('echo',grant.source_key);
    createCopy(db,grant,childId,1,final);
    // The parent must acquire ordinal zero first. Child materialization follows its settlement.
  }
  return final;
}
export function deliverAffectionEchoInTransaction(db,reward,now) {
  requireTransaction(db);
  if (!hasAffection(db)) return;
  const grant=getAffectionRewardGrant(db,reward.vaultId);
  if (!grant) return;
  const copy=db.prepare('SELECT * FROM reward_copies WHERE source_key=? AND ordinal=1').get(grant.source_key);
  if (!copy || getVaultReward(db,copy.reward_id)) return;
  createDirectItemRewardInTransaction(db,{rewardId:copy.reward_id,guildId:grant.guild_id,userId:grant.user_id,channelId:reward.channelId,
    sourceKind:'affection_echo',sourceId:grant.source_key,metadata:{version:1,parentRewardId:reward.vaultId},
    outcome:JSON.parse(copy.outcome_json),now});
}
/** Durable acquisition evidence deliberately has no inventory FK. */
export function settleAffectionRewardCopyInTransaction(db,rewardId,state,item,now) {
  requireTransaction(db);
  if (!hasAffection(db)) return;
  db.prepare(`UPDATE reward_copies SET state=?,inventory_id=?,acquired_at=?,expires_at=?,settled_at=?
    WHERE reward_id=? AND state NOT IN ('delivered','declined')`)
    .run(state,item?.id ?? null,item ? now : null,item?.expires_at ?? null,['delivered','declined'].includes(state)?now:null,rewardId);
  if (state==='delivered' || state==='declined') db.prepare('UPDATE affection_entitlements SET state=? WHERE reward_id=?').run(state,rewardId);
}
export function flushAffectionRewardsInTransaction(db,{guildId,userId,now=Date.now()}) {
  requireTransaction(db);
  if (!hasAffection(db)) return [];
  const rows=db.prepare("SELECT * FROM affection_entitlements WHERE guild_id=? AND user_id=? AND state='selected' ORDER BY earned_at,threshold,source_key").all(guildId,userId);
  return rows.map(row=>{
    const outcome=normalizeAffectionRewardOutcome(JSON.parse(row.outcome_json));
    const season=currentSeason(db,guildId)?.season;
    const identity=`${guildId}:${userId}:${row.character_id}:${row.milestone_key}${season ? `:${season}` : ''}`;
    const rewardId=row.reward_id ?? id('aff',identity);
    const sourceKey=`milestone:${identity}`;
    if (!getAffectionRewardGrant(db,rewardId)) {
      db.prepare(`INSERT INTO reward_grants(source_key,guild_id,user_id,source_type,parent_reward_id,original_outcome_json,
        pre_perk_outcome_json,final_outcome_json,benefits_json,pools_json,decision_json,captured_at,finalized_at,state)
        VALUES(?,?,?,'affection_milestone',?,?,?,?,'{}','{}','{}',?,?,'finalized')`)
        .run(sourceKey,guildId,userId,rewardId,JSON.stringify(outcome),JSON.stringify(outcome),JSON.stringify(outcome),row.earned_at,now);
      createCopy(db,{source_key:sourceKey},rewardId,0,outcome);
    }
    db.prepare('UPDATE affection_entitlements SET reward_id=? WHERE guild_id=? AND user_id=? AND character_id=? AND milestone_key=?')
      .run(rewardId,guildId,userId,row.character_id,row.milestone_key);
    const existing=getVaultReward(db,rewardId);
    if (existing) {
      const source=getItemRewardSource(db,rewardId);
      if (existing.guildId!==guildId || existing.userId!==userId || source?.kind!=='affection_milestone'
        || source.id!==sourceKey || JSON.stringify(existing.original)!==JSON.stringify(outcome)) throw new Error('Milestone reward scope mismatch');
    }
    return existing ?? createDirectItemRewardInTransaction(db,{rewardId,guildId,userId,channelId:row.channel_id,
      sourceKind:'affection_milestone',sourceId:sourceKey,metadata:{version:1,characterId:row.character_id,milestoneKey:row.milestone_key},outcome,now});
  });
}
export function retryOwedAffectionRewards(db,{guildId,userId,channelId,now=Date.now(),random=Math.random}) {
  return transaction(db,()=>{
    if (!hasAffection(db)) return {owed:[],pending:[]};
    if (channelId) db.prepare(`UPDATE affection_entitlements SET channel_id=? WHERE guild_id=? AND user_id=?
      AND state IN ('owed','selected') AND NOT EXISTS(SELECT 1 FROM ${currentSeasonRows(db,'vault_rewards')} r WHERE r.vault_id=affection_entitlements.reward_id)`).run(channelId,guildId,userId);
    selectOwedAffectionRewardsInTransaction(db,{guildId,userId,rewardRoster:getResolvedItemDefinitions(db,guildId),random,now});
    flushAffectionRewardsInTransaction(db,{guildId,userId,now});
    const rows=db.prepare("SELECT * FROM affection_entitlements WHERE guild_id=? AND user_id=? AND state IN ('owed','selected')").all(guildId,userId);
    return {owed:rows.filter(row=>row.state==='owed'),pending:rows.filter(row=>row.state==='selected').map(row=>getVaultReward(db,row.reward_id))};
  });
}
export function recoverSelectedAffectionRewards(db,{now=Date.now()}={}) {
  return transaction(db,()=>{
    if (!hasAffection(db)) return [];
    return db.prepare(`SELECT DISTINCT guild_id,user_id FROM affection_entitlements WHERE state='selected'
      AND guild_id NOT IN (SELECT value FROM json_each(?))`).all(JSON.stringify(guildsAtCutoff(db,now)))
      .flatMap(row=>flushAffectionRewardsInTransaction(db,{guildId:row.guild_id,userId:row.user_id,now}));
  });
}
export function inspectAffectionRewards(db) {
  const blockers=[],recoverable=[];
  if (!hasAffection(db)) return {blockers,recoverable};
  const issue=(table,key,error)=>blockers.push({code:'invalid_affection_reward',table,id:key,detail:error.message});
  for (const grant of db.prepare(`SELECT * FROM ${currentSeasonRows(db,'reward_grants')}`).all()) try {
    const reward=getVaultReward(db,grant.parent_reward_id);
    if (!reward || reward.guildId!==grant.guild_id || reward.userId!==grant.user_id) throw new Error('Missing/scoped parent reward');
    if (grant.original_outcome_json!==JSON.stringify(reward.original)) throw new Error('Original reward mismatch');
    const benefits=JSON.parse(grant.benefits_json);
    if (grant.state==='finalized' && grant.source_type!=='affection_milestone') validateAffectionRewardFinalization(db,reward);
    if (grant.source_type!=='affection_milestone' && ['fortunes_favor','echo'].some(effect=>!Number.isFinite(benefits[effect]) || benefits[effect]<0 || benefits[effect]>1)) throw new Error('Invalid frozen reward chances');
    if (grant.state==='captured') {
      if (!['decision','recast','revealed'].includes(reward.state)) throw new Error('Unfinalized terminal reward');
      recoverable.push({kind:'reward_grant',id:grant.source_key});
    } else if (grant.state==='lost') {
      if (reward.state!=='lost' || db.prepare('SELECT 1 FROM reward_copies WHERE source_key=?').get(grant.source_key)) throw new Error('Invalid lost reward');
    } else {
      if (grant.final_outcome_json!==JSON.stringify(reward.reward)) throw new Error('Final reward mismatch');
      const copies=db.prepare('SELECT * FROM reward_copies WHERE source_key=? ORDER BY ordinal').all(grant.source_key);
      if (!copies.length || copies[0].ordinal!==0 || copies[0].reward_id!==grant.parent_reward_id) throw new Error('Missing parent copy');
      if (grant.source_type==='affection_milestone' && copies.length!==1) throw new Error('Milestone cannot have an Echo child');
    }
  } catch(error) {issue('reward_grants',grant.source_key,error);}
  for (const copy of db.prepare(`SELECT c.* FROM reward_copies c
    JOIN ${currentSeasonRows(db,'reward_grants')} g ON g.source_key=c.source_key`).all()) try {
    const reward=getVaultReward(db,copy.reward_id);
    if (!reward || copy.outcome_json!==JSON.stringify(reward.reward) || copy.state!==reward.state) throw new Error('Copy settlement mismatch');
    const grant=db.prepare(`SELECT * FROM ${currentSeasonRows(db,'reward_grants')} WHERE source_key=?`).get(copy.source_key);
    if (copy.outcome_json!==grant.final_outcome_json) throw new Error('Copy differs from final item');
    if (copy.ordinal===1 || grant.source_type==='affection_milestone') getItemRewardSource(db,copy.reward_id);
    if (copy.state==='overflow') recoverable.push({kind:'reward_copy',id:copy.reward_id});
    if (copy.state==='delivered') {
      if (!Number.isSafeInteger(copy.inventory_id) || !Number.isSafeInteger(copy.acquired_at) || !(copy.expires_at>copy.acquired_at)) throw new Error('Missing acquisition evidence');
      // Inventory may since have been consumed, expired, gifted or traded. The
      // immutable insertion receipt, not its current owner, proves acquisition.
    }
  } catch(error) {issue('reward_copies',copy.copy_id,error);}
  for (const row of db.prepare(`SELECT * FROM affection_entitlements
    WHERE guild_id NOT IN (SELECT value FROM json_each(?))`).all(JSON.stringify(guildsAtCutoff(db)))) try {
    if (row.state==='owed') { if (row.outcome_json!==null || row.reward_id!==null) throw new Error('Selected tier debt'); continue; }
    normalizeAffectionRewardOutcome(JSON.parse(row.outcome_json));
    if (row.state==='selected' && !getVaultReward(db,row.reward_id)) recoverable.push({kind:'affection_entitlement',id:row.source_key});
    else {
      const copy=db.prepare('SELECT * FROM reward_copies WHERE reward_id=?').get(row.reward_id);
      if (!copy || (row.state==='selected'?copy.state!=='overflow':copy.state!==row.state)
        || copy.outcome_json!==JSON.stringify(normalizeAffectionRewardOutcome(JSON.parse(row.outcome_json)))) throw new Error('Entitlement settlement mismatch');
      const reward=getVaultReward(db,row.reward_id);
      if (!reward || reward.guildId!==row.guild_id || reward.userId!==row.user_id) throw new Error('Entitlement delivery scope mismatch');
    }
  } catch(error) {issue('affection_entitlements',row.source_key,error);}
  if (db.prepare(`SELECT 1 FROM sqlite_schema WHERE name='vault_sessions'`).get()) for (const row of db.prepare(`SELECT s.vault_id,s.captured_json FROM ${currentSeasonRows(db,'vault_sessions')} s JOIN ${currentSeasonRows(db,'vault_rewards')} r ON r.vault_id=s.vault_id`).all()) try {
    const capability=JSON.parse(row.captured_json).affectionVersion;
    if (capability===1 ? !getAffectionRewardGrant(db,row.vault_id) : !isLegacyAffectionSource(db,'vault',row.vault_id)) throw new Error('Missing new-source reward capture');
  } catch(error) {issue('reward_grants',row.vault_id,error);}
  for (const cost of db.prepare(`SELECT * FROM ${currentSeasonRows(db,'reward_use_costs')}`).all()) try {
    const decision=db.prepare(`SELECT chance,triggered FROM affection_decisions WHERE source_key=? AND guild_id=? AND user_id=? AND effect='item_conservation' AND ordinal=0`)
      .get(cost.source_key,cost.guild_id,cost.user_id);
    if (!decision || decision.chance!==cost.chance || cost.actual_debit!==(decision.triggered?0:1)) throw new Error('Invalid saved cost decision/debit');
  } catch(error) {issue('reward_use_costs',cost.source_key,error);}
  return {blockers,recoverable};
}
/** Saved at a validated logical cost seam, before its consequences. */
export function captureRewardUseCostInTransaction(db,{sourceKey,guildId,userId,inventoryId,now,random=Math.random}) {
  requireTransaction(db);
  if (!hasAffection(db)) return {actual_debit:1};
  const previous=db.prepare(`SELECT * FROM ${currentSeasonRows(db,'reward_use_costs')} WHERE source_key=?`).get(sourceKey);
  if (previous) {
    if (previous.guild_id!==guildId || previous.user_id!==userId || previous.inventory_id!==inventoryId) throw new Error('Reward cost scope mismatch');
    return previous;
  }
  const chance=getAffectionBenefits(db,guildId,userId).perks.item_conservation;
  const result=resolveAffectionDecisionInTransaction(db,{sourceKey,guildId,userId,effect:'item_conservation',chance,now,random});
  db.prepare('INSERT INTO reward_use_costs(source_key,guild_id,user_id,inventory_id,chance,actual_debit,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(sourceKey,guildId,userId,inventoryId,result.chance,result.triggered?0:1,now);
  return db.prepare(`SELECT * FROM ${currentSeasonRows(db,'reward_use_costs')} WHERE source_key=?`).get(sourceKey);
}
