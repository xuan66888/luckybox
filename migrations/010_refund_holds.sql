ALTER TABLE refunds RENAME TO refunds_before_holds;
CREATE TABLE refunds (
 id TEXT PRIMARY KEY, order_no TEXT NOT NULL REFERENCES payment_orders(order_no), user_id TEXT NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount BETWEEN 1 AND 20000), points INTEGER NOT NULL CHECK(points BETWEEN 1 AND 20000),
 status TEXT NOT NULL CHECK(status IN('requested','needs_review','processing','completed','rejected','cancelled','legacy_review')),
 version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), provider_reference TEXT UNIQUE, requested_at INTEGER NOT NULL, completed_at INTEGER,
 operator_id TEXT REFERENCES users(id), prepared_by TEXT REFERENCES users(id), prepared_at INTEGER, decision_note TEXT NOT NULL DEFAULT '',
 cash_shortfall INTEGER NOT NULL DEFAULT 0 CHECK(cash_shortfall BETWEEN 0 AND points), loss_accepted INTEGER NOT NULL DEFAULT 0 CHECK(loss_accepted>=0),
 provider_outcome TEXT NOT NULL DEFAULT '', legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN(0,1)), CHECK(legacy=1 OR amount=points)
) STRICT;
INSERT INTO refunds(id,order_no,user_id,reason,amount,points,status,provider_reference,requested_at,completed_at,operator_id,legacy)
 SELECT r.id,r.order_no,r.user_id,r.reason,o.amount,o.points,CASE WHEN r.status='requested' THEN 'legacy_review' ELSE r.status END,r.provider_reference,r.requested_at,r.completed_at,r.operator_id,1 FROM refunds_before_holds r JOIN payment_orders o ON o.order_no=r.order_no;
DROP TABLE refunds_before_holds;
CREATE UNIQUE INDEX refunds_one_open_order ON refunds(order_no) WHERE status IN('requested','needs_review','processing','legacy_review');
CREATE INDEX refunds_user_time ON refunds(user_id,requested_at);
CREATE TRIGGER refund_identity_immutable BEFORE UPDATE OF id,order_no,user_id,reason,amount,points,requested_at,legacy,cash_shortfall ON refunds BEGIN SELECT RAISE(ABORT,'refund identity is immutable'); END;
CREATE TRIGGER refund_no_delete BEFORE DELETE ON refunds BEGIN SELECT RAISE(ABORT,'refund cases cannot be deleted'); END;
CREATE TABLE wallet_holds (
 id TEXT PRIMARY KEY, refund_id TEXT NOT NULL REFERENCES refunds(id), user_id TEXT NOT NULL REFERENCES users(id),
 points INTEGER NOT NULL CHECK(points>0), source_kind TEXT NOT NULL, source_reference TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('payment','referral')), state TEXT NOT NULL CHECK(state IN('active','released','settled')), created_at INTEGER NOT NULL,
 UNIQUE(id,user_id), UNIQUE(refund_id,user_id,source_kind,source_reference),
 FOREIGN KEY(id,user_id) REFERENCES ledger(id,user_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX wallet_holds_user ON wallet_holds(user_id,state);
CREATE INDEX wallet_holds_refund ON wallet_holds(refund_id,state);
CREATE TRIGGER wallet_hold_identity_immutable BEFORE UPDATE OF id,refund_id,user_id,points,source_kind,source_reference,kind,created_at ON wallet_holds BEGIN SELECT RAISE(ABORT,'hold identity is immutable'); END;
CREATE TRIGGER wallet_hold_state_terminal BEFORE UPDATE OF state ON wallet_holds WHEN OLD.state<>'active' OR NEW.state NOT IN('released','settled') BEGIN SELECT RAISE(ABORT,'hold transition is terminal'); END;
CREATE TRIGGER wallet_holds_no_delete BEFORE DELETE ON wallet_holds BEGIN SELECT RAISE(ABORT,'holds cannot be deleted'); END;
CREATE TABLE point_releases (hold_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(hold_id,user_id) REFERENCES wallet_holds(id,user_id)) STRICT;
CREATE TRIGGER point_releases_no_update BEFORE UPDATE ON point_releases BEGIN SELECT RAISE(ABORT,'releases are append-only'); END;
CREATE TRIGGER point_releases_no_delete BEFORE DELETE ON point_releases BEGIN SELECT RAISE(ABORT,'releases are append-only'); END;
ALTER TABLE point_lots ADD COLUMN fifo_rank INTEGER;
ALTER TABLE point_lots ADD COLUMN reissue_hold_id TEXT REFERENCES wallet_holds(id);
ALTER TABLE point_lots ADD COLUMN reissue_lot_id TEXT REFERENCES point_lots(id);
CREATE UNIQUE INDEX point_lot_one_reissue ON point_lots(reissue_hold_id,reissue_lot_id) WHERE reissue_hold_id IS NOT NULL;
CREATE TRIGGER point_reissue_immutable BEFORE UPDATE OF reissue_hold_id,reissue_lot_id,fifo_rank ON point_lots BEGIN SELECT RAISE(ABORT,'reissue source is immutable'); END;
CREATE TRIGGER point_reissue_validate BEFORE INSERT ON point_lots WHEN NEW.reissue_hold_id IS NOT NULL OR NEW.reissue_lot_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM point_allocations a JOIN point_lots old ON old.id=a.lot_id JOIN wallet_holds h ON h.id=a.debit_ledger_id JOIN point_releases pr ON pr.hold_id=h.id JOIN ledger c ON c.id=NEW.credit_ledger_id
  WHERE a.debit_ledger_id=NEW.reissue_hold_id AND a.lot_id=NEW.reissue_lot_id AND a.user_id=NEW.user_id AND a.points=NEW.issued AND h.state='released'
  AND old.category=NEW.category AND old.source_kind=NEW.source_kind AND old.source_reference=NEW.source_reference AND c.kind='refund_release' AND c.reference=h.id||':'||old.id
 ) THEN RAISE(ABORT,'invalid release provenance') END;
