CREATE TABLE payment_orders (
 order_no TEXT PRIMARY KEY CHECK(length(order_no) <= 20),
 user_id TEXT NOT NULL REFERENCES users(id),
 merchant_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('stage','production')),
 amount INTEGER NOT NULL CHECK(amount BETWEEN 1 AND 20000),
 points INTEGER NOT NULL CHECK(points = amount),
 status TEXT NOT NULL CHECK(status IN ('pending','paid')),
 trade_no TEXT UNIQUE,
 created_at INTEGER NOT NULL,
 paid_at INTEGER
) STRICT;
CREATE INDEX payment_orders_user ON payment_orders(user_id,created_at);
