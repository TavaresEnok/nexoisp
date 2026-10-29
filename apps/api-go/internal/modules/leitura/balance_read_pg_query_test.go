package leitura

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/leitura/gen"
	"nexoisp/api-go/internal/tenancy"
)

// Drift injetado não é executado neste arquivo. Essa prova continua no contrato
// financeiro existente. A constante balanceReadDatabaseGate permanece histórica:
// skip e esta suíte não a promovem.

var pgQueryRollback = errors.New("pgQuery rollback da fixture sintética")

type pgQueryCase struct {
	name        string
	status      string
	nominal     int64
	fee         int64
	discount    int64
	payAmount   int64
	reversal    bool
	received    int64
	residual    int64
	excess      int64
	collectible int64
	matches     bool
	invoiceID   string
}

// pgQueryExplainVolume é o mínimo de faturas, movimentos e pagamentos extras
// na mesma transação do EXPLAIN. Numa tabela de uma página o custo do Seq Scan
// fica perto de 1 e o do Index Scan perto de 8; o planner então ignora
// invoice_movements_invoice e payments_invoice. O volume torna essa escolha
// natural, sem enable_seqscan=off nem outro forçamento.
const pgQueryExplainVolume = 4096

type pgQueryFixture struct {
	tenant          string
	alienTenant     string
	ownerSubscriber string
	alienSubscriber string
	homePop         string
	alienPop        string
	contract        string
	cases           []pgQueryCase
}

type pgQueryRelationStat struct {
	rows     int
	pages    int
	relpages int
	tuples   int64
}

func TestBalanceReadPGDedicatedSQLNotView(t *testing.T) {
	sqlText := strings.ToLower(gen.BalanceShadowCompare)
	if strings.Contains(sqlText, "financial_balance_shadow") {
		t.Fatal("gen.BalanceShadowCompare lê a view")
	}
	for _, piece := range []string{
		"from invoices i",
		"left join lateral",
		"from invoice_movements mv",
		"mv.tenant_id = i.tenant_id",
		"mv.invoice_id = i.id",
		"from payments py",
		"py.invoice_id = i.id",
		"py.tenant_id = i.tenant_id",
		"where i.id = any($1::uuid[])",
		"is true as matches",
		"as residual_cents",
		"as excess_cents",
		"as collectible_cents",
	} {
		if !strings.Contains(sqlText, piece) {
			t.Fatalf("consulta dedicada sem %s", piece)
		}
	}
	if balanceReadDatabaseGate != "pending" {
		t.Fatal("a constante histórica do gate foi alterada por esta frente")
	}
	t.Log("checagem estática de gen.BalanceShadowCompare; não executa PostgreSQL nem EXPLAIN e não aprova o gate")
}

func TestBalanceReadPGFixturesOracleAndRLS(t *testing.T) {
	pgQueryWithFixture(t, func(ctx context.Context, tx *db.Tx, fx pgQueryFixture) error {
		if err := pgQueryCompare(ctx, tx, fx); err != nil {
			return err
		}
		return pgQueryRLS(ctx, tx, fx)
	})
}

func TestBalanceReadPGExplain(t *testing.T) {
	pgQueryWithFixture(t, func(ctx context.Context, tx *db.Tx, fx pgQueryFixture) error {
		if err := pgQuerySeedVolume(ctx, tx, fx); err != nil {
			return err
		}
		return pgQueryExplain(t, ctx, tx, fx)
	})
}

func pgQueryDatabase(t *testing.T) (*db.DB, tenancy.Scope) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_BALANCE_READ_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_BALANCE_READ_PG_REQUIRED=1; PostgreSQL, RLS e EXPLAIN não foram executados")
		}
		t.Skip("NEXO_GO_TEST_DATABASE_URL ausente; skip de integração sem banco. Não aprova SQL, RLS nem EXPLAIN. Pendente: a gerência executa tests/contrato/go_integration.py, que prepara nexo_test e exporta a URL do usuário nexo_go.")
	}
	ctx := context.Background()
	opened, err := db.Open(ctx, url, "force_custom_plan", 4, prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("db.Open falhou com URL presente; skip não se aplica. %s", pgQueryRedact(err))
	}
	t.Cleanup(opened.Close)
	var tenant string
	if err = opened.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	}); err != nil {
		t.Fatalf("nexo_go_directory: %s", pgQueryRedact(err))
	}
	if tenant == "" {
		t.Fatal("nexo_go_directory não devolveu tenant")
	}
	return opened, tenancy.Scope{TenantID: tenant}
}

