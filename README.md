# StockFlow

Inventory and sales module for a warehouse supervisor: manage products, adjust stock, and record sales orders that consume stock.

- **Backend:** Go 1.26 (`net/http` + `pgx`), PostgreSQL 16
- **Frontend:** React 19 + TypeScript (strict) on Vite, TanStack Query
- **Run:** one `docker compose up`

```
stockflow/
├── backend/
│   ├── cmd/api/              # main: config, pgx pool, HTTP server, graceful shutdown
│   ├── internal/store/       # all SQL and transactions (+ integration tests)
│   ├── internal/httpapi/     # routing, JSON decoding, error envelope (+ contract test)
│   └── migrations/           # 001 schema, 002 seed, 003 test database
├── frontend/src/
│   ├── api/                  # types.ts (wire types) + client.ts (the only fetch caller)
│   ├── lib/                  # formatting + validation (pure, unit tested)
│   ├── hooks/useDebounce.ts
│   └── components/
└── docker-compose.yml
```

---

## Running it

### Option A: everything in Docker (recommended)

```bash
docker compose up --build
```

| What     | URL                    |
| -------- | ---------------------- |
| App      | http://localhost:3000  |
| API      | http://localhost:8080  |
| Postgres | `localhost:5433` (user / password / db: `stockflow`) |

On first start Postgres applies `backend/migrations/` in order: schema, seed data (14 products, 3 orders), and an empty `stockflow_test` database for the backend tests. To start over from a clean seed:

```bash
docker compose down -v && docker compose up --build
```

### Option B: database in Docker, apps locally (for development)

Requires Go 1.26+ and Node 22+.

```bash
docker compose up -d db                    # 1. Postgres with schema + seed

cd backend && go run ./cmd/api             # 2. API on :8080

cd frontend && npm install && npm run dev  # 3. UI on http://localhost:5173
```

The backend reads `DATABASE_URL` (default `postgres://stockflow:stockflow@localhost:5433/stockflow`) and `PORT` (default `8080`).

**Dev wiring:** Vite proxies `/api` to `http://localhost:8080` (`vite.config.ts`, override with `API_PROXY_TARGET`). In Docker, nginx does the same (`frontend/nginx.conf`). The browser only ever talks to one origin, so the API needs no CORS middleware.

If the full Docker stack is already running, stop it first (`docker compose stop backend frontend`) because both use port 8080.

### Tests

```bash
docker compose up -d db                    # tests use the stockflow_test database
cd backend && go test -race ./...

cd frontend && npm test                    # Vitest
```

Backend tests are integration tests against real Postgres; transaction and locking behaviour is the thing being tested, so a mock would prove nothing. Each test creates its own uniquely named products, so tests don't depend on each other or on run order. Override the DSN with `TEST_DATABASE_URL`.

| Test | What it proves |
| --- | --- |
| `TestCreateOrder_InsufficientStockWritesNothing` | Two-item order where the 2nd item is short: 409 with `sku`/`available`, and the 1st item's stock, movements and order rows are all untouched (rollback) |
| `TestCreateOrder_HappyPathWritesMovementAndStock` | Stock decremented, `out` movement written, server prices and total |
| `TestCreateOrder_ConcurrentOrdersNeverOversell` | 30 goroutines race for 10 units across two SKUs given in opposite order: exactly 10 succeed, stock ends at 0, no deadlock |
| `TestCancelOrder_RestoresStockExactlyOnce` | 5 concurrent cancels: one wins, stock restored once, the rest get 409 |
| `TestCreateOrder_IdempotencyKey` | Retry with the same key replays the order; a different body with the same key is rejected |
| `TestAdjustStock`, `TestDeleteProduct`, `TestCreateOrder_RejectsUnknownAndInactiveSKU`, `TestValidateOrder` | Adjustments, `PRODUCT_HAS_HISTORY`, 400 rules |
| `httpapi.TestErrorEnvelope` | Status codes and JSON error shape over real HTTP |

As a sanity check that the concurrency test can fail, removing `AND stock >= $2` from the order UPDATE makes it fail (the `CHECK (stock >= 0)` constraint then turns the oversell into errors instead).

Frontend tests cover Rupiah and relative-time formatting, quantity/price/order validation, mapping server field errors (`items[2].qty`) back onto form rows, and the API client's error parsing.

---

## API

