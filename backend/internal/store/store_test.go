package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// These are integration tests against a real Postgres: the stockflow_test
// database that docker compose creates next to the app database (see
// migrations/003_test_database.sh). Each test creates its own uniquely named
// products, so tests are independent of each other and of run order.

func testStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://stockflow:stockflow@localhost:5433/stockflow_test"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err == nil {
		err = pool.Ping(ctx)
	}
	if err != nil {
		t.Fatalf("postgres not reachable at %s (run `docker compose up -d db`): %v", dsn, err)
	}
	t.Cleanup(pool.Close)
	return New(pool), pool
}

var skuSeq = time.Now().UnixNano()
var skuMu sync.Mutex

func uniqueSKU(suffix string) string {
	skuMu.Lock()
	defer skuMu.Unlock()
	skuSeq++
	return fmt.Sprintf("T%d-%s", skuSeq, suffix)
}

func newProduct(t *testing.T, s *Store, suffix string, price, stock int) Product {
	t.Helper()
	ctx := context.Background()
	p, err := s.CreateProduct(ctx, ProductInput{SKU: uniqueSKU(suffix), Name: "Test " + suffix, Price: &price})
	if err != nil {
		t.Fatalf("create product: %v", err)
	}
	if stock > 0 {
		if p, err = s.AdjustStock(ctx, p.ID, StockInput{Type: "in", Qty: stock, Note: "test setup"}); err != nil {
			t.Fatalf("seed stock: %v", err)
		}
	}
	return p
}

func stockOf(t *testing.T, s *Store, id int) int {
	t.Helper()
	p, err := s.GetProduct(context.Background(), id)
	if err != nil {
		t.Fatalf("get product: %v", err)
	}
	return p.Stock
}