func pgQueryWithFixture(t *testing.T, fn func(context.Context, *db.Tx, pgQueryFixture) error) {
	t.Helper()
	opened, scope := pgQueryDatabase(t)
	ctx := context.Background()
	var fx pgQueryFixture
	err := opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		var roleErr error
		fx, roleErr = pgQueryPrepare(ctx, tx, scope)
		if roleErr != nil {
			return roleErr
		}
		if err := fn(ctx, tx, fx); err != nil {
			return err
		}
		return pgQueryRollback
	})
	var residue error
	if len(pgQueryIDs(fx)) > 0 || fx.contract != "" {
		residue = pgQueryAssertRolledBack(ctx, opened, scope, fx)
	}
	if !errors.Is(err, pgQueryRollback) {
		t.Fatal(pgQueryRedact(err))
	}
	if residue != nil {
		t.Fatal(pgQueryRedact(residue))
	}
}

func pgQueryAssumeApp(ctx context.Context, tx *db.Tx, scope tenancy.Scope) error {
	var database, sessionUser, currentUser string
	if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&database, &sessionUser, &currentUser); err != nil {
		return err
	}
	if database != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_go" {
		return fmt.Errorf("conexão fora do contrato antes do papel nexo_app: database=%s session_user=%s current_user=%s", database, sessionUser, currentUser)
	}
	if err := tx.Exec(ctx, `set local role nexo_app`); err != nil {
		return fmt.Errorf("set local role nexo_app: %w", err)
	}
	if err := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&database, &sessionUser, &currentUser); err != nil {
		return err
	}
	if database != "nexo_test" || sessionUser != "nexo_go" || currentUser != "nexo_app" {
		return fmt.Errorf("escopo nexo_app divergente: database=%s session_user=%s current_user=%s", database, sessionUser, currentUser)
	}
	var seqscan, tenant string
	if err := tx.QueryRow(ctx, `select current_setting('enable_seqscan'), app_tenant()::text`).Scan(&seqscan, &tenant); err != nil {
		return err
	}
	if seqscan != "on" {
		return fmt.Errorf("enable_seqscan=%s; a prova não altera o planner", seqscan)
	}
	if tenant != scope.TenantID {
		return fmt.Errorf("app_tenant divergente do tenant dono")
	}
	return nil
}

func pgQueryPrepare(ctx context.Context, tx *db.Tx, scope tenancy.Scope) (pgQueryFixture, error) {
	var alien string
	if err := tx.QueryRow(ctx, `select coalesce((select tenant_id::text from nexo_go_directory() where tenant_id::text <> $1 order by tenant_id limit 1), '')`, scope.TenantID).Scan(&alien); err != nil {
		return pgQueryFixture{}, err
	}
	if alien == "" {
		alien = uuid.NewString()
	}
	if err := pgQueryAssumeApp(ctx, tx, scope); err != nil {
		return pgQueryFixture{}, err
	}
	return pgQuerySeed(ctx, tx, scope.TenantID, alien)
}

