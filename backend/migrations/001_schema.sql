CREATE TABLE products (
    id         SERIAL PRIMARY KEY,
    sku        TEXT NOT NULL UNIQUE CHECK (sku <> ''),
    name       TEXT NOT NULL CHECK (name <> ''),
    price      INTEGER NOT NULL CHECK (price >= 0),   -- IDR, integer: no float money
    stock      INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stock_movements (
    id         SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    type       TEXT NOT NULL CHECK (type IN ('in', 'out')),
    qty        INTEGER NOT NULL CHECK (qty > 0),
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves both the movement history endpoint and last_movement_at on the product list.
CREATE INDEX stock_movements_product_created_idx ON stock_movements (product_id, created_at DESC);

CREATE TABLE sales_orders (
    id           SERIAL PRIMARY KEY,
    customer     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','CANCELLED')),
    total        INTEGER NOT NULL CHECK (total >= 0),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ
);

CREATE TABLE sales_order_items (
    id         SERIAL PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES sales_orders(id),
    sku        TEXT NOT NULL REFERENCES products(sku),
    qty        INTEGER NOT NULL CHECK (qty > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0)
);

CREATE INDEX sales_order_items_order_idx ON sales_order_items (order_id);

-- One row per Idempotency-Key seen on POST /api/orders. Written in the same
-- transaction as the order, so a key exists if and only if its order exists.
CREATE TABLE idempotency_keys (
    key          TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    order_id     INTEGER REFERENCES sales_orders(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