All errors use one envelope:

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "insufficient stock for BRG-005: 8 available", "sku": "BRG-005", "available": 8 } }
```

`fields` (per-field messages) is present on validation errors. Codes: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `SKU_EXISTS` / `PRODUCT_HAS_HISTORY` / `INSUFFICIENT_STOCK` / `ORDER_ALREADY_CANCELLED` (409), `IDEMPOTENCY_KEY_REUSED` (422), `INTERNAL` (500).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/products?search=&page=&limit=&filter=` | `{data, page, limit, total}`; `filter` = `all\|active\|inactive\|low` (extension) |
| POST | `/api/products` | 201; new products start at stock 0 |
| PUT | `/api/products/{id}` | name, price, is_active; 404 when missing |
| DELETE | `/api/products/{id}` | 204; 409 `PRODUCT_HAS_HISTORY` |
| POST | `/api/products/{id}/stock` | `{type, qty, note}`; 409 `INSUFFICIENT_STOCK` |
| GET | `/api/products/{id}/movements` | `{data}`, newest first |
| GET | `/api/products/summary` | totals for the summary cards (extension) |
| GET | `/api/orders` | latest 50 orders, without items (extension) |
| POST | `/api/orders` | 201 with items + server total; optional `Idempotency-Key` header |
| GET | `/api/orders/{id}` | order + items |
| POST | `/api/orders/{id}/cancel` | restores stock; 409 when already cancelled |
| GET | `/api/reports/daily-sales?date=YYYY-MM-DD` | defaults to today (WIB) |

### curl examples

```bash
API=http://localhost:8080/api

# list / search / filter
curl "$API/products?search=kopi"
curl "$API/products?filter=low&page=1&limit=20"

# create, update, delete
curl -X POST $API/products -H 'Content-Type: application/json' \
  -d '{"sku":"BRG-020","name":"Minyak Kayu Putih 60ml","price":21500}'
curl -X PUT $API/products/15 -H 'Content-Type: application/json' \
  -d '{"name":"Minyak Kayu Putih 60ml","price":22000,"is_active":true}'
curl -i -X DELETE $API/products/15                      # 204
curl -i -X DELETE $API/products/1                       # 409 PRODUCT_HAS_HISTORY

# stock
curl -X POST $API/products/5/stock -H 'Content-Type: application/json' \
  -d '{"type":"in","qty":24,"note":"PO-0192 received"}'
curl -i -X POST $API/products/5/stock -H 'Content-Type: application/json' \
  -d '{"type":"out","qty":999}'                         # 409 INSUFFICIENT_STOCK + available
curl $API/products/5/movements

# orders
curl -X POST $API/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: 7d1c0b6e-demo' \
  -d '{"customer":"Toko Makmur","items":[{"sku":"BRG-001","qty":2},{"sku":"BRG-004","qty":5}]}'
curl -i -X POST $API/orders -H 'Content-Type: application/json' -H 'Idempotency-Key: 7d1c0b6e-demo' \
  -d '{"customer":"Toko Makmur","items":[{"sku":"BRG-001","qty":2},{"sku":"BRG-004","qty":5}]}'
                                                        # same order, header Idempotent-Replayed: true
curl -i -X POST $API/orders -H 'Content-Type: application/json' \
  -d '{"customer":"","items":[{"sku":"NOPE","qty":0},{"sku":"BRG-001","qty":1},{"sku":"BRG-001","qty":1}]}'
                                                        # 400 with per-item fields
curl $API/orders/4
curl -X POST $API/orders/4/cancel
curl -i -X POST $API/orders/4/cancel                    # 409 ORDER_ALREADY_CANCELLED

# reports
curl "$API/products/summary"
curl "$API/reports/daily-sales?date=2026-10-23"
```

---

## Design decisions

### Stock can never go negative

Every stock decrement is a single guarded statement:

```sql
UPDATE products SET stock = stock - $qty
WHERE sku = $sku AND stock >= $qty AND is_active
RETURNING id, price
```

Postgres takes the row lock and re-evaluates the `WHERE` against the latest committed row, so two concurrent orders can't both pass the check. Zero rows affected means insufficient stock (or the product was deactivated meanwhile). The code then reads the current stock for the `available` field and returns an error, and the deferred rollback undoes any earlier lines. There is no SELECT-then-UPDATE anywhere. `CHECK (stock >= 0)` stays on the table as a second line of defence.

### Orders are all-or-nothing