func countRows(t *testing.T, db *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func movementCount(t *testing.T, db *pgxpool.Pool, productID int) int {
	return countRows(t, db, `SELECT count(*) FROM stock_movements WHERE product_id = $1`, productID)
}

func wantCode(t *testing.T, err error, code string) *Error {
	t.Helper()
	var se *Error
	if !errors.As(err, &se) || se.Code != code {
		t.Fatalf("want error %s, got %v", code, err)
	}
	return se
}

func TestCreateOrder_InsufficientStockWritesNothing(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	// A sorts before B, so A is decremented first and must be rolled back.
	a := newProduct(t, s, "A", 10_000, 5)
	b := newProduct(t, s, "B", 20_000, 1)
	movA, movB := movementCount(t, db, a.ID), movementCount(t, db, b.ID)

	_, _, err := s.CreateOrder(ctx, OrderInput{
		Customer: "Toko Test",
		Items:    []OrderItemInput{{SKU: a.SKU, Qty: 2}, {SKU: b.SKU, Qty: 3}},
	}, "")

	se := wantCode(t, err, CodeInsufficient)
	if se.SKU != b.SKU || se.Available == nil || *se.Available != 1 {
		t.Fatalf("want sku %s available 1, got sku %s available %v", b.SKU, se.SKU, se.Available)
	}
	if got := stockOf(t, s, a.ID); got != 5 {
		t.Errorf("stock of A changed: want 5, got %d", got)
	}
	if got := stockOf(t, s, b.ID); got != 1 {
		t.Errorf("stock of B changed: want 1, got %d", got)
	}
	if movementCount(t, db, a.ID) != movA || movementCount(t, db, b.ID) != movB {
		t.Error("movement rows were written for a rejected order")
	}
	if n := countRows(t, db, `SELECT count(*) FROM sales_order_items WHERE sku = ANY($1)`, []string{a.SKU, b.SKU}); n != 0 {
		t.Errorf("order items were written for a rejected order: %d", n)
	}
}

func TestCreateOrder_HappyPathWritesMovementAndStock(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	a := newProduct(t, s, "A", 12_500, 10)
	b := newProduct(t, s, "B", 3_000, 4)

	order, replayed, err := s.CreateOrder(ctx, OrderInput{
		Customer: "  Warung Test  ",
		Items:    []OrderItemInput{{SKU: b.SKU, Qty: 4}, {SKU: a.SKU, Qty: 3}},
	}, "")
	if err != nil || replayed {
		t.Fatalf("create order: %v (replayed=%v)", err, replayed)
	}
	if order.Customer != "Warung Test" || order.Status != "CREATED" {
		t.Errorf("unexpected order header: %+v", order)
	}
	if want := 3*12_500 + 4*3_000; order.Total != want {
		t.Errorf("total: want %d, got %d", want, order.Total)
	}
	if len(order.Items) != 2 || order.Items[0].SKU != b.SKU || order.Items[0].UnitPrice != 3_000 {
		t.Errorf("items should keep request order with server prices: %+v", order.Items)
	}
	if got := stockOf(t, s, a.ID); got != 7 {
		t.Errorf("stock of A: want 7, got %d", got)
	}
	if got := stockOf(t, s, b.ID); got != 0 {
		t.Errorf("stock of B: want 0, got %d", got)
	}
	note := fmt.Sprintf("Order #%d", order.ID)
	if n := countRows(t, db, `SELECT count(*) FROM stock_movements WHERE product_id = $1 AND type = 'out' AND qty = 3 AND note = $2`, a.ID, note); n != 1 {
		t.Errorf("want 1 out movement for A, got %d", n)
	}
}

func TestAdjustStock(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	p := newProduct(t, s, "A", 1_000, 10)

	got, err := s.AdjustStock(ctx, p.ID, StockInput{Type: "out", Qty: 4, Note: "damaged"})
	if err != nil {
		t.Fatalf("adjust out: %v", err)
	}
	if got.Stock != 6 || got.LastMovementAt == nil {
		t.Errorf("want stock 6 with last_movement_at set, got %+v", got)
	}
	before := movementCount(t, db, p.ID)
	_, err = s.AdjustStock(ctx, p.ID, StockInput{Type: "out", Qty: 7})
	se := wantCode(t, err, CodeInsufficient)
	if *se.Available != 6 {
		t.Errorf("available: want 6, got %d", *se.Available)
	}
	if stockOf(t, s, p.ID) != 6 || movementCount(t, db, p.ID) != before {
		t.Error("rejected adjustment changed stock or wrote a movement")
	}
	_, err = s.AdjustStock(ctx, 999_999_999, StockInput{Type: "in", Qty: 1})
	wantCode(t, err, CodeNotFound)
}

// Many buyers race for the last units. The guarded UPDATE must let exactly
// `stock` of them through, and orders locking the same two SKUs in opposite
// request order must not deadlock.
func TestCreateOrder_ConcurrentOrdersNeverOversell(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	a := newProduct(t, s, "A", 1_000, 10)
	b := newProduct(t, s, "B", 1_000, 100)

	const buyers = 30
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok, insufficientCount := 0, 0
	var unexpected []error
	for i := range buyers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			items := []OrderItemInput{{SKU: a.SKU, Qty: 1}, {SKU: b.SKU, Qty: 1}}
			if i%2 == 1 {
				items[0], items[1] = items[1], items[0]
			}
			_, _, err := s.CreateOrder(ctx, OrderInput{Customer: fmt.Sprintf("buyer %d", i), Items: items}, "")
			mu.Lock()
			defer mu.Unlock()
			var se *Error
			switch {
			case err == nil:
				ok++
			case errors.As(err, &se) && se.Code == CodeInsufficient:
				insufficientCount++
			default:
				unexpected = append(unexpected, err)
			}
		}()
	}
	wg.Wait()

	if len(unexpected) > 0 {
		t.Fatalf("unexpected errors (deadlock?): %v", unexpected)
	}
	if ok != 10 || insufficientCount != buyers-10 {
		t.Errorf("want 10 successful and %d rejected orders, got %d and %d", buyers-10, ok, insufficientCount)
	}
	if got := stockOf(t, s, a.ID); got != 0 {
		t.Errorf("stock of A: want 0, got %d", got)
	}
	if got := stockOf(t, s, b.ID); got != 90 {
		t.Errorf("stock of B: want 90 (only successful orders consume it), got %d", got)
	}
	if n := countRows(t, db, `SELECT count(*) FROM stock_movements WHERE product_id = $1 AND type = 'out'`, a.ID); n != 10 {
		t.Errorf("want 10 out movements for A, got %d", n)
	}
}

func TestCancelOrder_RestoresStockExactlyOnce(t *testing.T) {
	s, db := testStore(t)
	ctx := context.Background()
	p := newProduct(t, s, "A", 5_000, 8)
	order, _, err := s.CreateOrder(ctx, OrderInput{Customer: "C", Items: []OrderItemInput{{SKU: p.SKU, Qty: 5}}}, "")
	if err != nil {
		t.Fatalf("create order: %v", err)
	}

	var wg sync.WaitGroup
	results := make([]error, 5)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, results[i] = s.CancelOrder(ctx, order.ID)
		}()
	}
	wg.Wait()

	cancelled := 0
	for _, err := range results {
		if err == nil {
			cancelled++
		} else {
			wantCode(t, err, CodeAlreadyCancelled)
		}
	}
	if cancelled != 1 {
		t.Errorf("want exactly 1 successful cancel, got %d", cancelled)
	}
	if got := stockOf(t, s, p.ID); got != 8 {
		t.Errorf("stock after cancel: want 8, got %d", got)
	}
	if n := countRows(t, db, `SELECT count(*) FROM stock_movements WHERE product_id = $1 AND note = $2`,
		p.ID, fmt.Sprintf("Order #%d cancelled", order.ID)); n != 1 {
		t.Errorf("want 1 restore movement, got %d", n)
	}
	got, err := s.GetOrder(ctx, order.ID)
	if err != nil || got.Status != "CANCELLED" || got.CancelledAt == nil {
		t.Errorf("order not marked cancelled: %+v %v", got, err)
	}
}

