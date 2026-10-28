CREATE TABLE starter_catalog (
 code TEXT PRIMARY KEY,
 pool_id TEXT NOT NULL UNIQUE REFERENCES pools(id),
 source_url TEXT NOT NULL,
 created_at INTEGER NOT NULL
) STRICT;