func pgQuerySeed(ctx context.Context, tx *db.Tx, tenant, alienTenant string) (pgQueryFixture, error) {
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	var ownerSubscriber, alienSubscriber, homePop, alienPop, plan, version, contract string
	if err := tx.QueryRow(ctx, `insert into subscribers(tenant_id, name) values (app_tenant(), $1) returning id::text`, "pgQuery titular "+suffix).Scan(&ownerSubscriber); err != nil {
		return pgQueryFixture{}, err
	}
	if err := tx.QueryRow(ctx, `insert into subscribers(tenant_id, name) values (app_tenant(), $1) returning id::text`, "pgQuery assinante alheio "+suffix).Scan(&alienSubscriber); err != nil {
		return pgQueryFixture{}, err
	}
	if err := tx.QueryRow(ctx, `insert into pops(tenant_id, name) values (app_tenant(), $1) returning id::text`, "pgQuery POP casa "+suffix).Scan(&homePop); err != nil {
		return pgQueryFixture{}, err
	}
	if err := tx.QueryRow(ctx, `insert into pops(tenant_id, name) values (app_tenant(), $1) returning id::text`, "pgQuery POP alheio "+suffix).Scan(&alienPop); err != nil {
		return pgQueryFixture{}, err
	}
	if err := tx.QueryRow(ctx, `insert into plans(tenant_id, name) values (app_tenant(), $1) returning id::text`, "pgQuery plano "+suffix).Scan(&plan); err != nil {
		return pgQueryFixture{}, err
	}
	if err := tx.QueryRow(ctx, `insert into plan_versions(tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name) values (app_tenant(), $1, 1, 10000, 102400, 51200, 'pgquery') returning id::text`, plan).Scan(&version); err != nil {
		return pgQueryFixture{}, err
	}
	if err := tx.QueryRow(ctx, `insert into contracts(tenant_id, subscriber_id, plan_version_id, due_day, pop_id) values (app_tenant(), $1, $2, 10, $3) returning id::text`, ownerSubscriber, version, homePop).Scan(&contract); err != nil {
		return pgQueryFixture{}, err
	}
	cases := []pgQueryCase{
		{name: "open", status: "open", nominal: 10000, fee: 0, discount: 0, payAmount: 0, received: 0, residual: 10000, excess: 0, collectible: 10000, matches: true},
		{name: "paid", status: "paid", nominal: 20000, fee: 500, discount: 0, payAmount: 20500, received: 20500, residual: 0, excess: 0, collectible: 0, matches: true},
		{name: "reconciling", status: "reconciling", nominal: 30000, fee: 1000, discount: 200, payAmount: 5000, received: 5000, residual: 25800, excess: 0, collectible: 25800, matches: true},
		{name: "canceled", status: "canceled", nominal: 40000, fee: 800, discount: 300, payAmount: 1000, received: 1000, residual: 39500, excess: 0, collectible: 0, matches: true},
		{name: "partial", status: "open", nominal: 50000, fee: 0, discount: 1000, payAmount: 15000, received: 15000, residual: 34000, excess: 0, collectible: 34000, matches: true},
		{name: "excess", status: "paid", nominal: 8000, fee: 0, discount: 0, payAmount: 9500, received: 9500, residual: 0, excess: 1500, collectible: 0, matches: true},
		{name: "reversal", status: "open", nominal: 15000, fee: 250, discount: 0, payAmount: 15000, reversal: true, received: 0, residual: 15250, excess: 0, collectible: 15250, matches: true},
	}
	for i := range cases {
		item := &cases[i]
		if err := tx.QueryRow(ctx, `insert into invoices(tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, fee_cents, discount_cents, status) values (app_tenant(), $1, $2, 'manual', date '2026-11-20', $3, $4, $5, $6) returning id::text`, contract, ownerSubscriber, item.nominal, item.fee, item.discount, item.status).Scan(&item.invoiceID); err != nil {
			return pgQueryFixture{}, fmt.Errorf("caso %s fatura: %w", item.name, err)
		}
		if item.payAmount == 0 {
			continue
		}
		var paymentID string
		if err := tx.QueryRow(ctx, `insert into payments(tenant_id, invoice_id, amount_cents, paid_at, source) values (app_tenant(), $1, $2, timestamptz '2026-10-15 15:00:00+00', 'manual') returning id::text`, item.invoiceID, item.payAmount).Scan(&paymentID); err != nil {
			return pgQueryFixture{}, fmt.Errorf("caso %s pagamento: %w", item.name, err)
		}
		if !item.reversal {
			continue
		}
		if err := tx.Exec(ctx, `insert into payments(tenant_id, invoice_id, amount_cents, paid_at, source, kind, reversal_of) values (app_tenant(), $1, $2, timestamptz '2026-10-16 15:00:00+00', 'manual', 'reversal', $3)`, item.invoiceID, item.payAmount, paymentID); err != nil {
			return pgQueryFixture{}, fmt.Errorf("caso %s estorno: %w", item.name, err)
		}
	}
	return pgQueryFixture{
		tenant: tenant, alienTenant: alienTenant,
		ownerSubscriber: ownerSubscriber, alienSubscriber: alienSubscriber,
		homePop: homePop, alienPop: alienPop, contract: contract, cases: cases,
	}, nil
}

func pgQuerySeedVolume(ctx context.Context, tx *db.Tx, fx pgQueryFixture) error {
	invoices, err := tx.Affected(ctx, `insert into invoices(tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, fee_cents, discount_cents, status)
select app_tenant(), $1::uuid, $2::uuid, 'manual', date '2026-12-01', 100, 0, 0, 'open'
from generate_series(1, $3::int)`, fx.contract, fx.ownerSubscriber, pgQueryExplainVolume)
	if err != nil {
		return fmt.Errorf("volume sintético do EXPLAIN, faturas: %w", err)
	}
	payments, err := tx.Affected(ctx, `insert into payments(tenant_id, invoice_id, amount_cents, paid_at, source)
select app_tenant(), id, 100, timestamptz '2026-10-15 15:00:00+00', 'manual'
from invoices
where contract_id = $1::uuid and due_date = date '2026-12-01'`, fx.contract)
	if err != nil {
		return fmt.Errorf("volume sintético do EXPLAIN, pagamentos: %w", err)
	}
	if invoices != pgQueryExplainVolume || payments != pgQueryExplainVolume {
		return fmt.Errorf("volume sintético incompleto: faturas=%d pagamentos=%d, esperado %d", invoices, payments, pgQueryExplainVolume)
	}
	var movements int
	if err := tx.QueryRow(ctx, `select count(*)::int from invoice_movements where invoice_id in (select id from invoices where contract_id = $1::uuid and due_date = date '2026-12-01')`, fx.contract).Scan(&movements); err != nil {
		return err
	}
	if movements < pgQueryExplainVolume {
		return fmt.Errorf("volume sintético sem movimentos do gatilho: movimentos=%d faturas=%d", movements, invoices)
	}
	return nil
}

