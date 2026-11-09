package jobs

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
)

// O mesmo alerta não é reenviado por outro worker (reinício ou réplica).
func TestAlertDedupSurvivesRestart(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("NEXO_GO_TEST_DATABASE_URL não definido")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	database, err := db.Open(ctx, url, "force_custom_plan", 4, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var posts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts.Add(1)
		w.WriteHeader(204)
	}))
	defer server.Close()
	t.Setenv("NEXO_DEMO_MODE", "1")
	t.Setenv("NEXO_ALERT_WEBHOOK_URL", server.URL)
	scope, err := tenancy.OperatorScope("alertas_operacionais")
	if err != nil {
		t.Fatal(err)
	}
	if err = database.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.Exec(ctx, "select nexo_alert_record('estado-anterior-sintetico')") }); err != nil {
		t.Fatal(err)
	}
	if err = (&worker{db: database}).alerts(ctx); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 1 {
		t.Fatalf("primeiro envio: %d", posts.Load())
	}
	if err = (&worker{db: database}).alerts(ctx); err != nil {
		t.Fatal(err)
	}
	if posts.Load() != 1 {
		t.Fatalf("alerta repetido após reinício: %d envios", posts.Load())
	}
	// Falha no destino não registra: o próximo ciclo tenta de novo.
	if err = database.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.Exec(ctx, "select nexo_alert_record('outro-estado-sintetico')") }); err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { posts.Add(1); w.WriteHeader(500) })
	if err = (&worker{db: database}).alerts(ctx); err == nil {
		t.Fatal("resposta 500 deveria falhar")
	}
	var last string
	if err = database.WithScope(ctx, scope, func(tx *db.Tx) error { return tx.QueryRow(ctx, "select nexo_alert_last()").Scan(&last) }); err != nil || last != "outro-estado-sintetico" {
		t.Fatalf("falha no destino não pode registrar entrega: %q %v", last, err)
	}
}
