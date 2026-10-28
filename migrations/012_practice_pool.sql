-- Main-site acceptance pool. These counters are test tickets, not physical stock.
-- Separate tables make test results incapable of becoming money or fulfillment.
CREATE TABLE practice_pools (
 id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('live','sold_out','cancelled')),
 total INTEGER NOT NULL CHECK(total BETWEEN 1 AND 10000), remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND total),
 odds_version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE practice_prizes (
 id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES practice_pools(id), name TEXT NOT NULL, image TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(quantity>0), remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND quantity),
 weight_bps INTEGER NOT NULL CHECK(weight_bps BETWEEN 0 AND 10000)
) STRICT;
CREATE TABLE practice_draws (
 id TEXT PRIMARY KEY, pool_id TEXT NOT NULL REFERENCES practice_pools(id), user_id TEXT NOT NULL REFERENCES users(id),
 prize_id TEXT NOT NULL REFERENCES practice_prizes(id), ordinal INTEGER NOT NULL, slot INTEGER,
 created_at INTEGER NOT NULL, UNIQUE(pool_id,ordinal)
) STRICT;
CREATE INDEX practice_draws_user ON practice_draws(user_id,created_at);
CREATE TRIGGER practice_draws_no_update BEFORE UPDATE ON practice_draws BEGIN SELECT RAISE(ABORT,'practice draws are append-only'); END;
CREATE TRIGGER practice_draws_no_delete BEFORE DELETE ON practice_draws BEGIN SELECT RAISE(ABORT,'practice draws are append-only'); END;