func pgQueryIDs(fx pgQueryFixture) []string {
	ids := make([]string, 0, len(fx.cases))
	for _, item := range fx.cases {
		if item.invoiceID != "" {
			ids = append(ids, item.invoiceID)
		}
	}
	return ids
}

func pgQueryCompare(ctx context.Context, tx *db.Tx, fx pgQueryFixture) error {
	if strings.Contains(strings.ToLower(gen.BalanceShadowCompare), "financial_balance_shadow") {
		return errors.New("caminho observado lê financial_balance_shadow")
	}
	ids := pgQueryIDs(fx)
	rows, err := tx.Objects(ctx, gen.BalanceShadowCompare, ids)
	if err != nil {
		return fmt.Errorf("gen.BalanceShadowCompare: %w", err)
	}
	byID, err := pgQueryIndexRows(rows)
	if err != nil {
		return err
	}
	if len(byID) != len(fx.cases) {
		return fmt.Errorf("consulta dedicada devolveu %d linhas para %d faturas", len(byID), len(fx.cases))
	}
	counts := map[string]int{}
	statusCounts := map[string]int{}
	var partials, excesses int
	for _, item := range fx.cases {
		counts[item.name]++
		row, ok := byID[item.invoiceID]
		if !ok {
			return fmt.Errorf("caso %s id %s ausente na consulta dedicada", item.name, item.invoiceID)
		}
		if err := pgQueryExpectRow(item, row); err != nil {
			return err
		}
		status, err := pgQueryText(row.Get("status"), item.name+" status")
		if err != nil {
			return err
		}
		statusCounts[status]++
		excess, err := pgQueryCents(row.Get("excess_cents"), item.name+" excess_cents")
		if err != nil {
			return err
		}
		received, err := pgQueryCents(row.Get("received_cents"), item.name+" received_cents")
		if err != nil {
			return err
		}
		residual, err := pgQueryCents(row.Get("residual_cents"), item.name+" residual_cents")
		if err != nil {
			return err
		}
		if excess > 0 {
			excesses++
		}
		if status == "open" && received > 0 && residual > 0 && excess == 0 {
			partials++
		}
	}
	for _, name := range []string{"open", "paid", "reconciling", "canceled", "partial", "excess", "reversal"} {
		if counts[name] == 0 {
			return fmt.Errorf("estado %s com quantidade zero na fixture", name)
		}
	}
	for _, status := range []string{"open", "paid", "reconciling", "canceled"} {
		if statusCounts[status] == 0 {
			return fmt.Errorf("status %s com quantidade zero na consulta", status)
		}
	}
	if partials == 0 || excesses == 0 {
		return fmt.Errorf("parcial=%d excesso=%d na consulta dedicada", partials, excesses)
	}
	var movements, payments, reversals int
	if err := tx.QueryRow(ctx, `select count(*)::int, (select count(*)::int from payments where invoice_id = any($1::uuid[])), (select count(*)::int from payments where invoice_id = any($1::uuid[]) and kind = 'reversal') from invoice_movements where invoice_id = any($1::uuid[])`, ids).Scan(&movements, &payments, &reversals); err != nil {
		return err
	}
	if movements == 0 || payments == 0 || reversals == 0 {
		return fmt.Errorf("fixture sem linhas reais: movimentos=%d pagamentos=%d estornos=%d", movements, payments, reversals)
	}
	oracle, err := tx.Objects(ctx, pgQueryOracleSQL, ids)
	if err != nil {
		return fmt.Errorf("oráculo financial_balance_shadow: %w", err)
	}
	oracleByID, err := pgQueryIndexRows(oracle)
	if err != nil {
		return fmt.Errorf("oráculo: %w", err)
	}
	if len(oracleByID) != len(byID) {
		return fmt.Errorf("oráculo devolveu %d linhas e a consulta dedicada %d", len(oracleByID), len(byID))
	}
	for id, row := range byID {
		other, ok := oracleByID[id]
		if !ok {
			return fmt.Errorf("oráculo sem a fatura %s", id)
		}
		for _, field := range pgQueryCompareFields {
			if err := pgQuerySame(id, field, row.Get(field), other.Get(field)); err != nil {
				return err
			}
		}
	}
	emptyIDs := make([]string, 0)
	empty, err := tx.Objects(ctx, gen.BalanceShadowCompare, emptyIDs)
	if err != nil {
		return fmt.Errorf("consulta com ids vazios: %w", err)
	}
	if len(empty) != 0 {
		return fmt.Errorf("ids vazios devolveram %d linhas", len(empty))
	}
	missing, err := tx.Objects(ctx, gen.BalanceShadowCompare, []string{uuid.NewString()})
	if err != nil {
		return fmt.Errorf("consulta com id invisível: %w", err)
	}
	if len(missing) != 0 {
		return fmt.Errorf("id inexistente devolveu %d linhas", len(missing))
	}
	return nil
}

