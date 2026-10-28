CREATE INDEX ledger_created ON ledger(created_at);
CREATE INDEX draws_created ON draws(created_at);
CREATE INDEX users_created ON users(created_at);
CREATE INDEX payment_orders_paid ON payment_orders(paid_at) WHERE status='paid';
