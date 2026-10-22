// Package store owns all SQL. Every multi-statement write runs inside one
// transaction, and stock is only ever changed by a guarded UPDATE.
package store

import (
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Error codes, shared with the HTTP layer and the frontend.
const (
	CodeValidation       = "VALIDATION_ERROR"
	CodeNotFound         = "NOT_FOUND"
	CodeSKUExists        = "SKU_EXISTS"
	CodeHasHistory       = "PRODUCT_HAS_HISTORY"
	CodeInsufficient     = "INSUFFICIENT_STOCK"
	CodeAlreadyCancelled = "ORDER_ALREADY_CANCELLED"
	CodeIdempotencyReuse = "IDEMPOTENCY_KEY_REUSED"
)

// Error is an expected, client-facing failure. It is serialized as-is inside
// the {"error": ...} envelope.
type Error struct {
	Code      string            `json:"code"`
	Message   string            `json:"message"`
	Fields    map[string]string `json:"fields,omitempty"`
	SKU       string            `json:"sku,omitempty"`
	Available *int              `json:"available,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func notFound(format string, args ...any) *Error {
	return &Error{Code: CodeNotFound, Message: fmt.Sprintf(format, args...)}
}

func invalid(fields map[string]string) *Error {
	return &Error{Code: CodeValidation, Message: "request is invalid", Fields: fields}
}

func insufficient(sku string, available int) *Error {
	return &Error{
		Code:      CodeInsufficient,
		Message:   fmt.Sprintf("insufficient stock for %s: %d available", sku, available),
		SKU:       sku,
		Available: &available,
	}
}

func isPgError(err error, code string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == code
}

const (
	pgUniqueViolation     = "23505"
	pgForeignKeyViolation = "23503"
	pgNumericOutOfRange   = "22003"
)

type Store struct {
	db *pgxpool.Pool
}

func New(db *pgxpool.Pool) *Store {
	return &Store{db: db}
}
