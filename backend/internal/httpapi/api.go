// Package httpapi maps HTTP requests to store calls and store errors to the
// JSON error envelope {"error": {"code": ..., "message": ...}}.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"stockflow/internal/store"
)

type API struct {
	store *store.Store
	log   *slog.Logger
}

func New(s *store.Store, log *slog.Logger) http.Handler {
	a := &API{store: s, log: log}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/products", a.listProducts)
	mux.HandleFunc("POST /api/products", a.createProduct)
	mux.HandleFunc("GET /api/products/summary", a.summary)
	mux.HandleFunc("PUT /api/products/{id}", a.updateProduct)
	mux.HandleFunc("DELETE /api/products/{id}", a.deleteProduct)
	mux.HandleFunc("POST /api/products/{id}/stock", a.adjustStock)
	mux.HandleFunc("GET /api/products/{id}/movements", a.listMovements)
	mux.HandleFunc("GET /api/orders", a.listOrders)
	mux.HandleFunc("POST /api/orders", a.createOrder)
	mux.HandleFunc("GET /api/orders/{id}", a.getOrder)
	mux.HandleFunc("POST /api/orders/{id}/cancel", a.cancelOrder)
	mux.HandleFunc("GET /api/reports/daily-sales", a.dailySales)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		a.fail(w, r, &store.Error{Code: store.CodeNotFound, Message: "no route for " + r.Method + " " + r.URL.Path})
	})
	return a.logRequests(mux)
}

// ---- products ----

