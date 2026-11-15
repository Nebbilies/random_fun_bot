import test from 'node:test';
import assert from 'node:assert/strict';
import { openCatalog } from '../lib/catalogDb.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { initializeCatalogReleaseSchema } from '../lib/catalogReleaseSchema.js';
import { runRoll } from '../lib/characterRollRuntime.js';

for (const source of ['generated', 'anilist', 'corrupt']) test(`ordinary delayed delivery preserves captured ${source} terms`, async t => {
  const db=openCatalog(':memory:'); t.after(()=>db.close());
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full,gender,image_url,anime_titles)
    VALUES(1,1,1234,'Original','Female','https://example.test/original.png','["Old show"]');
    INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;`);
  migrateCharacterIdentities(db,{dryRun:false,targetVersion:11}); initializeCatalogReleaseSchema(db);
  db.prepare('UPDATE characters SET likes_source=?').run(source === 'corrupt' ? 'anilist' : source);
  const sent=[];
  const card={id:'500',react:async()=>{}};
  const message={id:'100',guildId:'1',channelId:'10',author:{id:'101'},channel:{send:async()=>card},reply:async payload=>{sent.push(payload);return card;}};
  const yoshiko={catalogDb:db,mysteryEnabled:false,imagePicker:{pick:async()=>{
    db.exec(`UPDATE characters SET rank=999,favourites=9999,name_full='Edited',likes_source='${source==='generated'?'anilist':'generated'}',image_url='https://example.test/edited.png'`);
    if(source==='corrupt') db.exec("UPDATE character_rolls SET character_snapshot_json='{}'");
    return {url:'https://example.test/original.png'};
  }}};
  if(source==='corrupt') {
    await assert.rejects(runRoll({message,yoshiko},'w',()=>0.5,{now:()=>1000}),/snapshot/);
    assert.equal(sent.length,0); return;
  }
  await runRoll({message,yoshiko},'w',()=>0.5,{now:()=>1000});
  const content=JSON.stringify(sent[0].components.map(c=>c.toJSON()));
  assert.match(content,/# Original/); assert.doesNotMatch(content,/Edited|9,999/);
  assert.match(content,/\*\*Rank:\*\* #1/);
  assert.doesNotMatch(content,/Likes|1,234|\[generated\]/);
  const stored=JSON.parse(db.prepare('SELECT character_snapshot_json FROM character_rolls').get().character_snapshot_json);
  assert.equal(stored.name_full,'Original'); assert.equal(stored.likes_source,source); assert.equal(stored.rank,1);
  assert.equal(stored.favourites,1234);
});
