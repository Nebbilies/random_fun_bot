import { DatabaseSync } from 'node:sqlite';
import { FORTUNE_DDL } from './vaultFortuneSchema.js';
import { CATALOG_RUNTIME_DDL } from './catalogRuntimeSchema.js';

// Authoritative final v12 DDL. Shared by empty creation, offline conversion and validation.
// Kept independent of catalogDb and the legacy migration to avoid import cycles.
export const FINAL_CATALOG_DDL = `CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE guild_prefixes (
      guild_id TEXT PRIMARY KEY, prefix TEXT NOT NULL
    );
CREATE TABLE guild_roll_limits (
      guild_id TEXT PRIMARY KEY, max_rolls INTEGER NOT NULL CHECK (max_rolls > 0)
    );
CREATE TABLE guild_game_rates (
      guild_id TEXT PRIMARY KEY,
      vault_rate REAL NOT NULL DEFAULT 0.01 CHECK (vault_rate >= 0.0 AND vault_rate <= 1.0),
      prank_rate REAL NOT NULL DEFAULT 0.01 CHECK (prank_rate >= 0.0 AND prank_rate <= 1.0),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
    );
CREATE TABLE stage_characters (
      id INTEGER PRIMARY KEY, favourites INTEGER NOT NULL, name_full TEXT,
      name_native TEXT, name_alternatives TEXT, gender TEXT, age TEXT,
      date_of_birth TEXT, description TEXT, image_url TEXT, site_url TEXT,
      anime_titles TEXT, anime_ids TEXT, anime_adult INTEGER
    );
CREATE INDEX stage_character_rank ON stage_characters (favourites ASC, id DESC);
CREATE TABLE anime (
      id INTEGER PRIMARY KEY, title_romaji TEXT, title_english TEXT, title_native TEXT,
      synonyms TEXT NOT NULL DEFAULT '[]', genres TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]', start_date TEXT, season_year INTEGER,
      format TEXT, status TEXT, average_score INTEGER, popularity INTEGER,
      is_adult INTEGER, cover_image TEXT, site_url TEXT, fetched_at TEXT NOT NULL
    );
CREATE TABLE stage_anime (
      id INTEGER PRIMARY KEY, title_romaji TEXT, title_english TEXT, title_native TEXT,
      synonyms TEXT NOT NULL DEFAULT '[]', genres TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]', start_date TEXT, season_year INTEGER,
      format TEXT, status TEXT, average_score INTEGER, popularity INTEGER,
      is_adult INTEGER, cover_image TEXT, site_url TEXT, fetched_at TEXT NOT NULL
    );
CREATE TABLE stage_character_anime (
      character_id INTEGER NOT NULL, anime_id INTEGER NOT NULL,
      PRIMARY KEY (character_id, anime_id)
    );
CREATE TABLE anime_relations (
      from_anime_id INTEGER NOT NULL, to_anime_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      PRIMARY KEY (from_anime_id, to_anime_id, relation_type)
    );
CREATE INDEX anime_relations_by_target ON anime_relations (to_anime_id, from_anime_id);
CREATE TABLE stage_anime_relations (
      from_anime_id INTEGER NOT NULL, to_anime_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      PRIMARY KEY (from_anime_id, to_anime_id, relation_type)
    );
CREATE TABLE franchises (
      id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL,
      name_source TEXT NOT NULL DEFAULT 'automatic', created_at TEXT NOT NULL
    , curated_cover_url TEXT
        CHECK (curated_cover_url IS NULL OR
          (substr(curated_cover_url, 1, 8) = 'https://' AND length(curated_cover_url) > 8
           AND curated_cover_url NOT GLOB '*[ ' || char(9) || char(10) || char(13) || ']*')), reference_url TEXT
        CHECK (reference_url IS NULL OR length(trim(reference_url)) > 0));
CREATE TABLE franchise_anime (
      franchise_id INTEGER NOT NULL, anime_id INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'automatic',
      PRIMARY KEY (franchise_id, anime_id)
    );
CREATE INDEX franchise_anime_by_anime ON franchise_anime (anime_id, franchise_id);
CREATE TABLE franchise_aliases (
      franchise_id INTEGER NOT NULL, alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'automatic',
      PRIMARY KEY (franchise_id, normalized_alias)
    );
CREATE INDEX franchise_alias_by_name ON franchise_aliases (normalized_alias);
CREATE TABLE franchise_membership_overrides (
      anime_id INTEGER PRIMARY KEY, franchise_id INTEGER,
      updated_at TEXT NOT NULL
    );
CREATE TABLE roll_allowances (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      period INTEGER NOT NULL, used INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
CREATE TABLE daily_roll_claims (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, period INTEGER NOT NULL, reset_at INTEGER,
      PRIMARY KEY (guild_id, user_id)
    );
CREATE TABLE claim_allowances (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, period INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
CREATE TABLE claim_events (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, claimed_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
CREATE TABLE guild_mystery_settings (
      guild_id TEXT PRIMARY KEY, event_channel_id TEXT NOT NULL
    );
CREATE TABLE treasure_puzzle_wins (
      guild_id TEXT NOT NULL, puzzle_id TEXT NOT NULL, won_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, puzzle_id)
    );
CREATE TABLE roll_notices (
      roll_id INTEGER NOT NULL, user_id TEXT NOT NULL,
      PRIMARY KEY (roll_id, user_id)
    );
CREATE TABLE tag_search_cache (
      query TEXT PRIMARY KEY, response TEXT NOT NULL, fetched_at TEXT NOT NULL
    );
CREATE TABLE item_actions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      channel_id TEXT NOT NULL, inventory_id INTEGER NOT NULL, state TEXT NOT NULL,
      selections_json TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, deadline_at INTEGER, message_id TEXT,
      delivery_pending INTEGER NOT NULL DEFAULT 0, crown_json TEXT
    );
CREATE TABLE item_action_costs (
      action_id TEXT NOT NULL, inventory_id INTEGER NOT NULL UNIQUE, snapshot_json TEXT NOT NULL
    );
CREATE INDEX item_actions_pending ON item_actions(state, deadline_at);
CREATE TABLE user_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      charges INTEGER NOT NULL,
      acquired_at TEXT NOT NULL
    );
CREATE INDEX user_inventory_idx ON user_inventory (guild_id, user_id);
CREATE TABLE user_inventory_limits (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      max_slots INTEGER NOT NULL, earned_slots INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
CREATE TABLE active_user_buffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      buff_id TEXT NOT NULL,
      data_json TEXT,
      expires_at INTEGER,
      remaining_rolls INTEGER
    , starts_at INTEGER);
CREATE INDEX active_user_buffs_idx ON active_user_buffs (guild_id, user_id);
CREATE TABLE guild_item_discoveries (
      guild_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (guild_id, item_id)
    );
CREATE TRIGGER user_inventory_discover_item
    AFTER INSERT ON user_inventory
    BEGIN
      INSERT INTO guild_item_discoveries (guild_id, item_id)
      VALUES (NEW.guild_id, NEW.item_id)
      ON CONFLICT(guild_id, item_id) DO NOTHING;
    END;
CREATE TABLE vault_rewards (
    vault_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL, source_message_id TEXT, message_id TEXT,
    original_json TEXT NOT NULL, reward_json TEXT, state TEXT NOT NULL,
    deadline INTEGER, gamble_inventory_id INTEGER, result TEXT,
    created_at INTEGER NOT NULL, resolved_at INTEGER, delivered_at INTEGER
  );
CREATE INDEX vault_rewards_pending ON vault_rewards(state, deadline);
CREATE TABLE game_config_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL DEFAULT 0
  );
CREATE TABLE game_config_overrides (
    scope_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
    PRIMARY KEY(scope_id, key)
  );
CREATE TRIGGER game_config_guild_roll_limits_insert
        AFTER INSERT ON guild_roll_limits BEGIN
        INSERT INTO game_config_overrides(scope_id,key,value_json)
          SELECT NEW.guild_id,'rolls.maxRolls',CAST(NEW.max_rolls AS TEXT)
          WHERE 1
          ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json;
        UPDATE game_config_state SET revision=revision+1 WHERE singleton=1;
      END;
CREATE TRIGGER game_config_guild_roll_limits_update
        AFTER UPDATE ON guild_roll_limits BEGIN
        INSERT INTO game_config_overrides(scope_id,key,value_json)
          SELECT NEW.guild_id,'rolls.maxRolls',CAST(NEW.max_rolls AS TEXT)
          WHERE 1
          ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json;
        UPDATE game_config_state SET revision=revision+1 WHERE singleton=1;
      END;
CREATE TRIGGER game_config_guild_roll_limits_delete AFTER DELETE ON guild_roll_limits BEGIN
      DELETE FROM game_config_overrides WHERE scope_id=OLD.guild_id AND key IN ('rolls.maxRolls');
      UPDATE game_config_state SET revision=revision+1 WHERE singleton=1;
    END;
CREATE TRIGGER game_config_guild_game_rates_insert
        AFTER INSERT ON guild_game_rates BEGIN
        INSERT INTO game_config_overrides(scope_id,key,value_json)
          SELECT NEW.guild_id,'vault.dropRate',CAST(NEW.vault_rate AS TEXT)
          WHERE 1
          ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json;
INSERT INTO game_config_overrides(scope_id,key,value_json)
          SELECT NEW.guild_id,'rolls.prankRate',CAST(NEW.prank_rate AS TEXT)
          WHERE 1
          ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json;
        UPDATE game_config_state SET revision=revision+1 WHERE singleton=1;
      END;
CREATE TRIGGER game_config_guild_game_rates_update
        AFTER UPDATE ON guild_game_rates BEGIN
        INSERT INTO game_config_overrides(scope_id,key,value_json)
          SELECT NEW.guild_id,'vault.dropRate',CAST(NEW.vault_rate AS TEXT)
          WHERE OLD.vault_rate IS NOT NEW.vault_rate
          ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json;
INSERT INTO game_config_overrides(scope_id,key,value_json)
          SELECT NEW.guild_id,'rolls.prankRate',CAST(NEW.prank_rate AS TEXT)
          WHERE OLD.prank_rate IS NOT NEW.prank_rate
          ON CONFLICT(scope_id,key) DO UPDATE SET value_json=excluded.value_json;
        UPDATE game_config_state SET revision=revision+1 WHERE singleton=1;
      END;
CREATE TRIGGER game_config_guild_game_rates_delete AFTER DELETE ON guild_game_rates BEGIN
      DELETE FROM game_config_overrides WHERE scope_id=OLD.guild_id AND key IN ('vault.dropRate','rolls.prankRate');
      UPDATE game_config_state SET revision=revision+1 WHERE singleton=1;
    END;
CREATE TABLE "characters" (
      id TEXT NOT NULL PRIMARY KEY REFERENCES character_identities(id) CHECK (typeof(id) = 'text' AND length(id) = 36 AND substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND length(replace(id,'-','')) = 32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(id,15,1) = '4' AND substr(id,20,1) IN ('8','9','a','b')), rank INTEGER NOT NULL UNIQUE CHECK (typeof(rank) = 'integer' AND rank BETWEEN 1 AND 9007199254740991), favourites INTEGER NOT NULL CHECK (typeof(favourites) = 'integer' AND favourites BETWEEN 0 AND 9007199254740991),
      name_full TEXT, name_native TEXT, name_alternatives TEXT, gender TEXT,
      age TEXT, date_of_birth TEXT, description TEXT, image_url TEXT,
      site_url TEXT, anime_titles TEXT, anime_ids TEXT, anime_adult INTEGER
    , likes_source TEXT NOT NULL DEFAULT 'anilist' CHECK (likes_source IN ('anilist', 'generated')), tie_order INTEGER NOT NULL CHECK (typeof(tie_order) = 'integer' AND tie_order BETWEEN 1 AND 9007199254740991));
CREATE TABLE "character_identities" (
      id TEXT NOT NULL PRIMARY KEY CHECK (typeof(id) = 'text' AND length(id) = 36 AND substr(id,9,1) = '-' AND substr(id,14,1) = '-' AND substr(id,19,1) = '-' AND substr(id,24,1) = '-' AND length(replace(id,'-','')) = 32 AND replace(id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(id,15,1) = '4' AND substr(id,20,1) IN ('8','9','a','b')), name_full TEXT, image_url TEXT
    , creation_method TEXT NOT NULL DEFAULT 'imported' CHECK (creation_method IN ('imported', 'manual')));
CREATE TABLE "character_anime" (
      character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id), anime_id INTEGER NOT NULL,
      PRIMARY KEY (character_id, anime_id)
    );
CREATE INDEX character_anime_by_anime ON character_anime (anime_id, character_id);
CREATE TABLE "marriages" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id),
      owner_id TEXT NOT NULL, married_at TEXT NOT NULL,
      UNIQUE (guild_id, character_id)
    );
CREATE INDEX marriages_by_owner
      ON marriages (guild_id, owner_id, married_at DESC);
CREATE TABLE "character_rolls" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      command_message_id TEXT NOT NULL UNIQUE, message_id TEXT UNIQUE,
      character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b') OR (character_id = '0' AND state IN ('prank','vault'))), character_name TEXT NOT NULL,
      state TEXT NOT NULL, published_at INTEGER, expires_at INTEGER, mystery_session_id INTEGER, exclusive_user_id TEXT, escape_marriage_id INTEGER, escape_owner_id TEXT, protected_until INTEGER, escape_outcome TEXT, escape_winner_id TEXT, escape_resolved_at INTEGER, rules_json TEXT, character_snapshot_json TEXT
        CHECK (character_snapshot_json IS NULL OR CASE WHEN json_valid(character_snapshot_json) THEN json_type(character_snapshot_json) = 'object' ELSE 0 END),
      UNIQUE (guild_id, channel_id, message_id)
    );
CREATE INDEX character_rolls_character
      ON character_rolls (guild_id, character_id, state);
CREATE TABLE "mystery_sessions" (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL, origin_roll_id INTEGER NOT NULL UNIQUE,
      event_id TEXT NOT NULL, character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id),
      rank_snapshot INTEGER NOT NULL, roller_id TEXT NOT NULL,
      event_channel_id TEXT NOT NULL, event_message_id TEXT,
      state TEXT NOT NULL, state_json TEXT, started_at INTEGER NOT NULL,
      next_at INTEGER, deadline_at INTEGER NOT NULL, winner_id TEXT,
      resolved_at INTEGER, outcome TEXT
    );
CREATE UNIQUE INDEX mystery_sessions_one_active_guild
      ON mystery_sessions (guild_id)
      WHERE state IN ('reserved', 'running', 'countdown', 'claim_open');
CREATE TABLE "tag_candidates" (
      character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id), tag_name TEXT NOT NULL,
      post_count INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (character_id, tag_name)
    );
CREATE TABLE "tag_match_progress" (
      character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id) PRIMARY KEY, matched_at TEXT NOT NULL
    );
CREATE TABLE "tag_decisions" (
      character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id) PRIMARY KEY, status TEXT NOT NULL,
      tag_name TEXT, source TEXT NOT NULL, updated_at TEXT NOT NULL
    );
CREATE TABLE "character_tag_reports" (
      id INTEGER PRIMARY KEY, character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id),
      reporter_id TEXT NOT NULL, reported_at TEXT NOT NULL,
      resolved_at TEXT, outcome TEXT
    );
CREATE UNIQUE INDEX open_character_tag_reporter
      ON character_tag_reports (character_id, reporter_id) WHERE resolved_at IS NULL;
CREATE TABLE "duckduckgo_tag_attempts" (
      character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
      query TEXT NOT NULL, first_url TEXT, second_url TEXT,
      outcome TEXT NOT NULL, tag_name TEXT, details TEXT NOT NULL,
      searched_at TEXT NOT NULL
    );
CREATE TABLE "character_wishes" (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, character_id)
    );
CREATE INDEX character_wishes_by_character
      ON character_wishes (guild_id, character_id);
CREATE TABLE "item_character_reservations" (
      guild_id TEXT NOT NULL, character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')), action_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, marriage_id INTEGER NOT NULL,
      PRIMARY KEY (guild_id, character_id)
    );
CREATE TABLE "counterfeit_crowns" (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id),
      marriage_id INTEGER NOT NULL, generation_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
CREATE TABLE "character_protection_locks" (
      guild_id TEXT NOT NULL,
      character_id TEXT NOT NULL CHECK (typeof(character_id) = 'text' AND length(character_id) = 36 AND substr(character_id,9,1) = '-' AND substr(character_id,14,1) = '-' AND substr(character_id,19,1) = '-' AND substr(character_id,24,1) = '-' AND length(replace(character_id,'-','')) = 32 AND replace(character_id,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(character_id,15,1) = '4' AND substr(character_id,20,1) IN ('8','9','a','b')) REFERENCES character_identities(id),
      lock_type TEXT NOT NULL,
      protected_until INTEGER,
      PRIMARY KEY (guild_id, character_id)
    );
CREATE TABLE character_sources (
      source TEXT NOT NULL CHECK (source = 'anilist'), external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 16 AND external_id NOT GLOB '*[^0-9]*' AND substr(external_id,1,1) BETWEEN '1' AND '9' AND CAST(external_id AS INTEGER) BETWEEN 1 AND 9007199254740991), character_id TEXT NOT NULL REFERENCES character_identities(id),
      PRIMARY KEY(source,external_id), UNIQUE(source,character_id));
CREATE UNIQUE INDEX character_tie_order ON characters(tie_order);
CREATE TABLE character_identity_migration (legacy_id INTEGER PRIMARY KEY, character_id TEXT NOT NULL UNIQUE REFERENCES character_identities(id));
CREATE TABLE character_curated_aliases (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        alias TEXT NOT NULL CHECK (length(trim(alias)) > 0),
        normalized_alias TEXT NOT NULL CHECK (length(trim(normalized_alias)) > 0),
        PRIMARY KEY (character_id, normalized_alias)
      ) STRICT;
CREATE INDEX character_curated_alias_by_name ON character_curated_aliases(normalized_alias);
CREATE TABLE character_curation (
        character_id TEXT PRIMARY KEY NOT NULL REFERENCES characters(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        reference_url TEXT CHECK (reference_url IS NULL OR length(trim(reference_url)) > 0)
      ) STRICT;
CREATE TABLE character_franchise_memberships (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        franchise_id INTEGER NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT ON UPDATE RESTRICT
          CHECK (typeof(franchise_id) = 'integer' AND franchise_id BETWEEN 1 AND 9007199254740991),
        PRIMARY KEY (character_id, franchise_id)
      ) STRICT;
CREATE INDEX character_franchise_memberships_by_franchise
        ON character_franchise_memberships(franchise_id, character_id);
CREATE VIEW effective_character_franchises AS
        SELECT character_id, franchise_id FROM character_franchise_memberships
        UNION
        SELECT ca.character_id, fa.franchise_id FROM character_anime AS ca
          JOIN franchise_anime AS fa ON fa.anime_id = ca.anime_id
          JOIN characters AS c ON c.id = ca.character_id
          JOIN franchises AS f ON f.id = fa.franchise_id;
CREATE TABLE catalog_state (
        singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
        source_revision INTEGER NOT NULL CHECK (typeof(source_revision) = 'integer' AND source_revision BETWEEN 0 AND 9007199254740991),
        appearance_revision INTEGER NOT NULL CHECK (typeof(appearance_revision) = 'integer' AND appearance_revision BETWEEN 0 AND 9007199254740991)
      ) STRICT;
CREATE TABLE catalog_previews (
        id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
        account TEXT NOT NULL CHECK (length(trim(account)) > 0),
        role TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
        operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
        payload_json TEXT NOT NULL CHECK (CASE WHEN json_valid(payload_json) THEN json_type(payload_json) = 'object' ELSE 0 END),
        revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
        source_revision INTEGER NOT NULL CHECK (typeof(source_revision) = 'integer' AND source_revision BETWEEN 0 AND 9007199254740991),
        appearance_revision INTEGER NOT NULL CHECK (typeof(appearance_revision) = 'integer' AND appearance_revision BETWEEN 0 AND 9007199254740991),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
        expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at BETWEEN 0 AND 9007199254740991 AND expires_at > created_at)
      ) STRICT;
CREATE TABLE catalog_mutations (
        id INTEGER PRIMARY KEY CHECK (typeof(id) = 'integer' AND id BETWEEN 1 AND 9007199254740991),
        preview_id TEXT NOT NULL UNIQUE REFERENCES catalog_previews(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        character_id TEXT REFERENCES character_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        account TEXT NOT NULL CHECK (length(trim(account)) > 0),
        role TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
        operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
        revision INTEGER NOT NULL UNIQUE CHECK (typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991),
        before_json TEXT NOT NULL CHECK (CASE WHEN json_valid(before_json) THEN json_type(before_json) = 'object' ELSE 0 END),
        after_json TEXT NOT NULL CHECK (CASE WHEN json_valid(after_json) THEN json_type(after_json) = 'object' ELSE 0 END),
        duplicate_override_reason TEXT CHECK
          (duplicate_override_reason IS NULL OR length(trim(duplicate_override_reason)) > 0),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991)
      ) STRICT;
CREATE TABLE catalog_confirmation_results (
        account TEXT NOT NULL CHECK (length(trim(account)) > 0),
        idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
        payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
        mutation_id INTEGER NOT NULL UNIQUE REFERENCES catalog_mutations(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        result_json TEXT NOT NULL CHECK (CASE WHEN json_valid(result_json) THEN json_type(result_json) = 'object' ELSE 0 END),
        created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
        PRIMARY KEY (account, idempotency_key)
      ) STRICT;
CREATE TRIGGER characters_require_source_insert BEFORE INSERT ON characters
WHEN NEW.likes_source = 'anilist' AND NOT EXISTS (SELECT 1 FROM character_sources WHERE source = 'anilist' AND character_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'AniList-managed likes require source'); END;
CREATE TRIGGER characters_require_source_update BEFORE UPDATE OF likes_source, id ON characters
WHEN NEW.likes_source = 'anilist' AND NOT EXISTS (SELECT 1 FROM character_sources WHERE source = 'anilist' AND character_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'AniList-managed likes require source'); END;
CREATE TRIGGER character_sources_preserve_likes_delete BEFORE DELETE ON character_sources
WHEN EXISTS (SELECT 1 FROM characters WHERE id = OLD.character_id AND likes_source = 'anilist')
BEGIN SELECT RAISE(ABORT, 'Freeze likes before unlinking source'); END;
CREATE TRIGGER character_sources_preserve_likes_update BEFORE UPDATE ON character_sources
WHEN (NEW.character_id != OLD.character_id OR NEW.source != OLD.source OR NEW.external_id != OLD.external_id)
AND EXISTS (SELECT 1 FROM characters WHERE id = OLD.character_id AND likes_source = 'anilist')
BEGIN SELECT RAISE(ABORT, 'Freeze likes before correcting source'); END;
${CATALOG_RUNTIME_DDL}
`;

