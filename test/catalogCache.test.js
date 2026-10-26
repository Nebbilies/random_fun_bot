import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../lib/catalogDb.js';
import { migrateCharacterIdentities } from '../lib/characterIdentityMigration.js';
import { initializeCatalogReleaseSchema } from '../lib/catalogReleaseSchema.js';
import { createCatalogCache } from '../lib/catalogCache.js';

test('search cache observes another connection revision and reloads both models coherently',t=>{
  const dir=mkdtempSync(join(tmpdir(),'catalog-cache-')),file=join(dir,'synthetic.sqlite');
  const db=openCatalog(file); let writer;
  t.after(()=>{writer?.close();db.close();rmSync(dir,{recursive:true,force:true});});
  db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,10,'Old'); INSERT INTO character_identities SELECT id,name_full,image_url FROM characters;");
  migrateCharacterIdentities(db,{dryRun:false,targetVersion:11});initializeCatalogReleaseSchema(db);
  writer=new DatabaseSync(file); writer.exec('PRAGMA foreign_keys=ON');
  const cache=createCatalogCache(db),initial=cache.get();assert.equal(initial.characterIndex[0].name_full,'Old');
  assert.equal(cache.get(),initial);
  writer.exec("BEGIN IMMEDIATE; UPDATE characters SET name_full='New'; INSERT INTO franchises(display_name,name_source,created_at) VALUES('New franchise','manual','now'); UPDATE catalog_state SET revision=revision+1; COMMIT;");
  const next=cache.get();assert.notEqual(next,initial);assert.equal(next.characterIndex[0].name_full,'New');assert.equal(next.franchiseIndex[0].name,'New franchise');
  writer.exec("BEGIN IMMEDIATE; UPDATE characters SET name_full='Rolled back'; UPDATE catalog_state SET revision=revision+1; ROLLBACK;");
  assert.equal(cache.get(),next);
});

test('empty legacy cache supports initial bootstrap and durable publication revision',t=>{
  const db=openCatalog(':memory:');t.after(()=>db.close());const cache=createCatalogCache(db);
  assert.deepEqual(cache.get().characterIndex,[]);
  db.exec("INSERT INTO characters(id,rank,favourites,name_full) VALUES(1,1,0,'First'); INSERT INTO catalog_meta(key,value) VALUES('catalog_revision','1');");
  assert.equal(cache.get().characterIndex[0].name_full,'First');
});
