package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type OrderItemInput struct {
	SKU string `json:"sku"`
	Qty int    `json:"qty"`
}

type OrderInput struct {
	Customer string           `json:"customer"`
	Items    []OrderItemInput `json:"items"`
}

type Order struct {
	ID          int         `json:"id"`
	Customer    string      `json:"customer"`
	Status      string      `json:"status"`
	Total       int         `json:"total"`
	CreatedAt   time.Time   `json:"created_at"`
	CancelledAt *time.Time  `json:"cancelled_at"`
	Items       []OrderItem `json:"items,omitempty"`
}

type OrderItem struct {
	SKU       string `json:"sku"`
	Name      string `json:"name"`
	Qty       int    `json:"qty"`
	UnitPrice int    `json:"unit_price"`
	Subtotal  int    `json:"subtotal"`
}

// ValidateOrder checks everything that can be checked without the database.
// Field keys use the client's item index ("items[2].qty") so the UI can point
// at the exact row.
func ValidateOrder(in *OrderInput) *Error {
	in.Customer = strings.TrimSpace(in.Customer)
	fields := map[string]string{}
	if in.Customer == "" {
		fields["customer"] = "customer is required"
	} else if len(in.Customer) > 200 {
		fields["customer"] = "customer must be at most 200 characters"
	}
	if len(in.Items) == 0 {
		fields["items"] = "at least one item is required"
	}
	seen := map[string]int{}
	for i := range in.Items {
		it := &in.Items[i]
		it.SKU = strings.TrimSpace(it.SKU)
		key := fmt.Sprintf("items[%d]", i)
		if it.SKU == "" {
			fields[key+".sku"] = "sku is required"
		} else if first, dup := seen[it.SKU]; dup {
			fields[key+".sku"] = fmt.Sprintf("duplicate sku %s (already in item %d)", it.SKU, first+1)
		} else {
			seen[it.SKU] = i
		}
		if it.Qty <= 0 {
			fields[key+".qty"] = "qty must be greater than 0"
		} else if it.Qty > MaxQty {
			fields[key+".qty"] = "qty must be at most 1000000"
		}
	}
	if len(fields) > 0 {
		return &Error{Code: CodeValidation, Message: "order is invalid", Fields: fields}
	}
	return nil
}

