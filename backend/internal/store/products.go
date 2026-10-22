package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// MaxQty caps a single stock adjustment or order line.
const MaxQty = 1_000_000

type Product struct {
	ID             int        `json:"id"`
	SKU            string     `json:"sku"`
	Name           string     `json:"name"`
	Price          int        `json:"price"`
	Stock          int        `json:"stock"`
	IsActive       bool       `json:"is_active"`
	CreatedAt      time.Time  `json:"created_at"`
	LastMovementAt *time.Time `json:"last_movement_at"`
}

// last_movement_at is derived from stock_movements (indexed on product_id,
// created_at) instead of being denormalized onto the row, so it can never drift.
const productColumns = `p.id, p.sku, p.name, p.price, p.stock, p.is_active, p.created_at,
	(SELECT max(m.created_at) FROM stock_movements m WHERE m.product_id = p.id)`

func scanProduct(row pgx.Row) (Product, error) {
	var p Product
	err := row.Scan(&p.ID, &p.SKU, &p.Name, &p.Price, &p.Stock, &p.IsActive, &p.CreatedAt, &p.LastMovementAt)
	return p, err
}

type ListParams struct {
	Search string
	Filter string // "", "all", "active", "inactive", "low" (stock <= 10)
	Page   int
	Limit  int
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

func (s *Store) ListProducts(ctx context.Context, prm ListParams) ([]Product, int, error) {
	where := `($1 = '' OR p.sku ILIKE $1 OR p.name ILIKE $1)`
	switch prm.Filter {
	case "active":
		where += ` AND p.is_active`
	case "inactive":
		where += ` AND NOT p.is_active`
	case "low":
		where += ` AND p.stock <= 10`
	}
	pattern := ""
	if prm.Search != "" {
		pattern = "%" + likeEscaper.Replace(prm.Search) + "%"
	}

	var total int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM products p WHERE `+where, pattern).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(ctx,
		`SELECT `+productColumns+` FROM products p WHERE `+where+` ORDER BY p.sku LIMIT $2 OFFSET $3`,
		pattern, prm.Limit, (prm.Page-1)*prm.Limit)
	if err != nil {
		return nil, 0, err
	}
	products, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Product, error) { return scanProduct(r) })
	return products, total, err
}

func (s *Store) GetProduct(ctx context.Context, id int) (Product, error) {
	return getProduct(ctx, s.db, id)
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func getProduct(ctx context.Context, q querier, id int) (Product, error) {
	p, err := scanProduct(q.QueryRow(ctx, `SELECT `+productColumns+` FROM products p WHERE p.id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return p, notFound("product %d not found", id)
	}
	return p, err
}

type ProductInput struct {
	SKU      string `json:"sku"`
	Name     string `json:"name"`
	Price    *int   `json:"price"`
	IsActive *bool  `json:"is_active"`
}

// ValidateProduct checks a create (withSKU) or update payload.
func ValidateProduct(in *ProductInput, withSKU bool) *Error {
	in.SKU = strings.TrimSpace(in.SKU)
	in.Name = strings.TrimSpace(in.Name)
	fields := map[string]string{}
	if withSKU && in.SKU == "" {
		fields["sku"] = "sku is required"
	} else if len(in.SKU) > 64 {
		fields["sku"] = "sku must be at most 64 characters"
	}
	if in.Name == "" {
		fields["name"] = "name is required"
	} else if len(in.Name) > 200 {
		fields["name"] = "name must be at most 200 characters"
	}
	if in.Price == nil {
		fields["price"] = "price is required"
	} else if *in.Price < 0 {
		fields["price"] = "price must be 0 or more"
	}
	if len(fields) > 0 {
		return invalid(fields)
	}
	return nil
}

func (s *Store) CreateProduct(ctx context.Context, in ProductInput) (Product, error) {
	if err := ValidateProduct(&in, true); err != nil {
		return Product{}, err
	}
	active := in.IsActive == nil || *in.IsActive
	var id int
	err := s.db.QueryRow(ctx,
		`INSERT INTO products (sku, name, price, is_active) VALUES ($1, $2, $3, $4) RETURNING id`,
		in.SKU, in.Name, *in.Price, active).Scan(&id)
	if isPgError(err, pgUniqueViolation) {
		return Product{}, &Error{Code: CodeSKUExists, Message: "sku already exists",
			Fields: map[string]string{"sku": "sku " + in.SKU + " already exists"}}
	}
	if err != nil {
		return Product{}, err
	}
	return s.GetProduct(ctx, id)
}