func pgQueryRLS(ctx context.Context, tx *db.Tx, fx pgQueryFixture) error {
	ids := pgQueryIDs(fx)
	owner, err := pgQueryVisible(ctx, tx, ids)
	if err != nil {
		return err
	}
	if owner == 0 {
		return errors.New("controle do tenant dono enxergou 0 faturas")
	}
	if owner != len(ids) {
		return fmt.Errorf("controle viu %d faturas; a fixture tem %d", owner, len(ids))
	}
	checks := []struct {
		name       string
		tenant     string
		subscriber string
		pops       string
		want       int
	}{
		{name: "assinante titular", tenant: fx.tenant, subscriber: fx.ownerSubscriber, want: len(ids)},
		{name: "pop da casa", tenant: fx.tenant, pops: fx.homePop, want: len(ids)},
		{name: "tenant alheio", tenant: fx.alienTenant, want: 0},
		{name: "assinante alheio", tenant: fx.tenant, subscriber: fx.alienSubscriber, want: 0},
		{name: "pop alheio", tenant: fx.tenant, pops: fx.alienPop, want: 0},
	}
	for _, check := range checks {
		if err := pgQuerySetScope(ctx, tx, check.tenant, check.subscriber, check.pops); err != nil {
			return err
		}
		seen, err := pgQueryVisible(ctx, tx, ids)
		if err != nil {
			return fmt.Errorf("%s: %w", check.name, err)
		}
		if seen != check.want {
			return fmt.Errorf("%s viu %d faturas da fixture; esperado %d", check.name, seen, check.want)
		}
	}
	if err := pgQuerySetScope(ctx, tx, fx.tenant, "", ""); err != nil {
		return err
	}
	restored, err := pgQueryVisible(ctx, tx, ids)
	if err != nil {
		return err
	}
	if restored == 0 {
		return errors.New("controle após os escopos negativos enxergou 0 faturas")
	}
	return nil
}

func pgQueryExplain(t *testing.T, ctx context.Context, tx *db.Tx, fx pgQueryFixture) error {
	t.Helper()
	var paid string
	for _, item := range fx.cases {
		if item.name == "paid" {
			paid = item.invoiceID
		}
	}
	if paid == "" {
		return errors.New("fixture sem o caso paid")
	}
	var movements, payments int
	if err := tx.QueryRow(ctx, `select (select count(*)::int from invoice_movements where invoice_id = $1), (select count(*)::int from payments where invoice_id = $1)`, paid).Scan(&movements, &payments); err != nil {
		return err
	}
	if movements == 0 || payments == 0 {
		return fmt.Errorf("fatura paid não é representativa: movimentos=%d pagamentos=%d", movements, payments)
	}
	page := pgQueryIDs(fx)
	var pageMovements, pagePayments int
	if err := tx.QueryRow(ctx, `select (select count(*)::int from invoice_movements where invoice_id = any($1::uuid[])), (select count(*)::int from payments where invoice_id = any($1::uuid[]))`, page).Scan(&pageMovements, &pagePayments); err != nil {
		return err
	}
	if pageMovements == 0 || pagePayments == 0 {
		return fmt.Errorf("página não é representativa: movimentos=%d pagamentos=%d", pageMovements, pagePayments)
	}
	moveStat, payStat, err := pgQueryRelationStats(ctx, tx)
	if err != nil {
		return err
	}
	if moveStat.rows < pgQueryExplainVolume || payStat.rows < pgQueryExplainVolume || moveStat.pages < 16 || payStat.pages < 16 {
		return fmt.Errorf("fixture do EXPLAIN não é representativa: invoice_movements linhas=%d paginas=%d relpages=%d; payments linhas=%d paginas=%d relpages=%d; gate de EXPLAIN permanece pendente", moveStat.rows, moveStat.pages, moveStat.relpages, payStat.rows, payStat.pages, payStat.relpages)
	}
	var seqscan, planCache string
	if err := tx.QueryRow(ctx, `select current_setting('enable_seqscan'), current_setting('plan_cache_mode')`).Scan(&seqscan, &planCache); err != nil {
		return err
	}
	if seqscan != "on" {
		return fmt.Errorf("enable_seqscan=%s; EXPLAIN natural recusado", seqscan)
	}
	onePlan, err := pgQueryRunExplain(ctx, tx, []string{paid})
	if err != nil {
		return fmt.Errorf("explain da fatura: %w", err)
	}
	pagePlan, err := pgQueryRunExplain(ctx, tx, page)
	if err != nil {
		return fmt.Errorf("explain da página: %w", err)
	}
	t.Logf("pgQuery EXPLAIN caso=paid invoice_id=%s movimentos_fatura=%d pagamentos_fatura=%d enable_seqscan=%s plan_cache_mode=%s %s %s plano=%s", paid, movements, payments, seqscan, planCache, pgQueryStatLog(moveStat, payStat), pgQueryPlanStats(onePlan), string(onePlan))
	t.Logf("pgQuery EXPLAIN caso=pagina ids=%s movimentos_pagina=%d pagamentos_pagina=%d enable_seqscan=%s plan_cache_mode=%s %s %s plano=%s", strings.Join(page, ","), pageMovements, pagePayments, seqscan, planCache, pgQueryStatLog(moveStat, payStat), pgQueryPlanStats(pagePlan), string(pagePlan))
	if err := pgQueryProvePlan(onePlan, "fatura", []string{paid}); err != nil {
		return fmt.Errorf("%w; %s", err, pgQueryStatLog(moveStat, payStat))
	}
	if err := pgQueryProvePlan(pagePlan, "pagina", page); err != nil {
		return fmt.Errorf("%w; %s", err, pgQueryStatLog(moveStat, payStat))
	}
	return nil
}

