import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { catalogDrainStatus } from '../lib/catalogMaintenance.js';

// Explicit operational tool, never invoked during application startup.
const {values}=parseArgs({options:{database:{type:'string'},mode:{type:'string'}}});
if (!values.database || !['drain','resume','status'].includes(values.mode)) throw new Error('Usage: node scripts/catalogMaintenance.js --database /explicit/catalog.sqlite --mode drain|resume|status');
if (!existsSync(resolve(values.database))) throw new Error('Database must already exist');
const db=new DatabaseSync(resolve(values.database),{readOnly:values.mode==='status'});
try {
  if(values.mode!=='status') {
    db.prepare("INSERT INTO catalog_meta(key,value) VALUES('game_maintenance',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(values.mode==='drain'?'drain':'normal');
  }
  console.log(JSON.stringify(catalogDrainStatus(db),null,2));
} finally {db.close();}
