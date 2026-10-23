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

### Prerequisites

- **Docker** with Compose v2 (the `docker compose` command, not the legacy `docker-compose`). This is all you need for Option A.
- **Go 1.26+** and **Node 22+**, only for Option B and for running the tests.

```bash
git clone https://github.com/fabian4819/stockflow.git
cd stockflow
```

All commands below are run from the repository root unless a step says `cd` into a folder.

### Option A: everything in Docker (recommended)

```bash
docker compose up --build
```

The first run downloads the Postgres, Go, Node and nginx base images and installs npm packages, so expect roughly 1–3 minutes depending on your connection. Later starts take a few seconds. The app is ready when `http://localhost:3000` loads.

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

Requires Go 1.26+ and Node 22+. Use three terminals, each starting in the repository root:

```bash
# Terminal 1: Postgres with schema + seed (runs in the background)
docker compose up -d db

# Terminal 2: API on http://localhost:8080
cd backend
go run ./cmd/api

# Terminal 3: UI on http://localhost:5173
cd frontend
npm install
npm run dev
```

The backend reads `DATABASE_URL` (default `postgres://stockflow:stockflow@localhost:5433/stockflow`) and `PORT` (default `8080`).

**Dev wiring:** Vite proxies `/api` to `http://localhost:8080` (`vite.config.ts`, override with `API_PROXY_TARGET`). In Docker, nginx does the same (`frontend/nginx.conf`). The browser only ever talks to one origin, so the API needs no CORS middleware.

If the full Docker stack is already running, stop it first (`docker compose stop backend frontend`) because both use port 8080.

### If a port is already in use

The host ports can be changed with environment variables:

| Variable   | Default | Used by |
| ---------- | ------- | ------- |
| `APP_PORT` | 3000    | UI (Docker) |
| `API_PORT` | 8080    | API (Docker) |
| `DB_PORT`  | 5433    | Postgres (5433 instead of 5432 to avoid clashing with a local Postgres) |

```bash
APP_PORT=3001 API_PORT=8081 DB_PORT=6543 docker compose up --build
```

If you change `DB_PORT` and run the backend or the tests locally, point them at the new port:

```bash
DATABASE_URL=postgres://stockflow:stockflow@localhost:6543/stockflow go run ./cmd/api
TEST_DATABASE_URL=postgres://stockflow:stockflow@localhost:6543/stockflow_test go test -race ./...
```

For Option B, the backend's own port is set with `PORT` (e.g. `PORT=8081 go run ./cmd/api`). The Vite proxy then needs `API_PROXY_TARGET=http://localhost:8081 npm run dev`.

### Tests

```bash
# Backend (needs the db container; tests use the stockflow_test database)
docker compose up -d db
cd backend
go test -race ./...

# Frontend (Vitest, no backend needed), from the repository root
cd frontend
npm install
npm test
```

Backend tests are integration tests against real Postgres; transaction and locking behaviour is the thing being tested, so a mock would prove nothing. Each test creates its own uniquely named products, so tests don't depend on each other or on run order. Override the DSN with `TEST_DATABASE_URL`.

| Test | What it proves |
| --- | --- |
| `TestCreateOrder_InsufficientStockWritesNothing` | Two-item order where the 2nd item is short: 409 with `sku`/`available`, and the 1st item's stock, movements and order rows are all untouched (rollback) |
| `TestCreateOrder_HappyPathWritesMovementAndStock` | Stock decremented, `out` movement written, server prices and total |
| `TestCreateOrder_ConcurrentOrdersNeverOversell` | 30 goroutines race for 10 units across two SKUs given in opposite order: exactly 10 succeed, stock ends at 0, no deadlock |
| `TestCancelOrder_RestoresStockExactlyOnce` | 5 concurrent cancels: one wins, stock restored once, the rest get 409 |
| `TestCreateOrder_IdempotencyKey` | Retry with the same key replays the order; a different body with the same key is rejected |
| `TestCreateOrder_ReportsAllValidationErrorsAtOnce` | Payload errors and unknown SKUs come back together in one 400 |
| `TestAdjustStock`, `TestDeleteProduct`, `TestCreateOrder_RejectsUnknownAndInactiveSKU`, `TestValidateOrder` | Adjustments, `PRODUCT_HAS_HISTORY`, 400 rules |
| `httpapi.TestErrorEnvelope` | Status codes and JSON error shape over real HTTP |