`CreateOrder` runs in one transaction:
1. Validate the payload without touching the database: customer, non-empty items, `qty > 0`, duplicate SKUs (`400` with `items[i].field` keys).
2. Check that every SKU exists and is active (`400`) before writing anything.
3. Decrement each line with the guarded UPDATE. Lines are processed **sorted by SKU**, so two orders containing the same products always lock rows in the same order and can't deadlock. The concurrency test deliberately sends SKUs in opposite orders.
4. Insert the order, items and `out` movements (`note = "Order #id"`).

`unit_price` comes from the `RETURNING price` of the locked row, so the client never sends prices and a concurrent price edit can't be half-applied. The total is summed in `int64`; an order whose total would overflow the `INTEGER` column is rejected with 400 instead of erroring.

Cancelling is guarded the same way: `UPDATE sales_orders SET status='CANCELLED' WHERE id=$1 AND status='CREATED'`. Only one concurrent cancel can flip it, so stock is restored exactly once (also covered by a test). Restores write `in` movements, so the movement ledger always sums to the current stock.

### `last_movement_at` is derived, not stored

It is computed as `(SELECT max(created_at) FROM stock_movements WHERE product_id = p.id)`, backed by an index on `(product_id, created_at DESC)`. A denormalized column would need updating on every write path (adjustments, orders, cancellations) and could drift. At this data size the subquery is an index lookup per row. If the product list ever got large enough for this to matter, I'd maintain the column in the same transactions.

### Deleting products

`DELETE` relies on the existing foreign keys (`stock_movements.product_id`, `sales_order_items.sku`): if any history exists, Postgres raises a foreign-key violation, which maps to `409 PRODUCT_HAS_HISTORY`. This is race-free, unlike a check-then-delete. History is never deleted. The way to retire a product is `is_active = false`.

### Smaller choices

- **SKU is immutable** after creation (order items reference it). `PUT` rejects a `sku` field as unknown. Stock is never edited via `PUT` either, only through movements.
- **Inactive products** can't be sold, but stock can still be adjusted (e.g. writing off remaining stock).
- **Strict JSON decoding:** unknown fields, wrong types (`"price": 1.5` → `price must be an integer`) and trailing data are 400s with field messages.
- **Idempotency-Key** (bonus): the key and a hash of the body are inserted in the same transaction as the order. A concurrent duplicate blocks on the primary key until the first request commits, then replays the stored order (`Idempotent-Replayed: true`). A failed attempt rolls the key back, so it can be retried. The UI generates one key per order draft, which covers double-clicks and retries after a network blip.
- **Additions to the contract** (the original endpoints are unchanged): a `filter` param on the product list (server-side so it works with pagination), `GET /products/summary` (cards over all products, not one page), `GET /orders` (so the detail screen is reachable), and the daily sales report. "A day" means GMT+7.
- **Separate test database** (`stockflow_test`, created by `003_test_database.sh`) so running tests never pollutes the data you click around in.

### Frontend

- `api/types.ts` holds every wire type. `api/client.ts` is the only module that calls `fetch`; it converts any non-2xx response (or a network failure / proxy 502) into an `ApiError` with `code`, `fields`, `sku`, `available`. Components switch on `err.code`, never on status numbers or message text.
- **409s are visible, not just logged:** the stock modal shows "only N available"; the order form highlights exactly the failing line with its available quantity; server 400 field errors (`items[2].qty`) are mapped back onto the matching form row.
- After any mutation the app invalidates all queries, so products, summary cards, order list and today's sales stay consistent (e.g. cancelling an order visibly restores stock in the products table). That's a blunt but correct choice for an app this size.
- Loading (skeleton rows), empty (with "clear filters") and error (with Retry) states all render inside the table. To see the error state, stop the backend and type in the search box.
- Modals use the native `<dialog>` element (focus trap, Escape, backdrop for free). Destructive actions use an inline confirm step rather than `window.confirm`.

---

## What I'd improve next

- **Pagination and filtering for orders** (currently the latest 50), plus a product picker with server-side search instead of loading up to 100 active products into a datalist.
- **Migrations tool** (golang-migrate or goose) instead of init scripts, which only run on an empty volume.
- **Request IDs and structured error logging** with correlation to the UI; metrics on 409 rates per SKU.
- **Idempotency key expiry** (cleanup job) and storing the full response, so replays also work for non-order endpoints.
- **Component tests** (Testing Library) for the order form's 409 highlighting, and a Playwright end-to-end run against the compose stack in CI.
- **Auth and an audit trail** (who adjusted stock): every movement row should carry a user.
- **URL routing** (e.g. `/orders/12`) so order detail pages can be linked and survive refreshes.

## Time spent

6–8 hours.