func TestCreateOrder_IdempotencyKey(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	p := newProduct(t, s, "A", 2_000, 10)
	key := uniqueSKU("key")
	in := OrderInput{Customer: "Retry Co", Items: []OrderItemInput{{SKU: p.SKU, Qty: 2}}}

	first, replayed, err := s.CreateOrder(ctx, in, key)
	if err != nil || replayed {
		t.Fatalf("first: %v replayed=%v", err, replayed)
	}
	second, replayed, err := s.CreateOrder(ctx, in, key)
	if err != nil || !replayed || second.ID != first.ID {
		t.Fatalf("retry should replay order %d, got %d replayed=%v err=%v", first.ID, second.ID, replayed, err)
	}
	if got := stockOf(t, s, p.ID); got != 8 {
		t.Errorf("stock decremented twice: want 8, got %d", got)
	}
	in.Items[0].Qty = 3
	_, _, err = s.CreateOrder(ctx, in, key)
	wantCode(t, err, CodeIdempotencyReuse)
}

func TestCreateOrder_RejectsUnknownAndInactiveSKU(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	p := newProduct(t, s, "A", 1_000, 5)
	inactive := false
	price := 1_000
	if _, err := s.UpdateProduct(ctx, p.ID, ProductInput{Name: p.Name, Price: &price, IsActive: &inactive}); err != nil {
		t.Fatal(err)
	}
	_, _, err := s.CreateOrder(ctx, OrderInput{Customer: "C", Items: []OrderItemInput{
		{SKU: "DOES-NOT-EXIST", Qty: 1}, {SKU: p.SKU, Qty: 1},
	}}, "")
	se := wantCode(t, err, CodeValidation)
	if se.Fields["items[0].sku"] == "" || se.Fields["items[1].sku"] == "" {
		t.Errorf("want errors on both items, got %v", se.Fields)
	}
	if stockOf(t, s, p.ID) != 5 {
		t.Error("stock changed on a rejected order")
	}
}

// Payload errors and unknown SKUs come back together in one 400, so the
// client never has to fix the form twice.
func TestCreateOrder_ReportsAllValidationErrorsAtOnce(t *testing.T) {
	s, _ := testStore(t)
	p := newProduct(t, s, "A", 1_000, 5)
	_, _, err := s.CreateOrder(context.Background(), OrderInput{Customer: " ", Items: []OrderItemInput{
		{SKU: "DOES-NOT-EXIST", Qty: 1}, {SKU: p.SKU, Qty: 0},
	}}, "")
	se := wantCode(t, err, CodeValidation)
	for _, field := range []string{"customer", "items[0].sku", "items[1].qty"} {
		if se.Fields[field] == "" {
			t.Errorf("missing error for %s, got %v", field, se.Fields)
		}
	}
	if stockOf(t, s, p.ID) != 5 {
		t.Error("stock changed on a rejected order")
	}
}

func TestDeleteProduct(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	withHistory := newProduct(t, s, "A", 1_000, 1)
	wantCode(t, s.DeleteProduct(ctx, withHistory.ID), CodeHasHistory)

	fresh := newProduct(t, s, "B", 1_000, 0)
	if err := s.DeleteProduct(ctx, fresh.ID); err != nil {
		t.Fatalf("delete fresh product: %v", err)
	}
	wantCode(t, s.DeleteProduct(ctx, fresh.ID), CodeNotFound)
}

func TestValidateOrder(t *testing.T) {
	tests := []struct {
		name  string
		in    OrderInput
		field string
	}{
		{"empty customer", OrderInput{Customer: " ", Items: []OrderItemInput{{SKU: "A", Qty: 1}}}, "customer"},
		{"no items", OrderInput{Customer: "C"}, "items"},
		{"zero qty", OrderInput{Customer: "C", Items: []OrderItemInput{{SKU: "A", Qty: 0}}}, "items[0].qty"},
		{"negative qty", OrderInput{Customer: "C", Items: []OrderItemInput{{SKU: "A", Qty: -2}}}, "items[0].qty"},
		{"blank sku", OrderInput{Customer: "C", Items: []OrderItemInput{{SKU: "", Qty: 1}}}, "items[0].sku"},
		{"duplicate sku", OrderInput{Customer: "C", Items: []OrderItemInput{{SKU: "A", Qty: 1}, {SKU: " A ", Qty: 1}}}, "items[1].sku"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateOrder(&tc.in)
			if err == nil || err.Fields[tc.field] == "" {
				t.Fatalf("want error on %s, got %v", tc.field, err)
			}
		})
	}
	if err := ValidateOrder(&OrderInput{Customer: "C", Items: []OrderItemInput{{SKU: "A", Qty: 1}, {SKU: "B", Qty: 2}}}); err != nil {
		t.Fatalf("valid order rejected: %v", err)
	}
}