As a sanity check that the concurrency test can fail, removing `AND stock >= $2` from the order UPDATE makes it fail (the `CHECK (stock >= 0)` constraint then turns the oversell into errors instead).

Frontend unit tests cover Rupiah and relative-time formatting, quantity/price/order validation, mapping server field errors (`items[2].qty`) back onto form rows, URL route parsing, and the API client's error parsing.

`CreateOrderForm.test.tsx` renders the real order form in jsdom (Testing Library) with only the network calls stubbed. It checks that a 409 `INSUFFICIENT_STOCK` highlights exactly the failing line with "Only N available" and names the SKU in the alert, and that a 400 on `items[1].qty` lands on line 2. The 409 test was checked to fail when the form highlights the wrong line.

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
2. Check that every SKU exists and is active (`400`) before writing anything. Errors from steps 1 and 2 are returned together in one 400, so the client sees every problem at once.
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
- **URL routes:** `/` (products), `/orders/new` and `/orders/{id}`, so order pages can be linked and survive a refresh. A small History API hook (`hooks/useRoute.ts`) covers three screens without a router dependency; nginx and the Vite dev server fall back to `index.html`.
- **Order line search:** each line's SKU input searches active products on the server as you type (debounced, 10 results), instead of loading the whole catalogue up front. The exact SKU match drives the line hint (name · price · stock) and the estimated total.

---

## What I'd improve next

- **Pagination and filtering for orders** (currently the latest 50).
- **Migrations tool** (golang-migrate or goose) instead of init scripts, which only run on an empty volume.
- **Request IDs and structured error logging** with correlation to the UI; metrics on 409 rates per SKU.
- **Idempotency key expiry** (cleanup job) and storing the full response, so replays also work for non-order endpoints.
- **More component tests** (stock modal, products page states) and a Playwright end-to-end run against the compose stack in CI.
- **Auth and an audit trail** (who adjusted stock): every movement row should carry a user.

## Commit history

Instead of one final dump, the work is split into commits that each cover one layer or concern, in the order it was built: the core first (1–13), then refinements (14–18). Every step was verified before committing: build, tests, or a manual check against the running app.

| # | Commit | What it adds |
| - | ------ | ------------ |
| 1 | `chore: add postgres schema, seed data and compose setup` | Schema, 14 seeded products + 3 orders, Postgres in compose. Seed stock was checked to match the movement ledger. |
| 2 | `feat(backend): product store with guarded stock adjustments` | Product CRUD, the guarded `stock >= qty` UPDATE, movements in the same transaction. |
| 3 | `feat(backend): orders, cancellation, idempotency keys and HTTP API` | Atomic order creation, cancel, Idempotency-Key, all HTTP routes and the error envelope. |
| 4 | `test(backend): integration tests for atomic orders, concurrency, cancel and idempotency` | The required tests plus the `-race` concurrency test. |
| 5 | `feat(frontend): typed API client, formatting/validation helpers and unit tests` | Shared types, the single API client, pure helpers with Vitest tests. |
| 6 | `feat(frontend): products, stock adjustment, orders and summary screens` | All five screens. |
| 7 | `test(backend): run integration tests against a separate stockflow_test database` | Found during manual testing: test data was leaking into the app database. |
| 8 | `fix(frontend): keep modal open under StrictMode; show proxy 502 as unreachable backend` | Two bugs found while clicking through the app in the browser. |
| 9 | `build: run db, backend and frontend end to end with docker compose` | Dockerfiles, nginx proxy, full stack in compose. |
| 10–13 | `docs: …` | This README, time spent, clearer setup steps and port overrides, this commit-history section. |
| 14 | `fix(backend): report unknown SKUs together with payload errors in one 400` | Order validation returns every problem in one response instead of two rounds. |
| 15 | `feat(frontend): URL routes for products, new order and order detail` | `/orders/{id}` links that survive a refresh; tabs become real links. |
| 16 | `feat(frontend): server-side SKU search for order lines` | Debounced per-line product search replaces loading 100 products up front. |
| 17 | `test(frontend): component tests for order form 409 and 400 handling` | jsdom + Testing Library tests for the cross-stack error display. |
| 18 | `docs: …` | README updated for the refinements above. |

Commits 7 and 8 are deliberately kept as separate fixes rather than folded into earlier commits, so the history shows what testing caught.

## Time spent

6–8 hours.