func requestHash(in OrderInput) string {
	b, _ := json.Marshal(in)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// CreateOrder writes the order, its items, the stock decrements and the
// movement rows in a single transaction. Either all of it commits or nothing.
//
// Concurrency: each line is decremented with
//
//	UPDATE products SET stock = stock - qty WHERE sku = ? AND stock >= qty
//
// which takes the row lock and re-checks the condition against the latest
// committed stock, so stock can never go negative. Lines are processed in SKU
// order so two orders touching the same products lock them in the same order
// and cannot deadlock.
//
// When idemKey is set, a replay with the same body returns the original order
// (replayed = true) instead of creating a second one.
func (s *Store) CreateOrder(ctx context.Context, in OrderInput, idemKey string) (order Order, replayed bool, err error) {
	if verr := ValidateOrder(&in); verr != nil {
		return Order{}, false, verr
	}

	type line struct {
		idx       int // position in the request, for error field keys
		sku       string
		qty       int
		productID int
		price     int
	}
	lines := make([]line, len(in.Items))
	skus := make([]string, len(in.Items))
	for i, it := range in.Items {
		lines[i] = line{idx: i, sku: it.SKU, qty: it.Qty}
		skus[i] = it.SKU
	}
	sort.Slice(lines, func(a, b int) bool { return lines[a].sku < lines[b].sku })

	var orderID int
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if idemKey != "" {
			// A concurrent request with the same key blocks on this insert
			// until the first transaction finishes.
			hash := requestHash(in)
			tag, err := tx.Exec(ctx,
				`INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
				idemKey, hash)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				var storedHash string
				var storedID *int
				if err := tx.QueryRow(ctx, `SELECT request_hash, order_id FROM idempotency_keys WHERE key = $1`,
					idemKey).Scan(&storedHash, &storedID); err != nil {
					return err
				}
				if storedHash != hash || storedID == nil {
					return &Error{Code: CodeIdempotencyReuse, Message: "Idempotency-Key was already used with a different request body"}
				}
				orderID, replayed = *storedID, true
				return nil
			}
		}

		// 1. Validate every SKU before any stock is touched.
		rows, err := tx.Query(ctx, `SELECT sku, is_active FROM products WHERE sku = ANY($1)`, skus)
		if err != nil {
			return err
		}
		active := map[string]bool{}
		var sku string
		var isActive bool
		if _, err := pgx.ForEachRow(rows, []any{&sku, &isActive}, func() error {
			active[sku] = isActive
			return nil
		}); err != nil {
			return err
		}
		fields := map[string]string{}
		for _, l := range lines {
			if isActive, ok := active[l.sku]; !ok {
				fields[fmt.Sprintf("items[%d].sku", l.idx)] = "unknown sku " + l.sku
			} else if !isActive {
				fields[fmt.Sprintf("items[%d].sku", l.idx)] = l.sku + " is inactive and cannot be sold"
			}
		}
		if len(fields) > 0 {
			return &Error{Code: CodeValidation, Message: "order is invalid", Fields: fields}
		}

		// 2. Guarded decrements. Price is read from the locked row, never from the client.
		var total int64
		for i := range lines {
			l := &lines[i]
			err := tx.QueryRow(ctx,
				`UPDATE products SET stock = stock - $2
				 WHERE sku = $1 AND stock >= $2 AND is_active
				 RETURNING id, price`, l.sku, l.qty).Scan(&l.productID, &l.price)
			if errors.Is(err, pgx.ErrNoRows) {
				var available int
				var stillActive bool
				if err := tx.QueryRow(ctx, `SELECT stock, is_active FROM products WHERE sku = $1`, l.sku).
					Scan(&available, &stillActive); err != nil {
					return err
				}
				if !stillActive {
					return &Error{Code: CodeValidation, Message: "order is invalid",
						Fields: map[string]string{fmt.Sprintf("items[%d].sku", l.idx): l.sku + " is inactive and cannot be sold"}}
				}
				return insufficient(l.sku, available)
			}
			if err != nil {
				return err
			}
			total += int64(l.price) * int64(l.qty)
		}
		if total > math.MaxInt32 {
			return &Error{Code: CodeValidation, Message: "order total is too large",
				Fields: map[string]string{"items": "order total exceeds Rp 2.147.483.647"}}
		}

		// 3. Order, items, movements.
		if err := tx.QueryRow(ctx, `INSERT INTO sales_orders (customer, total) VALUES ($1, $2) RETURNING id`,
			in.Customer, total).Scan(&orderID); err != nil {
			return err
		}
		note := fmt.Sprintf("Order #%d", orderID)
		sort.Slice(lines, func(a, b int) bool { return lines[a].idx < lines[b].idx })
		for _, l := range lines {
			if _, err := tx.Exec(ctx,
				`INSERT INTO sales_order_items (order_id, sku, qty, unit_price) VALUES ($1, $2, $3, $4)`,
				orderID, l.sku, l.qty, l.price); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO stock_movements (product_id, type, qty, note) VALUES ($1, 'out', $2, $3)`,
				l.productID, l.qty, note); err != nil {
				return err
			}
		}
		if idemKey != "" {
			if _, err := tx.Exec(ctx, `UPDATE idempotency_keys SET order_id = $2 WHERE key = $1`, idemKey, orderID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Order{}, false, err
	}
	order, err = s.GetOrder(ctx, orderID)
	return order, replayed, err
}

// CancelOrder flips the status and restores stock in one transaction. The
// status guard in the UPDATE means two concurrent cancels restore stock once.
func (s *Store) CancelOrder(ctx context.Context, id int) (Order, error) {
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`UPDATE sales_orders SET status = 'CANCELLED', cancelled_at = now() WHERE id = $1 AND status = 'CREATED'`, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			var status string
			err := tx.QueryRow(ctx, `SELECT status FROM sales_orders WHERE id = $1`, id).Scan(&status)
			if errors.Is(err, pgx.ErrNoRows) {
				return notFound("order %d not found", id)
			}
			if err != nil {
				return err
			}
			return &Error{Code: CodeAlreadyCancelled, Message: fmt.Sprintf("order %d is already cancelled", id)}
		}

		rows, err := tx.Query(ctx, `SELECT sku, qty FROM sales_order_items WHERE order_id = $1 ORDER BY sku`, id)
		if err != nil {
			return err
		}
		items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[OrderItemInput])
		if err != nil {
			return err
		}
		note := fmt.Sprintf("Order #%d cancelled", id)
		for _, it := range items {
			var productID int
			if err := tx.QueryRow(ctx, `UPDATE products SET stock = stock + $2 WHERE sku = $1 RETURNING id`,
				it.SKU, it.Qty).Scan(&productID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO stock_movements (product_id, type, qty, note) VALUES ($1, 'in', $2, $3)`,
				productID, it.Qty, note); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Order{}, err
	}
	return s.GetOrder(ctx, id)
}

func (s *Store) GetOrder(ctx context.Context, id int) (Order, error) {
	var o Order
	err := s.db.QueryRow(ctx,
		`SELECT id, customer, status, total, created_at, cancelled_at FROM sales_orders WHERE id = $1`, id).
		Scan(&o.ID, &o.Customer, &o.Status, &o.Total, &o.CreatedAt, &o.CancelledAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return o, notFound("order %d not found", id)
	}
	if err != nil {
		return o, err
	}
	rows, err := s.db.Query(ctx,
		`SELECT i.sku, p.name, i.qty, i.unit_price, i.qty * i.unit_price
		 FROM sales_order_items i JOIN products p ON p.sku = i.sku
		 WHERE i.order_id = $1 ORDER BY i.id`, id)
	if err != nil {
		return o, err
	}
	o.Items, err = pgx.CollectRows(rows, pgx.RowToStructByPos[OrderItem])
	return o, err
}

// ListOrders returns the latest orders without items.
func (s *Store) ListOrders(ctx context.Context) ([]Order, error) {
	rows, err := s.db.Query(ctx,
		`SELECT id, customer, status, total, created_at, cancelled_at FROM sales_orders ORDER BY id DESC LIMIT 50`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Order, error) {
		var o Order
		err := r.Scan(&o.ID, &o.Customer, &o.Status, &o.Total, &o.CreatedAt, &o.CancelledAt)
		return o, err
	})
}

type DailySales struct {
	Date    string `json:"date"`
	Orders  int    `json:"orders"`
	Units   int    `json:"units"`
	Revenue int64  `json:"revenue"`
}

// WIB is the business timezone (GMT+7) used to define "a day".
var WIB = time.FixedZone("WIB", 7*60*60)

// DailySales aggregates non-cancelled orders created on day (in WIB).
func (s *Store) DailySales(ctx context.Context, day time.Time) (DailySales, error) {
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, WIB)
	r := DailySales{Date: start.Format(time.DateOnly)}
	err := s.db.QueryRow(ctx, `
		SELECT count(DISTINCT o.id), COALESCE(sum(i.qty), 0), COALESCE(sum(i.qty::bigint * i.unit_price), 0)
		FROM sales_orders o JOIN sales_order_items i ON i.order_id = o.id
		WHERE o.status = 'CREATED' AND o.created_at >= $1 AND o.created_at < $2`,
		start, start.AddDate(0, 0, 1)).Scan(&r.Orders, &r.Units, &r.Revenue)
	return r, err
}
