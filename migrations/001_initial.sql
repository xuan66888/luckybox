CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player' CHECK(role IN ('player','creator','admin')),
 disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), creator_requested INTEGER NOT NULL DEFAULT 0,
 points INTEGER NOT NULL DEFAULT 0 CHECK(points BETWEEN 0 AND 1000000000), created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL) STRICT;
CREATE TABLE uploads (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), bytes INTEGER NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE pools (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, description TEXT NOT NULL,
 cover TEXT NOT NULL DEFAULT '', description_images TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','live','sold_out','rejected','cancelled','settled')),
 kind TEXT NOT NULL CHECK(kind IN ('paid','free')), price INTEGER NOT NULL CHECK(price BETWEEN 0 AND 100000),
 total INTEGER NOT NULL CHECK(total BETWEEN 1 AND 10000), remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND total),
 reserve_points INTEGER NOT NULL DEFAULT 0 CHECK(reserve_points >= 0), revenue_points INTEGER NOT NULL DEFAULT 0 CHECK(revenue_points >= 0),
 fee_bps INTEGER NOT NULL, seed TEXT, commitment TEXT, manifest TEXT, manifest_hash TEXT,
 pending_content TEXT, review_note TEXT NOT NULL DEFAULT '', verification TEXT NOT NULL DEFAULT 'none',
 fulfillment TEXT NOT NULL DEFAULT 'creator' CHECK(fulfillment IN ('creator','official')),
 service_request TEXT, created_at INTEGER NOT NULL, closed_at INTEGER
) STRICT;
CREATE INDEX pools_owner ON pools(owner_id);
CREATE TABLE prizes (
 id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES pools(id), name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('physical','points','none')), image TEXT NOT NULL DEFAULT '',
 value INTEGER NOT NULL CHECK(value BETWEEN 0 AND 1000000), redeem_points INTEGER NOT NULL CHECK(redeem_points BETWEEN 0 AND 1000000),
 quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 10000), remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND quantity)
) STRICT;
CREATE TABLE tickets (pool_id TEXT NOT NULL REFERENCES pools(id), ordinal INTEGER NOT NULL, prize_id TEXT NOT NULL REFERENCES prizes(id), PRIMARY KEY(pool_id,ordinal)) STRICT;
CREATE TABLE draws (
 id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES pools(id), user_id TEXT NOT NULL REFERENCES users(id),
 prize_id TEXT NOT NULL REFERENCES prizes(id), ordinal INTEGER NOT NULL, cost INTEGER NOT NULL, created_at INTEGER NOT NULL,
 UNIQUE(pool_id,ordinal)
) STRICT;
CREATE INDEX draws_user ON draws(user_id);
CREATE TABLE free_claims (pool_id TEXT NOT NULL REFERENCES pools(id), user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(pool_id,user_id)) STRICT;
CREATE TABLE shipments (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('requested','shipped','delivered')), carrier TEXT NOT NULL DEFAULT '', tracking TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE collection (
 id TEXT PRIMARY KEY, draw_id TEXT NOT NULL UNIQUE REFERENCES draws(id), user_id TEXT NOT NULL REFERENCES users(id),
 prize_id TEXT NOT NULL REFERENCES prizes(id), status TEXT NOT NULL CHECK(status IN ('available','redeemed','shipping','shipped','delivered')),
 shipment_id TEXT REFERENCES shipments(id)
) STRICT;
CREATE TABLE ledger (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, balance_after INTEGER NOT NULL CHECK(balance_after >= 0),
 kind TEXT NOT NULL, reference TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(user_id,kind,reference)
) STRICT;
CREATE TABLE idempotency (
 user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,key)
) STRICT;
CREATE TABLE topups (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), points INTEGER NOT NULL CHECK(points BETWEEN 1 AND 100000),
 reference TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')), created_at INTEGER NOT NULL, reviewed_by TEXT REFERENCES users(id)
) STRICT;
CREATE TABLE settlements (
 id TEXT PRIMARY KEY, pool_id TEXT NOT NULL UNIQUE REFERENCES pools(id), owner_id TEXT NOT NULL REFERENCES users(id),
 gross_points INTEGER NOT NULL, fee_points INTEGER NOT NULL, reserve_returned INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('requested','approved')), created_at INTEGER NOT NULL, reviewed_by TEXT REFERENCES users(id)
) STRICT;
CREATE TABLE audit (
 id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, target TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'ledger is append-only'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
