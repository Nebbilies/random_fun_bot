import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog, openFinalCatalog } from '../lib/catalogDb.js';
import { addItemToInventory, decrementItemCharge, removeItemFromInventory } from '../lib/itemStorage.js';
import { executeItemUseById } from '../lib/itemActivation.js';
import { createItemAction } from '../lib/itemActions.js';
import { getItemUseReceipt, spendAffectionItemChargeInTransaction } from '../lib/affectionItemUse.js';
import { reserveBinocularsUse, recoverBinocularsUses } from '../lib/binocularsUse.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'affection-use-transactions-'));const path=join(dir,'synthetic.sqlite');
  let db=createFinalCatalog(path);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return {get db(){return db;},reopen(){db.close();db=openFinalCatalog(path);}};
}
test('false/no-perk decision and last-charge invocation survive reopening',t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101','love_letter',1,{now:100}).item;
  const options={now:100,channelId:'10',commandMessageId:'no-perk',random:()=>{throw Error('zero chance drew');}};
  const result=executeItemUseById(x.db,'1','101',source.id,[],options);
  assert.equal(result.actualDebit,1);
  const decision=x.db.prepare("SELECT chance,triggered FROM affection_decisions WHERE effect='item_conservation'").get();
  assert.deepEqual({...decision},{chance:0,triggered:0});
  x.reopen();assert.deepEqual(executeItemUseById(x.db,'1','101',source.id,[],options),result);
});
test('Recast arming saves an invocation but does not check or spend conservation before presentation',t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101','fortunes_recast',1,{now:100}).item;
  const options={now:100,channelId:'10',commandMessageId:'recast'};
  const result=executeItemUseById(x.db,'1','101',source.id,[],options);
  assert.equal(result.success,true);
  assert.equal(x.db.prepare('SELECT count(*) n FROM affection_decisions').get().n,0);
  assert.equal(x.db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(source.id).charges,1);
  x.reopen();assert.deepEqual(executeItemUseById(x.db,'1','101',source.id,[],options),result);
});
test('caller transaction owns the effect, cost, and receipts rollback',t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101','love_letter',1,{now:100}).item;
  x.db.exec('BEGIN IMMEDIATE');
  const options={now:100,commandMessageId:'outer'};
  assert.equal(executeItemUseById(x.db,'1','101',source.id,[],options).success,true);
  assert.equal(x.db.isTransaction,true);x.db.exec('ROLLBACK');
  assert.equal(x.db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(source.id).charges,1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM affection_invocations').get().n,0);
  assert.equal(executeItemUseById(x.db,'1','101',source.id,[],options).success,true);
});
test('semantic spender rejects held inventory rather than bypassing authorization',t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101','severed_fate',2,{now:100}).item;
  const action=createItemAction(x.db,{guildId:'1',actorId:'101',channelId:'10',inventoryId:source.id,now:100});
  assert.equal(action.state,'confirming');
  x.db.exec('BEGIN IMMEDIATE');
  assert.throws(()=>spendAffectionItemChargeInTransaction(x.db,{sourceKey:'unauthorized',guildId:'1',userId:'101',inventoryId:source.id,chance:1,now:101,random:()=>0}),/reserved|unavailable/i);
  x.db.exec('ROLLBACK');
  assert.equal(x.db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(source.id).charges,2);
});
test('charge receipts still bind inventory and invocation kind',t=>{
  const x=fixture(t);
  const first=addItemToInventory(x.db,'1','101','love_letter',2,{now:100}).item;
  const second=addItemToInventory(x.db,'1','101','love_letter',2,{now:100}).item;
  const options={sourceKey:'bound-charge',guildId:'1',userId:'101',inventoryId:first.id,now:100};
  x.db.exec('BEGIN IMMEDIATE');
  const result=spendAffectionItemChargeInTransaction(x.db,options);
  assert.deepEqual(spendAffectionItemChargeInTransaction(x.db,options),result);
  assert.throws(()=>spendAffectionItemChargeInTransaction(x.db,{...options,inventoryId:second.id}),/scope/i);
  const invocationId=`item-charge:${JSON.stringify([options.sourceKey,'1','101',0])}`;
  assert.throws(()=>getItemUseReceipt(x.db,{invocationId,guildId:'1',userId:'101',kind:'manual_item'}),/scope/i);
  assert.equal(x.db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(first.id).charges,1);
  assert.equal(x.db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(second.id).charges,2);
  x.db.exec('COMMIT');
});
test('generic decrements and whole-entry discards remain deterministic with no perk receipt',t=>{
  const x=fixture(t);const a=addItemToInventory(x.db,'1','101','love_letter',2,{now:100}).item;
  const b=addItemToInventory(x.db,'1','101','love_letter',2,{now:100}).item;
  assert.equal(decrementItemCharge(x.db,a.id).remainingCharges,1);assert.equal(removeItemFromInventory(x.db,b.id),true);
  assert.equal(x.db.prepare('SELECT count(*) n FROM affection_decisions').get().n,0);
});
for (const damage of ['missing','debit']) test(`damaged new Binoculars ${damage} terms block recovery without releasing source`,t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101','binoculars',2,{now:100}).item;
  const id=reserveBinocularsUse(x.db,{guildId:'1',userId:'101',channelId:'10',inventoryId:source.id,sessionId:null,now:100});
  const selections=JSON.parse(x.db.prepare('SELECT selections_json FROM item_actions WHERE id=?').get(id).selections_json);
  if (damage==='missing') delete selections._affectionItemUse;
  else selections._affectionItemUse.actualDebit=0;
  x.db.prepare('UPDATE item_actions SET selections_json=? WHERE id=?').run(JSON.stringify(selections),id);
  assert.throws(()=>recoverBinocularsUses(x.db),/captured|corrupt/i);
  assert.equal(x.db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(source.id).charges,2);
  assert.equal(x.db.prepare('SELECT count(*) n FROM item_use_reservations').get().n,1);
});
test('pre-feature pending Binoculars without captured terms retains one-charge ambiguous settlement',t=>{
  const x=fixture(t);const source=addItemToInventory(x.db,'1','101','binoculars',2,{now:100}).item;
  const id=reserveBinocularsUse(x.db,{guildId:'1',userId:'101',channelId:'10',inventoryId:source.id,sessionId:null,now:100});
  x.db.prepare("UPDATE item_actions SET selections_json='{}' WHERE id=?").run(id);
  x.db.prepare('DELETE FROM affection_decisions WHERE source_key=?').run(id);
  x.db.prepare("INSERT INTO affection_legacy_sources VALUES('item_action',?,100)").run(id);
  assert.equal(recoverBinocularsUses(x.db),1);assert.equal(recoverBinocularsUses(x.db),0);
  assert.equal(x.db.prepare('SELECT charges FROM user_inventory WHERE id=?').get(source.id).charges,1);
});
