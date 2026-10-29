package leitura

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
	"nexoisp/api-go/internal/tenancy"
)

const pgDuePendingWithoutDatabase = "NEXO_GO_TEST_DATABASE_URL ausente; este skip não aprova PostgreSQL, RLS nem EXPLAIN. Pendente para a gerência: execução real de invoice-due em nexo_test com sessão nexo_go e papel nexo_app, uma sentença shadow sem fallback, mapa completo igual a DueBreakdown, literais de multa, juros, arredondamento, desconto, saldo, encargos e prévia, estados open, parcial, paid, reconciling e canceled, data local da transação, escopo invisível sem cmp_, e EXPLAIN natural"

var pgDueRollback = errors.New("pgdue: rollback da fixture")

var pgDueURLPattern = regexp.MustCompile(`(?i)\b(?:postgres(?:ql)?|rediss?)://\S+`)
var pgDueSecretPattern = regexp.MustCompile(`(?i)\b(password|senha|dsn)=[^\s]+`)

func pgDuePublic(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if url := os.Getenv("NEXO_GO_TEST_DATABASE_URL"); url != "" {
		text = strings.ReplaceAll(text, url, "NEXO_GO_TEST_DATABASE_URL")
	}
	text = pgDueURLPattern.ReplaceAllString(text, "postgres://redacted")
	text = pgDueSecretPattern.ReplaceAllString(text, "$1=redacted")
	return text
}

func pgDueRequireOrSkip(t *testing.T) {
	t.Helper()
	if os.Getenv("NEXO_GO_TEST_DATABASE_URL") != "" {
		return
	}
	if os.Getenv("NEXO_BALANCE_READ_PG_REQUIRED") == "1" {
		t.Fatal(pgDuePendingWithoutDatabase)
	}
	t.Skip(pgDuePendingWithoutDatabase)
}

func pgDueMetric(result string) float64 {
	metric := &dto.Metric{}
	if err := balanceReadCompare.WithLabelValues(balanceReaderInvoiceDue, result).Write(metric); err != nil || metric.GetCounter() == nil {
		return -1
	}
	return metric.GetCounter().GetValue()
}

func pgDueShadowPolicy() balanceReadPolicy {
	return balanceReadPolicy{
		Mode:     "shadow",
		Shadow:   map[string]struct{}{balanceReaderInvoiceDue: {}},
		Cut:      map[string]struct{}{},
		Variants: map[string]string{balanceReaderInvoiceDue: dueShadowSQL},
	}
}

type pgDueCase struct {
	name        string
	status      string
	amount      int
	fee         int
	discount    int
	paid        int
	dueOffset   int
	days        int
	fine        float64
	interest    float64
	remaining   float64
	preview     float64
	collectible float64
	excess      float64
}

func pgDueCases() []pgDueCase {
	return []pgDueCase{
		{name: "open", status: "open", amount: 10001, fee: 150, discount: 200, paid: 0, dueOffset: 45, days: 45, fine: 250, interest: 150, remaining: 9951, preview: 400, collectible: 9951, excess: 0},
		{name: "arredondamento", status: "open", amount: 100, fee: 0, discount: 0, paid: 0, dueOffset: 1, days: 1, fine: 3, interest: 0, remaining: 100, preview: 3, collectible: 100, excess: 0},
		{name: "parcial", status: "open", amount: 8000, fee: 100, discount: 500, paid: 250, dueOffset: 0, days: 0, fine: 0, interest: 0, remaining: 7350, preview: 100, collectible: 7350, excess: 0},
		{name: "paid", status: "paid", amount: 5000, fee: 80, discount: 0, paid: 5000, dueOffset: 45, days: 0, fine: 0, interest: 0, remaining: 80, preview: 80, collectible: 80, excess: 0},
		{name: "reconciling", status: "reconciling", amount: 1000, fee: 0, discount: 0, paid: 4000, dueOffset: 45, days: 0, fine: 0, interest: 0, remaining: 0, preview: 0, collectible: 0, excess: 3000},
		{name: "canceled", status: "canceled", amount: 1500, fee: 40, discount: 100, paid: 10, dueOffset: 45, days: 0, fine: 0, interest: 0, remaining: 1430, preview: 40, collectible: 0, excess: 0},
	}
}

