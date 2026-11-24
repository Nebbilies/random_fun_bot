import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { installEmptyFinalCatalog } from '../lib/catalogFinalSchema.js';
import { installSeasonSchema } from '../lib/seasonSchema.js';
import { nextClaimReset } from '../features/rolls/rollAllowanceService.js';
import { cancelRollover, getSeasonStatus, previewRollover, queueRollover, saveSeasonSettings } from '../features/seasons/seasonSchedule.js';
import { seasonCutoffReached } from '../features/seasons/seasonStore.js';

test('an administrator previews two consecutive claim boundaries and cancels a queued rollover', t => {
  const now = 1_800_000_000_000;
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  installEmptyFinalCatalog(db);
  installSeasonSchema(db);
  db.exec("INSERT INTO roll_allowances VALUES('10','101',123,1)");
  saveSeasonSettings(db,{guildId:'10',channelId:'90',targetDays:30});
  assert.throws(() => previewRollover(db,'10',now), /verify/i);
  db.prepare("UPDATE guild_season_settings SET channel_checked_at=? WHERE guild_id='10'").run(now);
  const preview = previewRollover(db,'10',now);
  assert.deepEqual([preview.season,preview.reminderAt,preview.cutoffAt],
    [1,nextClaimReset(now,db,'10'),nextClaimReset(nextClaimReset(now,db,'10'),db,'10')]);
  const queued = queueRollover(db,{guildId:'10',requester:'admin',preview,now});
  assert.equal(queued.phase,'queued');
  assert.equal(cancelRollover(db,{guildId:'10',revision:queued.revision}).phase,'canceled');
});

test('an overdue unconfirmed reminder can be abandoned with its revision', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  installEmptyFinalCatalog(db);
  installSeasonSchema(db);
  db.exec(`INSERT INTO roll_allowances VALUES ('10','101',123,1);
    INSERT INTO season_rollovers
    (guild_id,season,revision,phase,channel_id,reminder_at,cutoff_at,requester)
    VALUES ('10',1,1,'posting','90',1,1000,'admin')`);
  const cancel = (revision,now) => cancelRollover(db,{guildId:'10',revision,abandonUnconfirmed:true,now,requester:'operator'});
  assert.throws(() => cancel(1,999), /overdue/i);
  assert.throws(() => cancel(0,1000), /overdue/i);
  assert.equal(seasonCutoffReached(db,'10',1000),true);
  assert.equal(getSeasonStatus(db,'10',1000).canAbandonReminder,true);
  db.exec("UPDATE season_rollovers SET phase='announced'");
  assert.throws(() => cancel(1,1000), /unconfirmed/i);
  db.exec("UPDATE season_rollovers SET phase='posting'");
  const canceled = cancel(1,1000);
  assert.equal(canceled.phase,'canceled');
  assert.equal(canceled.revision,2);
  assert.match(canceled.last_error,/operator/);
  assert.equal(seasonCutoffReached(db,'10',1000),false);
});
