import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRE_AFFECTION_CATALOG_DDL, validateFinalCatalogSchema } from '../lib/catalogFinalSchema.js';
import { upgradeFortuneCatalog } from '../lib/vaultFortuneUpgrade.js';
import { createFinalCatalog, openFinalCatalog, openFinalCatalogReadOnly } from '../lib/catalogDb.js';

test('exact pre-affection predecessor rehearses, preserves legacy event evidence, and reopens', t => {
  const dir=mkdtempSync(join(tmpdir(),'affection-upgrade-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'synthetic.sqlite'); let db=new DatabaseSync(path);
  db.exec(PRE_AFFECTION_CATALOG_DDL);
  db.exec("INSERT INTO item_expiry_schema VALUES(1,0); INSERT INTO catalog_state VALUES(1,0,0,0); INSERT INTO game_config_state VALUES(1,0); PRAGMA user_version=12;");
  db.exec("INSERT INTO character_rolls(guild_id,channel_id,command_message_id,character_id,character_name,state) VALUES('g','c','old','0','Prank','prank')");
  db.close();
  assert.throws(()=>openFinalCatalogReadOnly(path),/Affection.*writable application/i);
  db=new DatabaseSync(path);
  assert.equal(upgradeFortuneCatalog(db,{now:100}).committed,false);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='affection_schema'").get(),undefined);
  upgradeFortuneCatalog(db,{dryRun:false,now:100});
  assert.equal(validateFinalCatalogSchema(db),true);
  assert.equal(db.prepare('SELECT count(*) n FROM character_affection').get().n,0);
  assert.equal(db.prepare("SELECT source_key FROM affection_legacy_sources WHERE kind='roll'").get().source_key,'old');
  assert.equal(db.prepare('SELECT activated_at FROM affection_schema').get().activated_at,100);
  db.close(); openFinalCatalog(path).close(); openFinalCatalogReadOnly(path).close();
});

test('new-version malformed snapshots are corruption, not legacy missing evidence',t=>{
  const dir=mkdtempSync(join(tmpdir(),'affection-corrupt-')),db=createFinalCatalog(join(dir,'synthetic.sqlite'));
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const id='11111111-1111-4111-8111-111111111111';
  db.prepare('INSERT INTO character_identities(id) VALUES(?)').run(id);
  const snapshot={version:1,awards:[{userId:'u',characterId:id,base:100,bond:true,bondChance:0}]};
  db.prepare("INSERT INTO affection_contexts VALUES('new','g','u','c',?,1,?,'captured',0,NULL)").run(id,JSON.stringify(snapshot));
  assert.throws(()=>validateFinalCatalogSchema(db),/context snapshot/);
  assert.equal(db.prepare("SELECT 1 FROM affection_legacy_sources WHERE source_key='new'").get(),undefined);
});

test('fresh final creation includes constrained permanent affection state', t => {
  const dir=mkdtempSync(join(tmpdir(),'affection-fresh-'));
  const db=createFinalCatalog(join(dir,'synthetic.sqlite')); t.after(()=>{ db.close(); rmSync(dir,{recursive:true,force:true}); });
  assert.equal(db.prepare('SELECT version FROM affection_schema').get().version,1);
  assert.throws(()=>db.exec("INSERT INTO character_affection VALUES('g','u','missing',2101,0)"));
});
