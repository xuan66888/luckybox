CREATE TABLE storefront_publications (
 version INTEGER PRIMARY KEY CHECK(version>0),
 content TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 published_at INTEGER NOT NULL,
 published_by TEXT NOT NULL REFERENCES users(id)
) STRICT;
CREATE TABLE storefront_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 version INTEGER NOT NULL CHECK(version>=0),
 draft TEXT NOT NULL,
 published_version INTEGER REFERENCES storefront_publications(version),
 updated_at INTEGER NOT NULL,
 updated_by TEXT NOT NULL REFERENCES users(id)
) STRICT;
CREATE TABLE user_policy_consents (
 user_id TEXT PRIMARY KEY REFERENCES users(id),
 publication_version INTEGER NOT NULL REFERENCES storefront_publications(version),
 content_hash TEXT NOT NULL,
 accepted_at INTEGER NOT NULL
) STRICT;
CREATE TABLE oauth_policy_intents (
 state_hash TEXT PRIMARY KEY REFERENCES oauth_states(state_hash) ON DELETE CASCADE,
 publication_version INTEGER NOT NULL REFERENCES storefront_publications(version),
 content_hash TEXT NOT NULL
) STRICT;
CREATE TRIGGER storefront_publications_no_update BEFORE UPDATE ON storefront_publications BEGIN SELECT RAISE(ABORT,'publication is append-only'); END;
CREATE TRIGGER storefront_publications_no_delete BEFORE DELETE ON storefront_publications BEGIN SELECT RAISE(ABORT,'publication is append-only'); END;
CREATE TRIGGER user_policy_consents_no_update BEFORE UPDATE ON user_policy_consents BEGIN SELECT RAISE(ABORT,'consent is append-only'); END;
CREATE TRIGGER user_policy_consents_no_delete BEFORE DELETE ON user_policy_consents BEGIN SELECT RAISE(ABORT,'consent is append-only'); END;
