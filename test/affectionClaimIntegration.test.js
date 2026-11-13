import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFinalCatalog } from '../lib/catalogDb.js';
import { confirmSoulmate } from '../lib/characterAffection.js';
import { reserveRoll, publishRoll, claimRoll, getClaimStatus } from '../lib/characterRolls.js';
import { addActiveBuff } from '../lib/itemStorage.js';

const start = Date.parse('2026-11-04T02:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'affection-claim-'));
  const db = createFinalCatalog(join(dir, 'synthetic.sqlite'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const soulmate = '11111111-1111-4111-8111-111111111111';
  const prize = '22222222-2222-4222-8222-222222222222';
  for (const [index, id, gender] of [[1, soulmate, 'Male'], [2, prize, 'Female']]) {
    db.prepare("INSERT INTO character_identities(id,creation_method) VALUES(?,'manual')").run(id);
    db.prepare("INSERT INTO characters(id,rank,favourites,tie_order,likes_source,name_full,gender) VALUES(?,?,0,?,'generated',?,?)").run(id,index,index,`Character ${index}`,gender);
  }
  db.prepare('INSERT INTO marriages(guild_id,character_id,owner_id,married_at) VALUES(?,?,?,?)').run('1',soulmate,'101',new Date(start).toISOString());
  db.prepare('INSERT INTO character_affection VALUES(?,?,?,?,?)').run('1','101',soulmate,300,start);
  confirmSoulmate(db,{guildId:'1',userId:'101',characterId:soulmate,now:start});
  return {db,prize};
}

test('one Claim Conservation check preserves a normal claim and its enabling Ring use together', t => {
  const {db,prize}=fixture(t);
  const firstClaimAt=start+5*60_000;
  const time=firstClaimAt+90*60_000;
  const period=Math.floor((firstClaimAt+7*3_600_000)/(3*3_600_000));
  db.prepare('INSERT INTO claim_allowances VALUES(?,?,?)').run('1','101',period);
  db.prepare('INSERT INTO claim_events VALUES(?,?,?)').run('1','101',firstClaimAt);
  const ring=addActiveBuff(db,'1','101','engagement_ring',JSON.stringify({cooldownMultiplier:0.5}),null,1);
  assert.equal(getClaimStatus(db,'1','101',time).canClaim,true);
  const r=reserveRoll(db,{guildId:'1',channelId:'10',userId:'202',commandMessageId:'100',pool:'w',now:time,random:()=>0.99});
  assert.equal(r.character.id,prize);
  publishRoll(db,r.rollId,'500',time);
  assert.equal(claimRoll(db,{guildId:'1',channelId:'10',messageId:'500',userId:'101',now:time+1,random:()=>0}).status,'married');
  assert.equal(db.prepare('SELECT remaining_rolls FROM active_user_buffs WHERE id=?').get(ring.id).remaining_rolls,1);
  assert.equal(db.prepare('SELECT claimed_at FROM claim_events WHERE user_id=?').get('101').claimed_at,firstClaimAt);
  assert.equal(db.prepare('SELECT period FROM claim_allowances WHERE user_id=?').get('101').period,period);
});

test('a nonconserved Ring-enabled marriage spends the prepared use and advances normal claim history', t => {
  const {db}=fixture(t);
  const firstClaimAt=start+5*60_000,time=firstClaimAt+90*60_000;
  const period=Math.floor((firstClaimAt+7*3_600_000)/(3*3_600_000));
  db.prepare('INSERT INTO claim_allowances VALUES(?,?,?)').run('1','101',period);
  db.prepare('INSERT INTO claim_events VALUES(?,?,?)').run('1','101',firstClaimAt);
  const ring=addActiveBuff(db,'1','101','engagement_ring',JSON.stringify({cooldownMultiplier:0.5}),null,1);
  const r=reserveRoll(db,{guildId:'1',channelId:'10',userId:'202',commandMessageId:'100',pool:'w',now:time,random:()=>0.99});
  publishRoll(db,r.rollId,'500',time);
  assert.equal(claimRoll(db,{guildId:'1',channelId:'10',messageId:'500',userId:'101',now:time+1,random:()=>0.99}).status,'married');
  assert.equal(db.prepare('SELECT * FROM active_user_buffs WHERE id=?').get(ring.id),undefined);
  assert.equal(db.prepare('SELECT claimed_at FROM claim_events WHERE user_id=?').get('101').claimed_at,time+1);
});

for (const conserved of [true, false]) test(`Ring-enabled normal claim precedes saved tokens, conserved=${conserved}`, t => {
  const { db } = fixture(t);
  const firstClaimAt = start + 5 * 60_000, time = firstClaimAt + 90 * 60_000;
  const period = Math.floor((firstClaimAt + 7 * 3_600_000) / (3 * 3_600_000));
  db.prepare('INSERT INTO claim_allowances VALUES(?,?,?)').run('1', '101', period);
  db.prepare('INSERT INTO claim_events VALUES(?,?,?)').run('1', '101', firstClaimAt);
  const ring = addActiveBuff(db, '1', '101', 'engagement_ring', JSON.stringify({ cooldownMultiplier: 0.5 }), null, 1);
  const crown = addActiveBuff(db, '1', '101', 'crown_of_the_sovereign', '{}', null, 3);
  const pinata = addActiveBuff(db, '1', '101', 'pinata_claim_token', '{}', null, 1);
  const roll = reserveRoll(db, { guildId: '1', channelId: '10', userId: '202', commandMessageId: '100', pool: 'w', now: time, random: () => .99 });
  publishRoll(db, roll.rollId, '500', time);
  const result = claimRoll(db, { guildId: '1', channelId: '10', messageId: '500', userId: '101', now: time + 1, random: () => conserved ? 0 : .99 });
  assert.equal(result.status, 'married');
  assert.equal(db.prepare('SELECT remaining_rolls FROM active_user_buffs WHERE id=?').get(crown.id).remaining_rolls, 3);
  assert.equal(db.prepare('SELECT remaining_rolls FROM active_user_buffs WHERE id=?').get(pinata.id).remaining_rolls, 1);
  assert.equal(db.prepare('SELECT remaining_rolls FROM active_user_buffs WHERE id=?').get(ring.id)?.remaining_rolls, conserved ? 1 : undefined);
  assert.equal(db.prepare('SELECT claimed_at FROM claim_events WHERE user_id=?').get('101').claimed_at, conserved ? firstClaimAt : time + 1);
});