func pgQueryRelationStats(ctx context.Context, tx *db.Tx) (movements, payments pgQueryRelationStat, err error) {
	err = tx.QueryRow(ctx, `select
  (select count(*)::int from invoice_movements),
  (select coalesce(max(substring(ctid::text from '^\((\d+)')::int), -1) + 1 from invoice_movements),
  (select relpages from pg_class where oid = 'public.invoice_movements'::regclass),
  (select reltuples::bigint from pg_class where oid = 'public.invoice_movements'::regclass),
  (select count(*)::int from payments),
  (select coalesce(max(substring(ctid::text from '^\((\d+)')::int), -1) + 1 from payments),
  (select relpages from pg_class where oid = 'public.payments'::regclass),
  (select reltuples::bigint from pg_class where oid = 'public.payments'::regclass)`).Scan(
		&movements.rows, &movements.pages, &movements.relpages, &movements.tuples,
		&payments.rows, &payments.pages, &payments.relpages, &payments.tuples)
	return movements, payments, err
}

func pgQueryStatLog(movements, payments pgQueryRelationStat) string {
	return fmt.Sprintf("invoice_movements linhas=%d paginas_ctid=%d relpages=%d reltuples=%d payments linhas=%d paginas_ctid=%d relpages=%d reltuples=%d volume_minimo=%d", movements.rows, movements.pages, movements.relpages, movements.tuples, payments.rows, payments.pages, payments.relpages, payments.tuples, pgQueryExplainVolume)
}

func pgQueryRunExplain(ctx context.Context, tx *db.Tx, ids []string) ([]byte, error) {
	statement := "explain (analyze, buffers, format json) " + gen.BalanceShadowCompare
	if strings.Contains(strings.ToLower(statement), "financial_balance_shadow") || strings.Contains(strings.ToLower(statement), "enable_seqscan") {
		return nil, errors.New("explain não usa a consulta dedicada natural")
	}
	var plan []byte
	if err := tx.QueryRow(ctx, statement, ids).Scan(&plan); err != nil {
		return nil, err
	}
	return plan, nil
}

func pgQueryProvePlan(raw []byte, label string, ids []string) error {
	moveCond, payCond, err := pgQueryIndexConds(raw)
	if err != nil {
		return fmt.Errorf("plano %s ilegível: %w; ids=%s plano=%s", label, err, strings.Join(ids, ","), string(raw))
	}
	var missing []string
	if !pgQueryCondHas(moveCond, "invoice_id") || !pgQueryCondHas(moveCond, "tenant_id") {
		missing = append(missing, "invoice_movements_invoice com filtro correlacionado")
	}
	if !pgQueryCondHas(payCond, "invoice_id") || !pgQueryCondHas(payCond, "tenant_id") {
		missing = append(missing, "payments_invoice com filtro correlacionado")
	}
	if len(missing) > 0 {
		return fmt.Errorf("plano natural de %s ids=%s não provou %s; gate de EXPLAIN permanece pendente; enable_seqscan não foi alterado; plano=%s", label, strings.Join(ids, ","), strings.Join(missing, "; "), string(raw))
	}
	return nil
}