func pgDueExpect(item pgDueCase, dueDate string) map[string]any {
	return map[string]any{
		"status":               item.status,
		"due_date":             dueDate,
		"amount_cents":         float64(item.amount),
		"fee_cents":            float64(item.fee),
		"discount_cents":       float64(item.discount),
		"paid_cents":           float64(item.paid),
		"remaining_cents":      item.remaining,
		"days_late":            float64(item.days),
		"fine_cents":           item.fine,
		"interest_cents":       item.interest,
		"fee_if_applied_cents": item.preview,
	}
}

type pgDueExec struct {
	tx    *db.Tx
	id    string
	calls int
	raw   jsonx.Object
}

func (e *pgDueExec) query(ctx context.Context, sql string, args ...any) ([]jsonx.Object, error) {
	e.calls++
	if e.calls != 1 {
		return nil, fmt.Errorf("pgdue: executor chamado %d vezes no ramo shadow", e.calls)
	}
	if sql != dueShadowSQL || sql == gen.Due {
		return nil, errors.New("pgdue: a sentença executada não é a variante invoice-due")
	}
	if strings.Count(sql, ";") != 1 {
		return nil, fmt.Errorf("pgdue: a variante tem %d terminadores de sentença", strings.Count(sql, ";"))
	}
	if len(args) != 1 || args[0] != e.id {
		return nil, fmt.Errorf("pgdue: argumento do executor %#v", args)
	}
	rows, err := e.tx.Objects(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	e.raw = nil
	if len(rows) == 1 {
		e.raw = append(jsonx.Object(nil), rows[0]...)
	}
	return rows, nil
}

func pgDueNumber(value any) (float64, bool) {
	switch n := value.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	default:
		return 0, false
	}
}

