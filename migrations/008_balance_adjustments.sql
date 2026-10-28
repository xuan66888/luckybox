CREATE TABLE balance_adjustments (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), user_id TEXT NOT NULL REFERENCES users(id),
 delta INTEGER NOT NULL CHECK(delta<>0 AND delta BETWEEN -100000 AND 100000),
 balance_before INTEGER NOT NULL CHECK(balance_before BETWEEN 0 AND 1000000000),
 balance_after INTEGER NOT NULL CHECK(balance_after BETWEEN 0 AND 1000000000 AND balance_after=balance_before+delta),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 5 AND 500), reference TEXT NOT NULL, created_at INTEGER NOT NULL,
 CHECK(actor_id<>user_id)
) STRICT;
CREATE INDEX balance_adjustments_user ON balance_adjustments(user_id,created_at);
CREATE TRIGGER balance_adjustments_no_update BEFORE UPDATE ON balance_adjustments BEGIN SELECT RAISE(ABORT,'adjustments are append-only'); END;
CREATE TRIGGER balance_adjustments_no_delete BEFORE DELETE ON balance_adjustments BEGIN SELECT RAISE(ABORT,'adjustments are append-only'); END;
CREATE TABLE draw_presentations (draw_id TEXT PRIMARY KEY REFERENCES draws(id), slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 24)) STRICT;
CREATE TRIGGER draw_presentations_no_update BEFORE UPDATE ON draw_presentations BEGIN SELECT RAISE(ABORT,'presentation is append-only'); END;
CREATE TRIGGER draw_presentations_no_delete BEFORE DELETE ON draw_presentations BEGIN SELECT RAISE(ABORT,'presentation is append-only'); END;