func pgQueryIndexConds(raw []byte) (movements, payments string, err error) {
	var docs []any
	if err = json.Unmarshal(raw, &docs); err != nil {
		return "", "", err
	}
	var walk func(any)
	walk = func(node any) {
		switch value := node.(type) {
		case map[string]any:
			if name, _ := value["Index Name"].(string); name == "invoice_movements_invoice" || name == "payments_invoice" {
				cond := strings.Join([]string{pgQueryPlanString(value["Index Cond"]), pgQueryPlanString(value["Filter"]), pgQueryPlanString(value["Recheck Cond"])}, " ")
				if name == "invoice_movements_invoice" {
					movements = strings.TrimSpace(movements + " " + cond)
				} else {
					payments = strings.TrimSpace(payments + " " + cond)
				}
			}
			for _, child := range value {
				walk(child)
			}
		case []any:
			for _, child := range value {
				walk(child)
			}
		}
	}
	walk(docs)
	return movements, payments, nil
}

func pgQueryPlanString(value any) string {
	text, _ := value.(string)
	return text
}

func pgQueryCondHas(cond, piece string) bool {
	return strings.Contains(strings.ToLower(cond), piece)
}

func pgQueryPlanStats(raw []byte) string {
	var docs []map[string]any
	if json.Unmarshal(raw, &docs) != nil || len(docs) == 0 {
		return "estatisticas=indisponiveis"
	}
	root, _ := docs[0]["Plan"].(map[string]any)
	return fmt.Sprintf("planning_ms=%v execution_ms=%v shared_hit=%v shared_read=%v", docs[0]["Planning Time"], docs[0]["Execution Time"], root["Shared Hit Blocks"], root["Shared Read Blocks"])
}

func pgQueryVisible(ctx context.Context, tx *db.Tx, ids []string) (int, error) {
	rows, err := tx.Objects(ctx, gen.BalanceShadowCompare, ids)
	if err != nil {
		return 0, err
	}
	var invoices int
	if err := tx.QueryRow(ctx, `select count(*)::int from invoices where id = any($1::uuid[])`, ids).Scan(&invoices); err != nil {
		return 0, err
	}
	if invoices != len(rows) {
		return 0, fmt.Errorf("consulta dedicada devolveu %d e invoices visíveis %d", len(rows), invoices)
	}
	return invoices, nil
}

func pgQuerySetScope(ctx context.Context, tx *db.Tx, tenant, subscriber, pops string) error {
	return tx.Exec(ctx, `select set_config('app.tenant_id', $1, true), set_config('app.subscriber_id', $2, true), set_config('app.pop_ids', $3, true), set_config('app.is_operator', 'off', true)`, tenant, subscriber, pops)
}

func pgQueryAssertRolledBack(ctx context.Context, opened *db.DB, scope tenancy.Scope, fx pgQueryFixture) error {
	return opened.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := pgQueryAssumeApp(ctx, tx, scope); err != nil {
			return err
		}
		ids := pgQueryIDs(fx)
		subscribers := []string{fx.ownerSubscriber, fx.alienSubscriber}
		var invoices, movements, payments, contractInvoices, subscriberRows int
		if err := tx.QueryRow(ctx, `select
  (select count(*)::int from invoices where id = any($1::uuid[])),
  (select count(*)::int from invoice_movements where invoice_id = any($1::uuid[])),
  (select count(*)::int from payments where invoice_id = any($1::uuid[])),
  (select count(*)::int from invoices where contract_id = $2::uuid),
  (select count(*)::int from subscribers where id = any($3::uuid[]))`, ids, fx.contract, subscribers).Scan(&invoices, &movements, &payments, &contractInvoices, &subscriberRows); err != nil {
			return err
		}
		if invoices != 0 || movements != 0 || payments != 0 || contractInvoices != 0 || subscriberRows != 0 {
			return fmt.Errorf("rollback deixou invoices=%d movimentos=%d pagamentos=%d faturas_contrato=%d assinantes=%d", invoices, movements, payments, contractInvoices, subscriberRows)
		}
		return nil
	})
}

func pgQueryIndexRows(rows []jsonx.Object) (map[string]jsonx.Object, error) {
	out := make(map[string]jsonx.Object, len(rows))
	for _, row := range rows {
		id, err := pgQueryText(row.Get("invoice_id"), "invoice_id")
		if err != nil {
			return nil, err
		}
		if _, exists := out[id]; exists {
			return nil, fmt.Errorf("fatura duplicada %s", id)
		}
		out[id] = row
	}
	return out, nil
}

