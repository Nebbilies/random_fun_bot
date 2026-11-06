CREATE TABLE affection_awards (
  source_key TEXT NOT NULL, guild_id TEXT NOT NULL CHECK(length(trim(guild_id))>0), user_id TEXT NOT NULL CHECK(length(trim(user_id))>0), character_id TEXT NOT NULL REFERENCES character_identities(id),
  base INTEGER NOT NULL CHECK(base IN (1,5,10,12,20,100)),
  amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount BETWEEN 0 AND 200),
  total INTEGER NOT NULL CHECK(typeof(total)='integer' AND total BETWEEN 0 AND 2100),
  milestones_json TEXT NOT NULL CHECK(json_valid(milestones_json) AND json_type(milestones_json)='array'),
  created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at BETWEEN 0 AND 9007199254740991), PRIMARY KEY(source_key,guild_id,user_id,character_id)
);