const quote = name => '"' + name.replaceAll('"', '""') + '"';
const objects = db => db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
  WHERE sql IS NOT NULL AND substr(name, 1, 7) != 'sqlite_' ORDER BY name`).all();
let definition;
let preFortuneDefinition;
function previousDefinition() {
  if (!preFortuneDefinition) {
    const model = new DatabaseSync(':memory:');
    try { model.exec(FINAL_CATALOG_DDL.replace(FORTUNE_DDL, '')); preFortuneDefinition = objects(model); }
    finally { model.close(); }
  }
  return preFortuneDefinition;
}
const matchesDefinition = (actual, expected) => actual.length === expected.length && expected.every((row, i) =>
  row.type === actual[i].type && row.name === actual[i].name && row.sql === actual[i].sql);

/** Only the exact known pre-Fortune layout is eligible for the additive upgrade. */
export function isPreFortuneCatalogSchema(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version) === 12
    && matchesDefinition(objects(db), previousDefinition());
}

function finalDefinition() {
  if (!definition) {
    const model = new DatabaseSync(':memory:');
    try { model.exec(FINAL_CATALOG_DDL); definition = objects(model); }
    finally { model.close(); }
  }
  return definition;
}

export function installEmptyFinalCatalog(db) {
  db.exec(FINAL_CATALOG_DDL);
  db.exec(`INSERT INTO catalog_state VALUES (1,0,0,0);
    INSERT INTO game_config_state VALUES (1,0);
    INSERT INTO game_config_overrides VALUES ('','__legacy_imported','true');
    PRAGMA user_version=12;`);
}

/** Inside the offline migration's transaction, with FK enforcement temporarily off.
 * Copy through authoritative constraints, retaining every row and sequence. Unknown
 * schema objects/columns fail closed rather than being silently discarded.
 */
export function rebuildFinalCatalogSchema(db) {
  const expected = finalDefinition();
  const tables = expected.filter(row => row.type === 'table');
  const actual = objects(db);
  if (actual.some(row => !expected.some(e => e.name === row.name && e.type === row.type))) {
    throw new Error('Unsupported extra schema objects in final conversion');
  }
  const model = new DatabaseSync(':memory:');
  try {
    model.exec(FINAL_CATALOG_DDL);
    for (const { name } of tables) {
      const columns = connection => connection.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c => c.name);
      if (JSON.stringify(columns(db)) !== JSON.stringify(columns(model))) {
        throw new Error(`Unsupported column layout in ${name}`);
      }
    }
  } finally { model.close(); }
  const data = new Map(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM ${quote(name)}`).all()]));
  const sequences = db.prepare('SELECT * FROM sqlite_sequence').all();
  for (const row of actual.filter(r => ['trigger', 'view'].includes(r.type))) db.exec(`DROP ${row.type} ${quote(row.name)}`);
  for (const row of actual.filter(r => r.type === 'table')) db.exec(`DROP TABLE ${quote(row.name)}`);
  for (const row of expected.filter(r => r.type === 'table')) db.exec(row.sql);
  for (const [name, rows] of data) {
    for (const row of rows) {
      const names = Object.keys(row);
      db.prepare(`INSERT INTO ${quote(name)} (${names.map(quote).join(',')})
        VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(row));
    }
  }
  for (const row of sequences) {
    db.prepare('DELETE FROM sqlite_sequence WHERE name=?').run(row.name);
    db.prepare('INSERT INTO sqlite_sequence VALUES (?,?)').run(row.name, row.seq);
  }
  for (const row of expected.filter(r => r.type !== 'table')) db.exec(row.sql);
  db.exec('PRAGMA user_version=12');
}

/** Pure reads on the supplied connection, including in read-only mode. A version
 * marker alone (including the old partial extension v12) is never sufficient. */
export function validateFinalCatalogSchema(db, { readOnly = true, fortune = true } = {}) {
  if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 12) {
    throw new Error('Final catalog requires version 12; use explicit offline conversion of fully upgraded legacy v10');
  }
  const expected = fortune ? finalDefinition() : previousDefinition();
  const actual = objects(db);
  if (!matchesDefinition(actual, expected)) {
    if (fortune && readOnly && matchesDefinition(actual, previousDefinition())) {
      validateFinalCatalogSchema(db, { readOnly, fortune: false });
      throw new Error('Fortune schema update needed: start the writable application once, then retry read-only access.');
    }
    throw new Error('Unsupported catalog database version 12: invalid final catalog schema; authoritative v12 DDL required');
  }
  if (fortune && (db.prepare('SELECT count(*) AS n FROM fortune_schema').get().n !== 1
    || !db.prepare('SELECT 1 FROM fortune_schema WHERE version=1').get())) throw new Error('Invalid Fortune schema version; inspect the catalog before retrying startup');
  // Recheck every CHECK/UNIQUE/NOT NULL against authoritative DDL. SQLite
  // integrity_check alone is insufficient on connections with checks disabled.
  // Native integrity_check verifies stored constraints and indexes without copying
  // the database. Refuse a weakened connection rather than silently skipping CHECKs.
  if (db.prepare('PRAGMA ignore_check_constraints').get().ignore_check_constraints !== 0) {
    throw new Error('Final catalog integrity verification requires CHECK enforcement');
  }
  // Node 22.23.2's read-only connection can report "ok" for stored CHECK
  // violations. Keep independent constraint replay for that path; writable
  // startup and conversion use native integrity verification below.
  if (readOnly) {
    const verifier = new DatabaseSync(':memory:');
    try {
      verifier.exec('PRAGMA foreign_keys=OFF');
      for (const row of expected.filter(r => r.type === 'table')) verifier.exec(row.sql);
      for (const { name } of expected.filter(r => r.type === 'table')) {
        const names = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(column => column.name);
        const insert = verifier.prepare(`INSERT INTO ${quote(name)} (${names.map(quote).join(',')})
          VALUES (${names.map(() => '?').join(',')})`);
        for (const row of db.prepare(`SELECT * FROM ${quote(name)}`).iterate()) insert.run(...names.map(key => row[key]));
      }
      for (const row of expected.filter(r => r.type === 'index')) verifier.exec(row.sql);
      if (verifier.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid foreign keys');
    } catch (error) {
      throw new Error(`Invalid final catalog integrity/constraints: ${error.message}`);
    } finally { verifier.close(); }
  }
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
    || db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Invalid final catalog integrity/references');
  for (const table of ['catalog_state', 'game_config_state']) {
    if (db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n !== 1
      || !db.prepare(`SELECT 1 FROM ${table} WHERE singleton=1`).get()) throw new Error('Invalid catalog singleton state');
  }
  const references = { character_anime: 'character_id', marriages: 'character_id',
    character_rolls: 'character_id', mystery_sessions: 'character_id', tag_candidates: 'character_id',
    tag_match_progress: 'character_id', tag_decisions: 'character_id', character_tag_reports: 'character_id',
    duckduckgo_tag_attempts: 'character_id', character_wishes: 'character_id',
    item_character_reservations: 'character_id', counterfeit_crowns: 'character_id',
    character_protection_locks: 'character_id' };
  for (const [table, column] of Object.entries(references)) {
    const sentinel = table === 'character_rolls' ? "AND NOT (r.character_id='0' AND r.state IN ('prank','vault'))" : '';
    if (db.prepare(`SELECT 1 FROM ${table} r WHERE NOT EXISTS
      (SELECT 1 FROM character_identities i WHERE i.id=r.${column}) ${sentinel} LIMIT 1`).get()) {
      throw new Error(`Invalid final character reference in ${table}`);
    }
  }
  if (db.prepare(`SELECT 1 FROM characters WHERE
    typeof(favourites) != 'integer' OR favourites NOT BETWEEN 0 AND 9007199254740991
    OR typeof(rank) != 'integer' OR rank NOT BETWEEN 1 AND 9007199254740991
    OR typeof(tie_order) != 'integer' OR tie_order NOT BETWEEN 1 AND 9007199254740991
    OR tie_order IS NULL OR likes_source NOT IN ('anilist','generated') LIMIT 1`).get()) {
    throw new Error('Invalid final catalog integrity/counts');
  }
  if (db.prepare(`SELECT 1 FROM characters c WHERE likes_source='anilist' AND NOT EXISTS
    (SELECT 1 FROM character_sources s WHERE s.source='anilist' AND s.character_id=c.id) LIMIT 1`).get()) {
    throw new Error('Invalid final likes source');
  }
  if (db.prepare(`SELECT 1 FROM (SELECT rank, row_number() OVER
    (ORDER BY favourites DESC, tie_order) AS expected FROM characters) WHERE rank != expected LIMIT 1`).get()) {
    throw new Error('Invalid final rank/tie order');
  }
  return true;
}
