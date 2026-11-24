import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { installEmptyFinalCatalog } from '../lib/catalogFinalSchema.js';
import { installSeasonSchema } from '../lib/seasonSchema.js';
import { nextClaimReset } from '../features/rolls/rollAllowanceService.js';
import { cancelRollover, previewRollover, queueRollover, saveSeasonSettings } from '../features/seasons/seasonSchedule.js';

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