func pgQueryExpectRow(item pgQueryCase, row jsonx.Object) error {
	checks := []struct {
		field string
		cents int64
	}{
		{"nominal_cents", item.nominal},
		{"fee_cents", item.fee},
		{"discount_cents", item.discount},
		{"received_cents", item.received},
		{"legacy_nominal_cents", item.nominal},
		{"legacy_fee_cents", item.fee},
		{"legacy_discount_cents", item.discount},
		{"legacy_received_cents", item.received},
		{"residual_cents", item.residual},
		{"excess_cents", item.excess},
		{"collectible_cents", item.collectible},
	}
	for _, check := range checks {
		got, err := pgQueryCents(row.Get(check.field), item.name+" "+check.field)
		if err != nil {
			return err
		}
		if got != check.cents {
			return fmt.Errorf("caso %s campo %s: obtido %d, esperado %d", item.name, check.field, got, check.cents)
		}
	}
	status, err := pgQueryText(row.Get("status"), item.name+" status")
	if err != nil {
		return err
	}
	legacy, err := pgQueryText(row.Get("legacy_status"), item.name+" legacy_status")
	if err != nil {
		return err
	}
	if status != item.status || legacy != item.status {
		return fmt.Errorf("caso %s status: obtido %s/%s, esperado %s", item.name, status, legacy, item.status)
	}
	matched, err := pgQueryBool(row.Get("matches"), item.name+" matches")
	if err != nil {
		return err
	}
	if matched != item.matches {
		return fmt.Errorf("caso %s matches: obtido %v, esperado %v", item.name, matched, item.matches)
	}
	return nil
}

func pgQuerySame(id, field string, dedicated, oracle any) error {
	if field == "status" || field == "legacy_status" {
		left, err := pgQueryText(dedicated, field)
		if err != nil {
			return err
		}
		right, err := pgQueryText(oracle, field)
		if err != nil {
			return err
		}
		if left != right {
			return fmt.Errorf("fatura %s campo %s: consulta %s, oráculo %s", id, field, left, right)
		}
		return nil
	}
	if field == "matches" {
		left, err := pgQueryBool(dedicated, field)
		if err != nil {
			return err
		}
		right, err := pgQueryBool(oracle, field)
		if err != nil {
			return err
		}
		if left != right {
			return fmt.Errorf("fatura %s matches: consulta %v, oráculo %v", id, left, right)
		}
		return nil
	}
	left, err := pgQueryCents(dedicated, field)
	if err != nil {
		return err
	}
	right, err := pgQueryCents(oracle, field)
	if err != nil {
		return err
	}
	if left != right {
		return fmt.Errorf("fatura %s campo %s: consulta %d, oráculo %d", id, field, left, right)
	}
	return nil
}

func pgQueryCents(value any, field string) (int64, error) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed != math.Trunc(typed) {
			return 0, fmt.Errorf("%s não é centavos inteiros: %v", field, typed)
		}
		return int64(typed), nil
	case int64:
		return typed, nil
	case int32:
		return int64(typed), nil
	case string:
		parsed, err := strconv.ParseInt(typed, 10, 64)
		if err != nil {
			return 0, fmt.Errorf("%s %q: %w", field, typed, err)
		}
		return parsed, nil
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, fmt.Errorf("%s %s: %w", field, typed, err)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("%s tipo %T valor %v", field, value, value)
	}
}

func pgQueryText(value any, field string) (string, error) {
	text, ok := value.(string)
	if !ok || text == "" {
		return "", fmt.Errorf("%s tipo %T valor %v", field, value, value)
	}
	return text, nil
}

func pgQueryBool(value any, field string) (bool, error) {
	switch typed := value.(type) {
	case bool:
		return typed, nil
	case string:
		if typed == "true" || typed == "t" {
			return true, nil
		}
		if typed == "false" || typed == "f" {
			return false, nil
		}
	}
	return false, fmt.Errorf("%s tipo %T valor %v", field, value, value)
}

func pgQueryRedact(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	lower := strings.ToLower(text)
	for _, marker := range []string{"postgres://", "postgresql://"} {
		if i := strings.Index(lower, marker); i >= 0 {
			text = text[:i] + marker + "***"
			lower = strings.ToLower(text)
		}
	}
	if i := strings.Index(lower, "password="); i >= 0 {
		text = text[:i] + "password=***"
	}
	return text
}

const pgQueryOracleSQL = `select invoice_id::text as invoice_id, status, legacy_status,
 nominal_cents, fee_cents, discount_cents, received_cents,
 legacy_nominal_cents, legacy_fee_cents, legacy_discount_cents, legacy_received_cents,
 residual_cents, excess_cents, collectible_cents, matches
from financial_balance_shadow
where invoice_id = any($1::uuid[])`

var pgQueryCompareFields = []string{
	"status", "legacy_status",
	"nominal_cents", "fee_cents", "discount_cents", "received_cents",
	"legacy_nominal_cents", "legacy_fee_cents", "legacy_discount_cents", "legacy_received_cents",
	"residual_cents", "excess_cents", "collectible_cents", "matches",
}
