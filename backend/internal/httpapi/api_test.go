package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"stockflow/internal/store"
)

// Checks the wire contract the frontend depends on: status codes and the
// {"error": {...}} envelope, end to end through the real handler and database.
func TestErrorEnvelope(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://stockflow:stockflow@localhost:5433/stockflow"
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err == nil {
		err = pool.Ping(context.Background())
	}
	if err != nil {
		t.Fatalf("postgres not reachable (run `docker compose up -d db`): %v", err)
	}
	defer pool.Close()
	srv := httptest.NewServer(New(store.New(pool), slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer srv.Close()

	call := func(method, path, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out map[string]any
		_ = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}

	sku := fmt.Sprintf("H%d", time.Now().UnixNano())
	status, product := call("POST", "/api/products", fmt.Sprintf(`{"sku":%q,"name":"HTTP test","price":1500}`, sku))
	if status != http.StatusCreated {
		t.Fatalf("create: want 201, got %d %v", status, product)
	}
	id := int(product["id"].(float64))
	call("POST", fmt.Sprintf("/api/products/%d/stock", id), `{"type":"in","qty":2}`)

	status, body := call("POST", "/api/orders", fmt.Sprintf(`{"customer":"X","items":[{"sku":%q,"qty":5}]}`, sku))
	errObj, _ := body["error"].(map[string]any)
	if status != http.StatusConflict || errObj["code"] != "INSUFFICIENT_STOCK" || errObj["sku"] != sku || errObj["available"] != float64(2) {
		t.Errorf("insufficient order: got %d %v", status, body)
	}

	status, body = call("POST", "/api/products", `{"sku":"Z","name":"Z","price":1.5}`)
	errObj, _ = body["error"].(map[string]any)
	fields, _ := errObj["fields"].(map[string]any)
	if status != http.StatusBadRequest || fields["price"] == nil {
		t.Errorf("float price: got %d %v", status, body)
	}

	status, body = call("DELETE", fmt.Sprintf("/api/products/%d", id), "")
	errObj, _ = body["error"].(map[string]any)
	if status != http.StatusConflict || errObj["code"] != "PRODUCT_HAS_HISTORY" {
		t.Errorf("delete with history: got %d %v", status, body)
	}

	if status, _ = call("PUT", "/api/products/999999999", `{"name":"x","price":1}`); status != http.StatusNotFound {
		t.Errorf("update missing: want 404, got %d", status)
	}
}