func (a *API) listProducts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	fields := map[string]string{}
	page := intParam(q.Get("page"), 1, 1, 1_000_000, "page", fields)
	limit := intParam(q.Get("limit"), 20, 1, 100, "limit", fields)
	filter := q.Get("filter")
	switch filter {
	case "", "all", "active", "inactive", "low":
	default:
		fields["filter"] = "filter must be one of all, active, inactive, low"
	}
	if len(fields) > 0 {
		a.fail(w, r, invalid(fields))
		return
	}
	products, total, err := a.store.ListProducts(r.Context(), store.ListParams{
		Search: strings.TrimSpace(q.Get("search")), Filter: filter, Page: page, Limit: limit,
	})
	if err != nil {
		a.fail(w, r, err)
		return
	}
	if products == nil {
		products = []store.Product{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": products, "page": page, "limit": limit, "total": total})
}

func (a *API) createProduct(w http.ResponseWriter, r *http.Request) {
	var in store.ProductInput
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	p, err := a.store.CreateProduct(r.Context(), in)
	a.respond(w, r, http.StatusCreated, p, err)
}

func (a *API) updateProduct(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	// A separate shape without "sku" so sending one is rejected as an unknown field.
	var in struct {
		Name     string `json:"name"`
		Price    *int   `json:"price"`
		IsActive *bool  `json:"is_active"`
	}
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	p, err := a.store.UpdateProduct(r.Context(), id, store.ProductInput{Name: in.Name, Price: in.Price, IsActive: in.IsActive})
	a.respond(w, r, http.StatusOK, p, err)
}

func (a *API) deleteProduct(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err == nil {
		err = a.store.DeleteProduct(r.Context(), id)
	}
	if err != nil {
		a.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) adjustStock(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	var in store.StockInput
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	p, err := a.store.AdjustStock(r.Context(), id, in)
	a.respond(w, r, http.StatusOK, p, err)
}

func (a *API) listMovements(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	movements, err := a.store.ListMovements(r.Context(), id)
	if movements == nil {
		movements = []store.Movement{}
	}
	a.respond(w, r, http.StatusOK, map[string]any{"data": movements}, err)
}

func (a *API) summary(w http.ResponseWriter, r *http.Request) {
	s, err := a.store.Summary(r.Context())
	a.respond(w, r, http.StatusOK, s, err)
}

// ---- orders ----

func (a *API) listOrders(w http.ResponseWriter, r *http.Request) {
	orders, err := a.store.ListOrders(r.Context())
	if orders == nil {
		orders = []store.Order{}
	}
	a.respond(w, r, http.StatusOK, map[string]any{"data": orders}, err)
}

func (a *API) createOrder(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if len(key) > 200 {
		a.fail(w, r, invalid(map[string]string{"Idempotency-Key": "must be at most 200 characters"}))
		return
	}
	var in store.OrderInput
	if err := decode(r, &in); err != nil {
		a.fail(w, r, err)
		return
	}
	order, replayed, err := a.store.CreateOrder(r.Context(), in, key)
	if replayed {
		w.Header().Set("Idempotent-Replayed", "true")
	}
	a.respond(w, r, http.StatusCreated, order, err)
}

func (a *API) getOrder(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	o, err := a.store.GetOrder(r.Context(), id)
	a.respond(w, r, http.StatusOK, o, err)
}

func (a *API) cancelOrder(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		a.fail(w, r, err)
		return
	}
	o, err := a.store.CancelOrder(r.Context(), id)
	a.respond(w, r, http.StatusOK, o, err)
}

func (a *API) dailySales(w http.ResponseWriter, r *http.Request) {
	day := time.Now().In(store.WIB)
	if d := r.URL.Query().Get("date"); d != "" {
		parsed, err := time.ParseInLocation(time.DateOnly, d, store.WIB)
		if err != nil {
			a.fail(w, r, invalid(map[string]string{"date": "date must be YYYY-MM-DD"}))
			return
		}
		day = parsed
	}
	report, err := a.store.DailySales(r.Context(), day)
	a.respond(w, r, http.StatusOK, report, err)
}

// ---- helpers ----

var statusByCode = map[string]int{
	store.CodeValidation:       http.StatusBadRequest,
	store.CodeNotFound:         http.StatusNotFound,
	store.CodeSKUExists:        http.StatusConflict,
	store.CodeHasHistory:       http.StatusConflict,
	store.CodeInsufficient:     http.StatusConflict,
	store.CodeAlreadyCancelled: http.StatusConflict,
	store.CodeIdempotencyReuse: http.StatusUnprocessableEntity,
}

func (a *API) respond(w http.ResponseWriter, r *http.Request, status int, body any, err error) {
	if err != nil {
		a.fail(w, r, err)
		return
	}
	writeJSON(w, status, body)
}

func (a *API) fail(w http.ResponseWriter, r *http.Request, err error) {
	var se *store.Error
	if errors.As(err, &se) {
		status, ok := statusByCode[se.Code]
		if !ok {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]any{"error": se})
		return
	}
	a.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]any{
		"error": store.Error{Code: "INTERNAL", Message: "internal server error"},
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func invalid(fields map[string]string) *store.Error {
	return &store.Error{Code: store.CodeValidation, Message: "request is invalid", Fields: fields}
}

// decode reads a single JSON object, rejecting unknown fields and wrong types
// with field-level messages (e.g. a price of 1.5 -> "price must be an integer").
func decode(r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	err := dec.Decode(dst)
	if err == nil && dec.Decode(&struct{}{}) != io.EOF {
		err = errors.New("body must contain a single JSON object")
	}
	if err == nil {
		return nil
	}
	var typeErr *json.UnmarshalTypeError
	switch {
	case errors.As(err, &typeErr):
		return invalid(map[string]string{typeErr.Field: typeErr.Field + " must be " + kindName(typeErr.Type)})
	case strings.HasPrefix(err.Error(), "json: unknown field "):
		name := strings.Trim(strings.TrimPrefix(err.Error(), "json: unknown field "), `"`)
		return invalid(map[string]string{name: name + " is not allowed here"})
	case errors.Is(err, io.EOF):
		return &store.Error{Code: store.CodeValidation, Message: "request body is required"}
	default:
		return &store.Error{Code: store.CodeValidation, Message: "malformed JSON: " + err.Error()}
	}
}

func kindName(t reflect.Type) string {
	switch t.Kind() {
	case reflect.Int, reflect.Int32, reflect.Int64:
		return "an integer"
	case reflect.String:
		return "a string"
	case reflect.Bool:
		return "a boolean"
	case reflect.Slice:
		return "an array"
	default:
		return "a " + t.Kind().String()
	}
}

func pathID(r *http.Request) (int, error) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil || id <= 0 {
		return 0, invalid(map[string]string{"id": "id must be a positive integer"})
	}
	return id, nil
}

func intParam(raw string, def, min, max int, name string, fields map[string]string) int {
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < min || n > max {
		fields[name] = fmt.Sprintf("%s must be an integer between %d and %d", name, min, max)
		return def
	}
	return n
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (a *API) logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		a.log.Info("http", "method", r.Method, "path", r.URL.Path, "status", rec.status, "dur", time.Since(start).Round(time.Microsecond))
	})
}