END;
ALTER TABLE referrals ADD COLUMN qualification_minimum INTEGER;
ALTER TABLE referrals ADD COLUMN revoked_at INTEGER;
ALTER TABLE referrals ADD COLUMN reversed_refund_id TEXT REFERENCES refunds(id);
CREATE TABLE referral_recoveries (
 refund_id TEXT NOT NULL REFERENCES refunds(id), user_id TEXT NOT NULL REFERENCES users(id),
 source_reference TEXT NOT NULL, awarded INTEGER NOT NULL CHECK(awarded>=0), reserved INTEGER NOT NULL CHECK(reserved BETWEEN 0 AND awarded),
 shortfall INTEGER NOT NULL CHECK(shortfall=awarded-reserved), PRIMARY KEY(refund_id,user_id,source_reference)
) STRICT;
CREATE TRIGGER referral_recovery_no_update BEFORE UPDATE ON referral_recoveries BEGIN SELECT RAISE(ABORT,'referral recoveries are immutable'); END;
CREATE TRIGGER referral_recovery_no_delete BEFORE DELETE ON referral_recoveries BEGIN SELECT RAISE(ABORT,'referral recoveries are immutable'); END;
CREATE TABLE refund_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, refund_id TEXT NOT NULL REFERENCES refunds(id),actor_id TEXT REFERENCES users(id),event TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,version INTEGER NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
CREATE INDEX refund_events_case ON refund_events(refund_id,seq);
CREATE TRIGGER refund_events_no_update BEFORE UPDATE ON refund_events BEGIN SELECT RAISE(ABORT,'refund events are append-only'); END;
CREATE TRIGGER refund_events_no_delete BEFORE DELETE ON refund_events BEGIN SELECT RAISE(ABORT,'refund events are append-only'); END;
INSERT INTO refund_events(refund_id,actor_id,event,from_status,to_status,version,detail,created_at) SELECT id,operator_id,'legacy_import',NULL,status,0,json_object('amount',amount,'legacy',1),requested_at FROM refunds;

-- Older binaries do not register this connection function. Financial writes fail closed after an image rollback; reads remain available.
CREATE TRIGGER point_protocol_user_update BEFORE UPDATE OF points ON users BEGIN SELECT CASE WHEN luckybox_point_protocol()<2 THEN RAISE(ABORT,'point protocol upgrade required') END; END;
CREATE TRIGGER point_protocol_user_insert BEFORE INSERT ON users WHEN NEW.points<>0 BEGIN SELECT CASE WHEN luckybox_point_protocol()<2 THEN RAISE(ABORT,'point protocol upgrade required') END; END;
CREATE TRIGGER point_protocol_ledger BEFORE INSERT ON ledger BEGIN SELECT CASE WHEN luckybox_point_protocol()<2 THEN RAISE(ABORT,'point protocol upgrade required') END; END;