// UpdateProduct edits name, price and is_active. SKU is immutable because order
// items reference it, and stock only changes through AdjustStock or orders.
func (s *Store) UpdateProduct(ctx context.Context, id int, in ProductInput) (Product, error) {
	if err := ValidateProduct(&in, false); err != nil {
		return Product{}, err
	}
	tag, err := s.db.Exec(ctx,
		`UPDATE products SET name = $2, price = $3, is_active = COALESCE($4, is_active) WHERE id = $1`,
		id, in.Name, *in.Price, in.IsActive)
	if err != nil {
		return Product{}, err
	}
	if tag.RowsAffected() == 0 {
		return Product{}, notFound("product %d not found", id)
	}
	return s.GetProduct(ctx, id)
}

// DeleteProduct relies on the foreign keys from stock_movements and
// sales_order_items: a product with any history cannot be deleted, even if
// that history is written concurrently with this call.
func (s *Store) DeleteProduct(ctx context.Context, id int) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM products WHERE id = $1`, id)
	if isPgError(err, pgForeignKeyViolation) {
		return &Error{Code: CodeHasHistory, Message: "product has stock movement history and cannot be deleted; deactivate it instead"}
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return notFound("product %d not found", id)
	}
	return nil
}

type StockInput struct {
	Type string `json:"type"`
	Qty  int    `json:"qty"`
	Note string `json:"note"`
}

func ValidateStock(in *StockInput) *Error {
	in.Note = strings.TrimSpace(in.Note)
	fields := map[string]string{}
	if in.Type != "in" && in.Type != "out" {
		fields["type"] = `type must be "in" or "out"`
	}
	if in.Qty <= 0 {
		fields["qty"] = "qty must be greater than 0"
	} else if in.Qty > MaxQty {
		fields["qty"] = "qty must be at most 1000000"
	}
	if len(in.Note) > 500 {
		fields["note"] = "note must be at most 500 characters"
	}
	if len(fields) > 0 {
		return invalid(fields)
	}
	return nil
}

// AdjustStock changes stock and writes the movement row in one transaction.
// The "out" guard lives in the UPDATE's WHERE clause, so two concurrent
// withdrawals can never take stock below zero.
func (s *Store) AdjustStock(ctx context.Context, id int, in StockInput) (Product, error) {
	if err := ValidateStock(&in); err != nil {
		return Product{}, err
	}
	var p Product
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		q := `UPDATE products SET stock = stock + $2 WHERE id = $1`
		if in.Type == "out" {
			q = `UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2`
		}
		tag, err := tx.Exec(ctx, q, id, in.Qty)
		if isPgError(err, pgNumericOutOfRange) {
			return invalid(map[string]string{"qty": "resulting stock is too large"})
		}
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			var sku string
			var available int
			err := tx.QueryRow(ctx, `SELECT sku, stock FROM products WHERE id = $1`, id).Scan(&sku, &available)
			if errors.Is(err, pgx.ErrNoRows) {
				return notFound("product %d not found", id)
			}
			if err != nil {
				return err
			}
			return insufficient(sku, available)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO stock_movements (product_id, type, qty, note) VALUES ($1, $2, $3, NULLIF($4, ''))`,
			id, in.Type, in.Qty, in.Note); err != nil {
			return err
		}
		p, err = getProduct(ctx, tx, id)
		return err
	})
	return p, err
}

type Movement struct {
	ID        int       `json:"id"`
	ProductID int       `json:"product_id"`
	Type      string    `json:"type"`
	Qty       int       `json:"qty"`
	Note      *string   `json:"note"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Store) ListMovements(ctx context.Context, productID int) ([]Movement, error) {
	var exists bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM products WHERE id = $1)`, productID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, notFound("product %d not found", productID)
	}
	rows, err := s.db.Query(ctx,
		`SELECT id, product_id, type, qty, note, created_at FROM stock_movements
		 WHERE product_id = $1 ORDER BY created_at DESC, id DESC`, productID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowToStructByPos[Movement])
}

type Summary struct {
	TotalProducts   int   `json:"total_products"`
	ActiveProducts  int   `json:"active_products"`
	TotalStockValue int64 `json:"total_stock_value"`
	LowStockCount   int   `json:"low_stock_count"`
}

func (s *Store) Summary(ctx context.Context) (Summary, error) {
	var sum Summary
	err := s.db.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE is_active),
		       COALESCE(sum(price::bigint * stock), 0),
		       count(*) FILTER (WHERE stock <= 10)
		FROM products`).Scan(&sum.TotalProducts, &sum.ActiveProducts, &sum.TotalStockValue, &sum.LowStockCount)
	return sum, err
}
