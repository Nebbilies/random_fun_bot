import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { reserveRoll, getMysterySession, cleanupRolls, endMysterySession } from '../lib/characterRolls.js';
import { confirmSoulmate, getAffectionTotal } from '../lib/characterAffection.js';
import { deliverReservedRoll, acknowledgeRollDelivery } from '../lib/rollDelivery.js';
import { inspectCatalogRuntimeRestart } from '../lib/catalogRuntimeRecovery.js';
import { cancelMysteryRuntime, recoverMysteryRuntime, startMysteryRoll } from '../lib/mysteryRuntime.js';
import { getGameConfig } from '../lib/gameConfig.js';

const now=Date.parse('2026-11-04T02:00:00Z');
function fixture(t,{mystery=false}={}) {
 const dir=mkdtempSync(join(tmpdir(),'affection-runtime-'));
 const db=createFinalCatalog(join(dir,'synthetic.sqlite'));
 t.after(()=>{cancelMysteryRuntime(db);db.close();rmSync(dir,{recursive:true,force:true});});
 const own='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 for(const [n,id,gender] of [[1,own,'Male'],[2,other,'Female']]){
  db.prepare("INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')").run(id);
  db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender) VALUES(?,?,0,?,'generated',?,?)").run(id,n,n,`Character ${n}`,gender);
 }
 db.prepare('INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)').run('1',own,'101',new Date(now).toISOString());
 confirmSoulmate(db,{guildId:'1',userId:'101',characterId:own,now});
 const r=reserveRoll(db,{guildId:'1',channelId:'10',userId:'101',commandMessageId:'100',pool:mystery?'w':'h',now,random:()=>0.99,
  ...(mystery?{mystery:{eventChannelId:'10',selectEvent:()=>({eventId:'doors',durationMs:30000,state:{}})},gameConfig:getGameConfig(db,'1')}:{})});
 return {db,own,other,r};
}

test('durable own-character card has no seeded claim heart and credits one saved appearance',async t=>{
 const {db,own,r}=fixture(t);
 let reactions=0,sends=0;
 let payload;
 const message={id:'500',components:[],react:async()=>{reactions++;},edit:async()=>{}};
 const channel={id:'10',guildId:'1',send:async value=>{sends++;payload=value;message.components=value.components;return message;},messages:{fetch:async()=>message}};
 const client={channels:{fetch:async()=>channel}};
 assert.equal((await deliverReservedRoll(db,client,{rollId:r.rollId,channel,now:()=>now+1})).status,'published');
 assert.equal(reactions,0);
 assert.equal(getAffectionTotal(db,'1','101',own),100);
 assert.match(JSON.stringify(payload),/No claim needed/);
 await deliverReservedRoll(db,client,{rollId:r.rollId,channel,now:()=>now+2});
 assert.equal(sends,1);
 assert.equal(reactions,0);
});

test('a terminal unclaimable mystery retains and recovers its character affection reveal',async t=>{
 const {db,own,r}=fixture(t,{mystery:true});
 assert.equal(r.status,'mystery');
 const s=getMysterySession(db,r.sessionId);
 const data=JSON.parse(s.stateJson);
 data.gameConfig=getGameConfig(db,'1');
 data.runtime={version:1,remaining:r.remaining,eventMessageId:'501',resolved:{type:'no_winner'}};
 db.prepare("UPDATE mystery_sessions SET state='running',event_message_id='501',state_json=?,next_at=? WHERE id=?").run(JSON.stringify(data),now+1000,s.id);
 assert.equal(endMysterySession(db,{sessionId:s.id,outcome:'no_winner',now:now+1000}),true);
 const pending=JSON.parse(getMysterySession(db,s.id).stateJson).runtime;
 assert.equal(pending.affectionRevealPending,true);
 cleanupRolls(db,now+10*3_600_000);
 assert.ok(db.prepare('SELECT 1 FROM character_rolls WHERE id=?').get(r.rollId));
 let sends=0;
 const channel={id:'10',guildId:'1',messages:{fetch:async()=>null},send:async payload=>{sends++;return{id:String(600+sends),edit:async()=>{},payload};}};
 const recovered=await recoverMysteryRuntime({db,client:{channels:{fetch:async()=>channel}},now:()=>now+1100,setTimer:()=>0,clearTimer:()=>{}});
 assert.equal(recovered.deferred.length,0);
 assert.equal(getAffectionTotal(db,'1','101',own),1);
 assert.equal(sends,1);
 const again=await recoverMysteryRuntime({db,client:{channels:{fetch:async()=>channel}},now:()=>now+1200,setTimer:()=>0,clearTimer:()=>{}});
 assert.equal(again.deferred.length,0);
 assert.equal(sends,1);
});

