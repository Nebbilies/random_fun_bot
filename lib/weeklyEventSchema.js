export const WEEKLY_EVENT_DDL = `
CREATE TABLE weekly_controls (
  guild_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, channel_id TEXT NOT NULL,
  enabled_at INTEGER NOT NULL, next_theme TEXT
) STRICT;
CREATE TABLE weekly_contests (
  id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, season INTEGER NOT NULL, theme TEXT NOT NULL,
  starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, rules TEXT NOT NULL, schedule TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','pending','settled','cancelled')),
  winner_id TEXT, prize_revoked INTEGER NOT NULL DEFAULT 0, UNIQUE(guild_id,starts_at)
) STRICT;
CREATE TABLE weekly_scores (
  contest_id INTEGER NOT NULL REFERENCES weekly_contests(id), user_id TEXT NOT NULL,
  points INTEGER NOT NULL, reached_at INTEGER NOT NULL, reached_order INTEGER NOT NULL,
  PRIMARY KEY(contest_id,user_id)
) STRICT;
CREATE TABLE weekly_outcomes (
  id INTEGER PRIMARY KEY, contest_id INTEGER NOT NULL REFERENCES weekly_contests(id), outcome_key TEXT NOT NULL,
  UNIQUE(contest_id,outcome_key)
) STRICT;
CREATE TABLE weekly_franchise_gains (
  contest_id INTEGER NOT NULL REFERENCES weekly_contests(id), user_id TEXT NOT NULL,
  franchise_id TEXT NOT NULL, character_id TEXT NOT NULL,
  PRIMARY KEY(contest_id,user_id,franchise_id,character_id)
) STRICT;
CREATE TABLE weekly_claim_checks (
  contest_id INTEGER NOT NULL REFERENCES weekly_contests(id), period INTEGER NOT NULL, attempts INTEGER NOT NULL,
  PRIMARY KEY(contest_id,period)
) STRICT;
CREATE TABLE weekly_notices (
  contest_id INTEGER NOT NULL REFERENCES weekly_contests(id), kind TEXT NOT NULL, channel_id TEXT NOT NULL,
  message_id TEXT, last_error TEXT, PRIMARY KEY(contest_id,kind)
) STRICT;
CREATE TABLE weekly_reward_charges (
  reward_id TEXT PRIMARY KEY REFERENCES vault_rewards(vault_id) ON DELETE CASCADE,
  extra INTEGER NOT NULL
) STRICT;`;

export function hasWeeklyEventSchema(db) {
  return Boolean(
    db
      ?.prepare?.(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='weekly_controls'",
      )
      .get(),
  );
}

export function installWeeklyEventSchema(db) {
  db.exec(WEEKLY_EVENT_DDL);
}