func pgDueOpen(t *testing.T) (*db.DB, string) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	database, err := db.Open(context.Background(), url, "force_custom_plan", 4, prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("abertura do banco recusada: %s", pgDuePublic(err))
	}
	t.Cleanup(database.Close)
	var name, sessionUser, currentUser, tenant string
	err = database.WithScope(context.Background(), tenancy.Scope{}, func(tx *db.Tx) error {
		if err := tx.QueryRow(context.Background(), `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser); err != nil {
			return err
		}
		return tx.QueryRow(context.Background(), `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	})
	if err != nil {
		t.Fatalf("identidade inicial: %s", pgDuePublic(err))
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" || tenant == "" {
		t.Fatalf("conexão fora do laboratório: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	return database, tenant
}

func pgDueAssumeApp(ctx context.Context, tx *db.Tx) error {
	var name, sessionUser, currentUser string
	var super, bypass bool
	if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&name, &sessionUser, &currentUser); err != nil {
		return err
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" {
		return fmt.Errorf("pgdue: sessão antes do papel: database=%s session_user=%s current_user=%s", name, sessionUser, currentUser)
	}
	if err := tx.Exec(ctx, `set local role nexo_app`); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user`).Scan(&name, &sessionUser, &currentUser, &super, &bypass); err != nil {
		return err
	}
	if name != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_app" || super || bypass {
		return fmt.Errorf("pgdue: escopo nexo_app recusado: database=%s session_user=%s current_user=%s super=%v bypass=%v", name, sessionUser, currentUser, super, bypass)
	}
	return nil
}

func pgDueRates(ctx context.Context, tx *db.Tx) error {
	if err := tx.Exec(ctx, `insert into tenant_settings (tenant_id, late_fee_percent, interest_monthly_percent)
		values (app_tenant(), 2.50, 1.00)
		on conflict (tenant_id) do update set late_fee_percent = excluded.late_fee_percent, interest_monthly_percent = excluded.interest_monthly_percent`); err != nil {
		return err
	}
	var fine, interest float64
	if err := tx.QueryRow(ctx, `select late_fee_percent::float8, interest_monthly_percent::float8 from tenant_settings where tenant_id = app_tenant()`).Scan(&fine, &interest); err != nil {
		return err
	}
	if fine != 2.5 || interest != 1 {
		return fmt.Errorf("pgdue: percentuais lidos fine=%v interest=%v", fine, interest)
	}
	return nil
}

func pgDueSeed(ctx context.Context, tx *db.Tx, mark string) (string, string, error) {
	var subscriber, plan, version, contract string
	if err := tx.QueryRow(ctx, `insert into subscribers (tenant_id, name) values (app_tenant(), $1) returning id::text`, mark).Scan(&subscriber); err != nil {
		return "", "", err
	}
	if err := tx.QueryRow(ctx, `insert into plans (tenant_id, name) values (app_tenant(), $1) returning id::text`, mark).Scan(&plan); err != nil {
		return "", "", err
	}
	if err := tx.QueryRow(ctx, `insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name) values (app_tenant(), $1::uuid, 1, 10001, 100000, 50000, 'pgdue') returning id::text`, plan).Scan(&version); err != nil {
		return "", "", err
	}
	if err := tx.QueryRow(ctx, `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day) values (app_tenant(), $1::uuid, $2::uuid, 15) returning id::text`, subscriber, version).Scan(&contract); err != nil {
		return "", "", err
	}
	return subscriber, contract, nil
}

func pgDueInsertInvoice(ctx context.Context, tx *db.Tx, subscriber, contract string, item pgDueCase) (string, string, error) {
	var id, due string
	err := tx.QueryRow(ctx, `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, fee_cents, discount_cents, status)
		values (app_tenant(), $1::uuid, $2::uuid, 'manual',
			(now() at time zone coalesce((select timezone from tenant_settings where tenant_id = app_tenant()), 'America/Sao_Paulo'))::date - $3::int,
			$4, $5, $6, $7)
		returning id::text, due_date::text`, contract, subscriber, item.dueOffset, item.amount, item.fee, item.discount, item.status).Scan(&id, &due)
	if err != nil {
		return "", "", err
	}
	if item.paid > 0 {
		if err = tx.Exec(ctx, `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, source) values (app_tenant(), $1::uuid, $2, now(), 'manual')`, id, item.paid); err != nil {
			return "", "", err
		}
	}
	return id, due, nil
}

func pgDueProduction(ctx context.Context, tx *db.Tx, id string) error {
	beforeMatch, beforeMiss := pgDueMetric(balanceReadMatch), pgDueMetric(balanceReadMismatch)
	variantCalls, legacyCalls := 0, 0
	got, err := dueHTTPWith(ctx, id, productionBalancePolicy(), func(context.Context, string, ...any) ([]jsonx.Object, error) {
		variantCalls++
		return nil, errors.New("pgdue: DueHTTP com flags fechadas executou a variante")
	}, func(ctx context.Context, legacyID string) (map[string]any, error) {
		legacyCalls++
		if legacyID != id {
			return nil, fmt.Errorf("pgdue: legado de produção recebeu %s", legacyID)
		}
		return DueBreakdown(ctx, tx, legacyID)
	})
	if err != nil {
		return err
	}
	served, err := DueHTTP(ctx, tx, id)
	if err != nil {
		return err
	}
	legacy, err := DueBreakdown(ctx, tx, id)
	if err != nil {
		return err
	}
	if variantCalls != 0 || legacyCalls != 1 || len(got) == 0 || !reflect.DeepEqual(got, legacy) || !reflect.DeepEqual(served, legacy) {
		return fmt.Errorf("pgdue: produção variant=%d legacy=%d got=%#v served=%#v legacy=%#v", variantCalls, legacyCalls, got, served, legacy)
	}
	for key := range served {
		if strings.HasPrefix(key, "cmp_") {
			return fmt.Errorf("pgdue: produção serviu %s", key)
		}
	}
	if pgDueMetric(balanceReadMatch) != beforeMatch || pgDueMetric(balanceReadMismatch) != beforeMiss {
		return errors.New("pgdue: produção alterou a métrica de comparação")
	}
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		return errors.New("pgdue: allowlist compilada deixou de ser vazia")
	}
	return nil
}

func pgDueShadowOne(ctx context.Context, tx *db.Tx, id string, item pgDueCase, dueDate string) error {
	if balanceVariants[balanceReaderInvoiceDue] != dueShadowSQL || strings.TrimSpace(dueShadowSQL) == "" {
		return errors.New("pgdue: registro global de invoice-due divergiu da sentença embutida")
	}
	beforeMatch, beforeMiss := pgDueMetric(balanceReadMatch), pgDueMetric(balanceReadMismatch)
	exec := &pgDueExec{tx: tx, id: id}
	legacyCalls := 0
	got, err := dueHTTPWith(ctx, id, pgDueShadowPolicy(), exec.query, func(context.Context, string) (map[string]any, error) {
		legacyCalls++
		return nil, errors.New("pgdue: ramo shadow chamou a sentença legada")
	})
	if err != nil {
		return fmt.Errorf("pgdue: %s: %w", item.name, err)
	}
	legacy, err := DueBreakdown(ctx, tx, id)
	if err != nil {
		return fmt.Errorf("pgdue: %s legado: %w", item.name, err)
	}
	want := pgDueExpect(item, dueDate)
	if exec.calls != 1 || legacyCalls != 0 || len(got) == 0 || !reflect.DeepEqual(got, want) || !reflect.DeepEqual(got, legacy) {
		return fmt.Errorf("pgdue: %s calls=%d legacyCalls=%d\ngot %#v\nwant %#v\nlegacy %#v", item.name, exec.calls, legacyCalls, got, want, legacy)
	}
	for key := range got {
		if strings.HasPrefix(key, "cmp_") {
			return fmt.Errorf("pgdue: %s serviu %s", item.name, key)
		}
	}
	if _, ok := exec.raw.Get("cmp_matches").(bool); !ok || len(exec.raw) == 0 {
		return fmt.Errorf("pgdue: %s não devolveu cmp_matches real: %#v", item.name, exec.raw)
	}
	matched := exec.raw.Get("cmp_matches").(bool)
	nominal, nominalOK := pgDueNumber(exec.raw.Get("cmp_nominal_cents"))
	collectible, collectibleOK := pgDueNumber(exec.raw.Get("cmp_collectible_cents"))
	excess, excessOK := pgDueNumber(exec.raw.Get("cmp_excess_cents"))
	if !nominalOK || !collectibleOK || !excessOK {
		return fmt.Errorf("pgdue: %s comparação sem número matches=%v nominal=%#v collectible=%#v excess=%#v", item.name, exec.raw.Get("cmp_matches"), exec.raw.Get("cmp_nominal_cents"), exec.raw.Get("cmp_collectible_cents"), exec.raw.Get("cmp_excess_cents"))
	}
	if got["amount_cents"] != float64(item.amount) || got["remaining_cents"] != item.remaining || got["fee_cents"] != float64(item.fee) || got["discount_cents"] != float64(item.discount) || got["paid_cents"] != float64(item.paid) || got["fine_cents"] != item.fine || got["interest_cents"] != item.interest || got["fee_if_applied_cents"] != item.preview {
		return fmt.Errorf("pgdue: %s recompôs centavos %#v", item.name, got)
	}
	if matched && (nominal != float64(item.amount) || collectible != item.collectible || excess != item.excess) {
		return fmt.Errorf("pgdue: %s sombra divergiu com matches verdadeiro nominal=%v collectible=%v excess=%v", item.name, nominal, collectible, excess)
	}
	matchDelta, missDelta := 0.0, 0.0
	if matched {
		matchDelta = 1
	} else {
		missDelta = 1
	}
	if pgDueMetric(balanceReadMatch)-beforeMatch != matchDelta || pgDueMetric(balanceReadMismatch)-beforeMiss != missDelta {
		return fmt.Errorf("pgdue: %s métrica match %v→%v mismatch %v→%v", item.name, beforeMatch, pgDueMetric(balanceReadMatch), beforeMiss, pgDueMetric(balanceReadMismatch))
	}
	return nil
}

func pgDueExplain(ctx context.Context, tx *db.Tx, id string) error {
	var natural bool
	if err := tx.QueryRow(ctx, `select current_setting('enable_seqscan') = 'on' and current_setting('enable_indexscan') = 'on' and current_setting('enable_bitmapscan') = 'on'`).Scan(&natural); err != nil {
		return err
	}
	if !natural {
		return errors.New("pgdue: planner não está no modo natural")
	}
	statement := strings.TrimSuffix(strings.TrimSpace(dueShadowSQL), ";")
	rows, err := tx.Objects(ctx, "explain (format text) "+statement, id)
	if err != nil {
		return err
	}
	var plan strings.Builder
	for _, row := range rows {
		for _, field := range row {
			plan.WriteString(fmt.Sprint(field.Value))
			plan.WriteByte('\n')
		}
	}
	text := plan.String()
	if strings.TrimSpace(text) == "" || !strings.Contains(strings.ToLower(text), "invoices") {
		return fmt.Errorf("pgdue: EXPLAIN natural vazio ou sem invoices: %s", text)
	}
	return nil
}

func pgDueInvisible(ctx context.Context, tx *db.Tx, id, tenant string) error {
	other := "00000000-0000-4000-8000-00000000d4e1"
	if other == tenant {
		return errors.New("pgdue: tenant da fixture coincidiu com o escopo invisível")
	}
	beforeMatch, beforeMiss := pgDueMetric(balanceReadMatch), pgDueMetric(balanceReadMismatch)
	if err := tx.Exec(ctx, `select set_config('app.tenant_id', $1, true)`, other); err != nil {
		return err
	}
	var visible int
	if err := tx.QueryRow(ctx, `select count(*) from invoices where id = $1::uuid`, id).Scan(&visible); err != nil {
		return err
	}
	exec := &pgDueExec{tx: tx, id: id}
	legacyCalls := 0
	got, err := dueHTTPWith(ctx, id, pgDueShadowPolicy(), exec.query, func(context.Context, string) (map[string]any, error) {
		legacyCalls++
		return nil, errors.New("pgdue: escopo invisível caiu na sentença legada")
	})
	var httpErr *apierr.Error
	if visible != 0 || exec.calls != 1 || legacyCalls != 0 || got != nil || !errors.As(err, &httpErr) || httpErr.Status != 404 || httpErr.Message != "fatura não encontrada" || strings.Contains(err.Error(), "cmp_") || len(exec.raw) != 0 {
		return fmt.Errorf("pgdue: invisível visible=%d calls=%d legacy=%d got=%#v raw=%#v err=%v", visible, exec.calls, legacyCalls, got, exec.raw, err)
	}
	if pgDueMetric(balanceReadMatch) != beforeMatch || pgDueMetric(balanceReadMismatch) != beforeMiss {
		return errors.New("pgdue: escopo invisível incrementou comparação")
	}
	return nil
}

func pgDueConfirmRollback(ctx context.Context, database *db.DB, tenant, mark string) error {
	return database.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
		var subscribers, invoices int
		if err := tx.QueryRow(ctx, `select count(*) from subscribers where name = $1`, mark).Scan(&subscribers); err != nil {
			return err
		}
		if err := tx.QueryRow(ctx, `select count(*) from invoices where subscriber_id in (select id from subscribers where name = $1)`, mark).Scan(&invoices); err != nil {
			return err
		}
		if subscribers != 0 || invoices != 0 {
			return fmt.Errorf("pgdue: rollback deixou subscribers=%d invoices=%d", subscribers, invoices)
		}
		return nil
	})
}

func TestBalanceReadPGDue(t *testing.T) {
	pgDueRequireOrSkip(t)
	if balanceReadDatabaseGate != "pending" {
		t.Fatal("o gate histórico deixou de ser pending")
	}
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 {
		t.Fatal("allowlist compilada não está vazia")
	}
	registered := maps.Clone(balanceVariants)
	database, tenant := pgDueOpen(t)
	ctx := context.Background()
	mark := "pgdue-" + uuid.NewString()
	err := database.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
		if err := pgDueAssumeApp(ctx, tx); err != nil {
			return err
		}
		if err := pgDueRates(ctx, tx); err != nil {
			return err
		}
		subscriber, contract, err := pgDueSeed(ctx, tx, mark)
		if err != nil {
			return err
		}
		seeded := make([]string, 0, len(pgDueCases()))
		for _, item := range pgDueCases() {
			id, due, err := pgDueInsertInvoice(ctx, tx, subscriber, contract, item)
			if err != nil {
				return fmt.Errorf("pgdue: fixture %s: %w", item.name, err)
			}
			if item.name == "open" {
				if err = pgDueProduction(ctx, tx, id); err != nil {
					return err
				}
			}
			if err = pgDueShadowOne(ctx, tx, id, item, due); err != nil {
				return err
			}
			seeded = append(seeded, id)
		}
		if len(seeded) != len(pgDueCases()) || seeded[0] == "" {
			return errors.New("pgdue: fixture vazia")
		}
		if err = pgDueExplain(ctx, tx, seeded[0]); err != nil {
			return err
		}
		if err = pgDueInvisible(ctx, tx, seeded[0], tenant); err != nil {
			return err
		}
		return pgDueRollback
	})
	if !errors.Is(err, pgDueRollback) {
		t.Fatalf("prova PostgreSQL de GET due: %s", pgDuePublic(err))
	}
	if err = pgDueConfirmRollback(ctx, database, tenant, mark); err != nil {
		t.Fatal(pgDuePublic(err))
	}
	if !maps.Equal(registered, balanceVariants) {
		t.Fatal("a prova alterou o registro global de variantes")
	}
	if len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 || balanceReadDatabaseGate != "pending" {
		t.Fatal("a prova alterou allowlist ou o gate histórico")
	}
}
