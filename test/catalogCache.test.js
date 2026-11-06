import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog, saveDecision } from '../lib/catalogDb.js';
import { convertLegacyCatalogToFinal } from '../lib/characterIdentityMigration.js';
import { createCatalogCache } from '../lib/catalogCache.js';
import { findCharacters } from '../lib/gameCharacterLookup.js';
import { findFranchises } from '../lib/franchiseLookup.js';

test('search cache observes another connection revision and reloads both models coherently',t=>{
  const dir=mkdtempSync(join(tmpdir(),'catalog-cache-')),file=join(dir,'synthetic.sqlite');
  const db=openCatalog(file); let writer;
  t.after(()=>{writer?.close();db.close();rmSync(dir,{recursive:true,force:true});});
  db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,10,'Old'); INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;");
  convertLegacyCatalogToFinal(db,{dryRun:false});
  writer=new DatabaseSync(file); writer.exec('PRAGMA foreign_keys=ON');
  const cache=createCatalogCache(db),initial=cache.get();assert.equal(initial.characterIndex[0].name_full,'Old');
  assert.equal(cache.get(),initial);
  writer.exec("BEGIN IMMEDIATE; UPDATE characters SET name_full='New'; INSERT INTO franchises(display_name,name_source,created_at) VALUES('New franchise','manual','now'); UPDATE catalog_state SET revision=revision+1; COMMIT;");
  const next=cache.get();assert.notEqual(next,initial);assert.equal(next.characterIndex[0].name_full,'New');assert.equal(next.franchiseIndex[0].name,'New franchise');
  writer.exec("BEGIN IMMEDIATE; UPDATE characters SET name_full='Rolled back'; UPDATE catalog_state SET revision=revision+1; ROLLBACK;");
  assert.equal(cache.get(),next);
  const id=writer.prepare('SELECT id FROM characters').get().id;
  saveDecision(writer,id,'approve','new_tag','automatic');
  assert.notEqual(cache.get(),next);
  assert.equal(db.prepare('SELECT revision FROM catalog_state').get().revision,2);
  writer.prepare('UPDATE catalog_state SET revision=?').run(Number.MAX_SAFE_INTEGER);
  assert.throws(()=>saveDecision(writer,id,'no_match',null,'automatic'),/overflow/);
  assert.equal(writer.prepare('SELECT tag_name FROM tag_decisions').get().tag_name,'new_tag');
});

test('cached direct-only franchises and prepared names track freshness and revision changes', t => {
  const db = openCatalog(':memory:');t.after(() => db.close());
  db.exec(`INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,1,'Old Name');
    INSERT INTO franchises(id,display_name,name_source,created_at) VALUES(1,'Direct Series','manual','now');
    CREATE TABLE IF NOT EXISTS character_franchise_memberships(character_id INTEGER,franchise_id INTEGER);
    INSERT INTO character_franchise_memberships VALUES(1,1);
    INSERT INTO catalog_meta(key,value) VALUES('published_at','one'),('franchise_source_published_at','old');`);
  const cache = createCatalogCache(db), stale = cache.get();
  assert.equal(stale.franchiseCurrent, false);
  assert.deepEqual(findFranchises(stale.directFranchiseIndex, 'direct').map(r => r.id), [1]);
  assert.deepEqual(findCharacters(stale.characterIndex, 'old name').map(r => r.id), [1]);
  db.exec("UPDATE catalog_meta SET value='one' WHERE key='franchise_source_published_at'");
  const fresh = cache.get();assert.notEqual(fresh, stale);assert.equal(fresh.franchiseCurrent, true);
  db.exec("UPDATE characters SET name_full='New Name'; INSERT INTO catalog_meta VALUES('catalog_revision','1')");
  assert.deepEqual(findCharacters(cache.get().characterIndex, 'old name'), []);
  assert.deepEqual(findCharacters(cache.get().characterIndex, 'new name').map(r => r.id), [1]);
  db.exec("DROP TABLE franchise_aliases; UPDATE catalog_meta SET value='2' WHERE key='catalog_revision'");
  assert.throws(() => cache.get(), /franchise_aliases/);
  assert.throws(() => cache.get(), /franchise_aliases/);
});

test('empty legacy cache supports initial bootstrap and durable publication revision',t=>{
  const db=openCatalog(':memory:');t.after(()=>db.close());const cache=createCatalogCache(db);
  assert.deepEqual(cache.get().characterIndex,[]);
  db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,0,'First'); INSERT INTO catalog_meta(key,value) VALUES('catalog_revision','1');");
  assert.equal(cache.get().characterIndex[0].name_full,'First');
});
