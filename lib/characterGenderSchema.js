export const CHARACTER_GENDER_DDL = `
CREATE TABLE character_gender_overrides (
  character_id TEXT PRIMARY KEY REFERENCES character_identities(id),
  gender TEXT CHECK(gender IS NULL OR gender IN ('Female','Male','Non-binary')),
  source_gender TEXT
);
CREATE TABLE character_gender_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL REFERENCES character_identities(id),
  account TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','moderator')),
  action TEXT NOT NULL CHECK(action IN ('correct','dismiss','source')),
  outcome TEXT NOT NULL CHECK(outcome IN ('corrected','dismissed','source')),
  before_gender TEXT,
  after_gender TEXT,
  resolved_at INTEGER NOT NULL
);
CREATE TABLE character_gender_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL REFERENCES character_identities(id),
  reporter_id TEXT NOT NULL,
  reported_at INTEGER NOT NULL,
  review_id INTEGER REFERENCES character_gender_reviews(id)
);
CREATE UNIQUE INDEX open_character_gender_report ON character_gender_reports(character_id,reporter_id) WHERE review_id IS NULL;
CREATE INDEX character_gender_report_queue ON character_gender_reports(reported_at,id) WHERE review_id IS NULL;
`;