test('live delivery refuses missing new capture metadata before sending a card',async t=>{
 const {db,r}=fixture(t);
 const row=db.prepare('SELECT rules_json FROM character_rolls WHERE id=?').get(r.rollId);
 const terms=JSON.parse(row.rules_json);delete terms.affectionVersion;delete terms.affectionSourceKey;
 db.prepare('UPDATE character_rolls SET rules_json=? WHERE id=?').run(JSON.stringify(terms),r.rollId);
 let sent=0;
 await assert.rejects(()=>deliverReservedRoll(db,{channels:{fetch:async()=>({id:'10',guildId:'1',send:async()=>{sent++;return{id:'500'};}})}},{rollId:r.rollId,now:()=>now+1}),/capture binding/);
 assert.equal(sent,0);
 assert.equal(db.prepare('SELECT state FROM character_rolls WHERE id=?').get(r.rollId).state,'pending');
});

test('present but wrong-actor paid request binding blocks startup and live publication',async t=>{
 const {db,r}=fixture(t);
 db.prepare("UPDATE affection_requests SET user_id='999'").run();
 assert.equal(inspectCatalogRuntimeRestart(db).ready,false);
 await assert.rejects(()=>deliverReservedRoll(db,{channels:{fetch:async()=>assert.fail('must not send')}},{rollId:r.rollId,now:()=>now+1}),/capture binding/);
});

test('delayed publication starts milestone item lifetimes at actual inventory insertion',async t=>{
 const {db,r}=fixture(t);
 acknowledgeRollDelivery(db,r.rollId,'500',now+1);
 const later=now+7*86_400_000;
 const message={id:'500',components:[],edit:async()=>{},react:async()=>{}};
 const channel={id:'10',guildId:'1',messages:{fetch:async()=>message}};
 await deliverReservedRoll(db,{channels:{fetch:async()=>channel}},{rollId:r.rollId,channel,now:()=>later});
 const inventory=db.prepare('SELECT acquired_at,expires_at FROM user_inventory').all();
 assert.equal(inventory.length,3);
 for(const item of inventory){assert.equal(Date.parse(item.acquired_at),later);assert.ok(item.expires_at>later);}
});

test('Doors timeout acknowledgement earns affection without a second recovery reveal',async t=>{
 const {db,own,r}=fixture(t,{mystery:true});
 const sent=[],timers=[];let time=now;
 const channel={id:'10',guildId:'1',messages:{fetch:async id=>sent.find(m=>m.id===id)??null},send:async payload=>{
   const m={id:String(500+sent.length),channelId:'10',payload,edit:async()=>{},react:async()=>{}};sent.push(m);return m;}};
 const client={channels:{fetch:async()=>channel}};
 const setTimer=(fn,delay)=>{const id=timers.length+1;timers.push({id,fn,at:time+delay});return id;};
 const clearTimer=id=>{const timer=timers.find(t=>t.id===id);if(timer)timer.done=true;};
 await startMysteryRoll({db,client,message:{guildId:'1',channelId:'10',channel,author:{id:'101'}},reservation:r,
  imagePicker:null,now:()=>time,setTimer,clearTimer,random:()=>0.99});
 const advanceTo=async target=>{while(true){const next=timers.filter(x=>!x.done&&x.at<=target).sort((a,b)=>a.at-b.at)[0];if(!next)break;next.done=true;time=next.at;await next.fn();}time=target;};
 await advanceTo(now+40000);
 assert.equal(getAffectionTotal(db,'1','101',own),1);
 assert.equal(JSON.parse(getMysterySession(db,r.sessionId).stateJson).runtime.affectionRevealAcknowledged,true);
 const before=sent.length;
 cancelMysteryRuntime(db);
 await recoverMysteryRuntime({db,client,now:()=>time,setTimer,clearTimer});
 assert.equal(sent.length,before);
});

test('new paid roll missing its selection capture blocks restart rather than being treated as legacy',t=>{
 const {db,r}=fixture(t);
 assert.equal(inspectCatalogRuntimeRestart(db).ready,true);
 db.prepare('DELETE FROM affection_contexts').run();
 const report=inspectCatalogRuntimeRestart(db);
 assert.equal(report.ready,false);
 assert.ok(report.blockers.some(x=>x.code==='missing_affection_capture'));
});
