CREATE TABLE point_accounting_state (id INTEGER PRIMARY KEY CHECK(id=1), legacy_ledger_rowid INTEGER NOT NULL) STRICT;
INSERT INTO point_accounting_state SELECT 1,COALESCE(MAX(rowid),0) FROM ledger;
CREATE TRIGGER point_accounting_state_no_update BEFORE UPDATE ON point_accounting_state BEGIN SELECT RAISE(ABORT,'accounting boundary is immutable'); END;
CREATE TRIGGER point_accounting_state_no_delete BEFORE DELETE ON point_accounting_state BEGIN SELECT RAISE(ABORT,'accounting boundary is immutable'); END;
CREATE UNIQUE INDEX ledger_identity_user ON ledger(id,user_id);
CREATE TABLE point_lots (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), credit_ledger_id TEXT UNIQUE,
 category TEXT NOT NULL CHECK(category IN('paid','reward','adjustment','stage','legacy','other')),
 source_kind TEXT NOT NULL, source_reference TEXT NOT NULL,
 issued INTEGER NOT NULL CHECK(issued BETWEEN 1 AND 1000000000),
 remaining INTEGER NOT NULL CHECK(remaining BETWEEN 0 AND issued), created_at INTEGER NOT NULL,
 CHECK(credit_ledger_id IS NOT NULL OR category='legacy'),
 UNIQUE(id,user_id), FOREIGN KEY(credit_ledger_id,user_id) REFERENCES ledger(id,user_id)
) STRICT;
CREATE INDEX point_lots_fifo ON point_lots(user_id,created_at,id) WHERE remaining>0;
CREATE INDEX point_lots_source ON point_lots(user_id,source_kind,source_reference);
CREATE TABLE point_allocations (
 debit_ledger_id TEXT NOT NULL, lot_id TEXT NOT NULL, user_id TEXT NOT NULL,
 points INTEGER NOT NULL CHECK(points>0), PRIMARY KEY(debit_ledger_id,lot_id),
 FOREIGN KEY(debit_ledger_id,user_id) REFERENCES ledger(id,user_id), FOREIGN KEY(lot_id,user_id) REFERENCES point_lots(id,user_id)
) STRICT;
CREATE INDEX point_allocations_lot ON point_allocations(lot_id);
CREATE TRIGGER point_lot_identity_immutable BEFORE UPDATE OF id,user_id,credit_ledger_id,category,source_kind,source_reference,issued,created_at ON point_lots BEGIN SELECT RAISE(ABORT,'point lot identity is immutable'); END;
CREATE TRIGGER point_lot_remaining_monotonic BEFORE UPDATE OF remaining ON point_lots WHEN NEW.remaining>OLD.remaining BEGIN SELECT RAISE(ABORT,'point lots cannot be refilled'); END;
CREATE TRIGGER point_lot_no_delete BEFORE DELETE ON point_lots BEGIN SELECT RAISE(ABORT,'point lots cannot be deleted'); END;
CREATE TRIGGER point_allocations_no_update BEFORE UPDATE ON point_allocations BEGIN SELECT RAISE(ABORT,'point allocations are append-only'); END;
CREATE TRIGGER point_allocations_no_delete BEFORE DELETE ON point_allocations BEGIN SELECT RAISE(ABORT,'point allocations are append-only'); END;
CREATE TRIGGER point_allocations_negative_only BEFORE INSERT ON point_allocations BEGIN
 SELECT CASE WHEN COALESCE((SELECT delta FROM ledger WHERE id=NEW.debit_ledger_id),0)>=0 THEN RAISE(ABORT,'allocation must debit a negative ledger') END;
 SELECT CASE WHEN NEW.points+COALESCE((SELECT SUM(points) FROM point_allocations WHERE debit_ledger_id=NEW.debit_ledger_id),0)>-(SELECT delta FROM ledger WHERE id=NEW.debit_ledger_id) THEN RAISE(ABORT,'allocation exceeds debit') END;
END;
-- Existing spendable balances are preserved, never re-labelled as paid deposits.
-- Historical receipt provenance is unknown until separately reviewed.
INSERT INTO point_lots(id,user_id,credit_ledger_id,category,source_kind,source_reference,issued,remaining,created_at)
 SELECT 'legacy:'||id,id,NULL,'legacy','legacy_opening',id,points,points,CAST(strftime('%s','now') AS INTEGER)*1000 FROM users WHERE points>0;
