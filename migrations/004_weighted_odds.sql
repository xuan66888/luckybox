ALTER TABLE pools ADD COLUMN draw_mode TEXT NOT NULL DEFAULT 'committed' CHECK(draw_mode IN ('committed','weighted'));
ALTER TABLE pools ADD COLUMN odds_version INTEGER NOT NULL DEFAULT 0 CHECK(odds_version>=0);
ALTER TABLE prizes ADD COLUMN weight_bps INTEGER NOT NULL DEFAULT 0 CHECK(weight_bps BETWEEN 0 AND 10000);
