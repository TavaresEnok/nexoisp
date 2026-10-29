package leitura

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"regexp"
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
// fica perto de 1 e o do Index Scan perto de 8; o planner então pode deixar de
// lado o acesso indexado. O volume torna essa escolha natural, sem
// enable_seqscan=off nem outro forçamento. O nome payments_invoice não é a
// prova: a unicidade da migração 74 pode aparecer como
// payments_tenant_invoice_identity_uq quando o catálogo confirma a estrutura.
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
	names, err := pgQueryPlanIndexNames(onePlan, pagePlan)
	if err != nil {
		return fmt.Errorf("nomes de índice do plano: %w", err)
	}
	catalog, err := pgQueryIndexCatalog(ctx, tx, names)
	if err != nil {
		return fmt.Errorf("catálogo dos índices do plano: %w", err)
	}
	if err := pgQueryProvePlan(onePlan, "fatura", []string{paid}, catalog); err != nil {
		return fmt.Errorf("%w; %s", err, pgQueryStatLog(moveStat, payStat))
	}
	if err := pgQueryProvePlan(pagePlan, "pagina", page, catalog); err != nil {
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

type pgQueryIndexFact struct {
	Name      string
	Relation  string
	Valid     bool
	Ready     bool
	Keys      []string
	Include   []string
	Predicate string
	IndexDef  string
}

func pgQueryPlanIndexNames(raws ...[]byte) ([]string, error) {
	seen := map[string]struct{}{}
	var names []string
	for _, raw := range raws {
		var docs any
		if err := json.Unmarshal(raw, &docs); err != nil {
			return nil, err
		}
		pgQueryWalkPlans(docs, func(node map[string]any) {
			name, _ := node["Index Name"].(string)
			if name == "" {
				return
			}
			if _, ok := seen[name]; ok {
				return
			}
			seen[name] = struct{}{}
			names = append(names, name)
		})
	}
	return names, nil
}

const pgQueryIndexCatalogSQL = `select
  ic.relname as name,
  tc.relname as relation,
  ix.indisvalid as valid,
  ix.indisready as ready,
  pg_get_indexdef(ix.indexrelid) as indexdef,
  coalesce(pg_get_expr(ix.indpred, ix.indrelid), '') as predicate,
  coalesce((
    select string_agg(coalesce(a.attname, 'expression'), ',' order by k.ord)
    from unnest(ix.indkey::smallint[]) with ordinality as k(attnum, ord)
    left join pg_attribute a on a.attrelid = tc.oid and a.attnum = k.attnum and k.attnum > 0
    where k.ord <= ix.indnkeyatts::bigint
  ), '') as keys,
  coalesce((
    select string_agg(coalesce(a.attname, 'expression'), ',' order by k.ord)
    from unnest(ix.indkey::smallint[]) with ordinality as k(attnum, ord)
    left join pg_attribute a on a.attrelid = tc.oid and a.attnum = k.attnum and k.attnum > 0
    where k.ord > ix.indnkeyatts::bigint
  ), '') as include_cols
from pg_index ix
join pg_class ic on ic.oid = ix.indexrelid
join pg_class tc on tc.oid = ix.indrelid
join pg_namespace ns on ns.oid = tc.relnamespace
where ns.nspname = 'public' and ic.relname = any($1::text[])`

func pgQueryIndexCatalog(ctx context.Context, tx *db.Tx, names []string) (map[string]pgQueryIndexFact, error) {
	if names == nil {
		names = []string{}
	}
	rows, err := tx.Objects(ctx, pgQueryIndexCatalogSQL, names)
	if err != nil {
		return nil, err
	}
	out := make(map[string]pgQueryIndexFact, len(rows))
	for _, row := range rows {
		name, err := pgQueryText(row.Get("name"), "name")
		if err != nil {
			return nil, err
		}
		relation, err := pgQueryText(row.Get("relation"), "relation")
		if err != nil {
			return nil, err
		}
		valid, err := pgQueryBool(row.Get("valid"), "valid")
		if err != nil {
			return nil, err
		}
		ready, err := pgQueryBool(row.Get("ready"), "ready")
		if err != nil {
			return nil, err
		}
		indexdef, err := pgQueryText(row.Get("indexdef"), "indexdef")
		if err != nil {
			return nil, err
		}
		predicate, _ := row.Get("predicate").(string)
		if _, exists := out[name]; exists {
			return nil, fmt.Errorf("índice %s repetido no catálogo public", name)
		}
		out[name] = pgQueryIndexFact{
			Name: name, Relation: relation, Valid: valid, Ready: ready,
			Keys: pgQueryCSV(row.Get("keys")), Include: pgQueryCSV(row.Get("include_cols")),
			Predicate: predicate, IndexDef: indexdef,
		}
	}
	return out, nil
}

func pgQueryProvePlan(raw []byte, label string, ids []string, catalog map[string]pgQueryIndexFact) error {
	var docs any
	if err := json.Unmarshal(raw, &docs); err != nil {
		return fmt.Errorf("plano %s ilegível: %w; ids=%s", label, err, strings.Join(ids, ","))
	}
	targets := []struct {
		relation string
		alias    string
	}{
		{"invoice_movements", "mv"},
		{"payments", "py"},
	}
	var problems []string
	for _, target := range targets {
		scans := pgQueryIndexScans(docs, target.relation, target.alias)
		if len(scans) == 0 {
			problems = append(problems, fmt.Sprintf("%s alias %s sem Index Scan da relação", target.relation, target.alias))
			continue
		}
		var reasons []string
		proved := false
		for _, scan := range scans {
			if err := pgQueryProveScan(scan, target.relation, target.alias, catalog); err != nil {
				reasons = append(reasons, err.Error())
				continue
			}
			proved = true
			break
		}
		if !proved {
			problems = append(problems, fmt.Sprintf("%s: %s", target.relation, strings.Join(reasons, " | ")))
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("plano natural de %s ids=%s não provou acesso indexado correlacionado: %s; gate de EXPLAIN permanece pendente; enable_seqscan não foi alterado", label, strings.Join(ids, ","), strings.Join(problems, "; "))
	}
	return nil
}

func pgQueryProveScan(node map[string]any, relation, alias string, catalog map[string]pgQueryIndexFact) error {
	name, _ := node["Index Name"].(string)
	indexText := pgQueryOwnConds(node, "Index Cond", "Recheck Cond")
	nodeText := pgQueryOwnConds(node, "Index Cond", "Filter", "Recheck Cond")
	if !pgQueryCorrelatesInvoice(indexText) || !pgQueryCorrelatesTenant(nodeText) {
		return fmt.Errorf("scan %q em %s alias %s sem invoice_id=i.id no Index Cond e tenant_id=i.tenant_id no mesmo nó; cond=%q", name, relation, alias, nodeText)
	}
	fact, ok := catalog[name]
	if !ok || name == "" {
		return fmt.Errorf("índice %q sem inspeção de catálogo; nome isolado não aceita; cond=%q", name, nodeText)
	}
	if err := pgQueryIndexServes(fact, relation); err != nil {
		return fmt.Errorf("índice %s: %w; cond=%q", name, err, nodeText)
	}
	if pgQueryTenantLeadsInvoice(fact.Keys) && !pgQueryCorrelatesTenant(indexText) {
		return fmt.Errorf("índice %s: tenant_id é chave anterior a invoice_id e não restringe o Index Cond do mesmo scan; cond=%q", name, indexText)
	}
	return nil
}

func pgQueryIndexServes(fact pgQueryIndexFact, relation string) error {
	if err := pgQueryIndexDefAgrees(fact); err != nil {
		return err
	}
	if fact.Relation != relation {
		return fmt.Errorf("índice de outra relação: catálogo %s, scan %s", fact.Relation, relation)
	}
	if !fact.Valid {
		return fmt.Errorf("índice inválido (indisvalid=false)")
	}
	if !fact.Ready {
		return fmt.Errorf("índice sem prontidão (indisready=false)")
	}
	if !pgQueryKeysSeekInvoice(fact.Keys) {
		return fmt.Errorf("chaves inadequadas %v; invoice_id precisa ser buscável com prefixo só de tenant_id", fact.Keys)
	}
	return pgQueryPredicateSatisfied(fact.Predicate)
}

func pgQueryIndexDefAgrees(fact pgQueryIndexFact) error {
	if fact.IndexDef == "" {
		return fmt.Errorf("pg_get_indexdef ausente para %s", fact.Name)
	}
	def := strings.ToLower(fact.IndexDef)
	if !pgQueryHasWord(def, fact.Name) {
		return fmt.Errorf("pg_get_indexdef não cita o índice %s", fact.Name)
	}
	if !pgQueryHasWord(def, fact.Relation) {
		return fmt.Errorf("pg_get_indexdef não cita a relação %s", fact.Relation)
	}
	for _, key := range fact.Keys {
		if key == "expression" || !pgQueryHasWord(def, key) {
			return fmt.Errorf("pg_get_indexdef não cita a chave %s", key)
		}
	}
	hasInclude := strings.Contains(def, " include ")
	if len(fact.Include) > 0 && !hasInclude {
		return fmt.Errorf("pg_get_indexdef sem include declarado")
	}
	if len(fact.Include) == 0 && hasInclude {
		return fmt.Errorf("pg_get_indexdef tem include ausente do catálogo")
	}
	for _, column := range fact.Include {
		if !pgQueryHasWord(def, column) {
			return fmt.Errorf("pg_get_indexdef não cita include %s", column)
		}
	}
	hasWhere := strings.Contains(def, " where ")
	if strings.TrimSpace(fact.Predicate) == "" && hasWhere {
		return fmt.Errorf("predicado do catálogo diverge de pg_get_indexdef")
	}
	if strings.TrimSpace(fact.Predicate) != "" && !hasWhere {
		return fmt.Errorf("pg_get_indexdef sem predicado declarado")
	}
	return nil
}

func pgQueryPredicateSatisfied(predicate string) error {
	body := strings.ToLower(strings.TrimSpace(predicate))
	if body == "" {
		return nil
	}
	body = strings.NewReplacer("(", " ", ")", " ").Replace(body)
	body = pgQuerySpace.ReplaceAllString(body, " ")
	body = strings.TrimSpace(body)
	if pgQueryAllowedPred.MatchString(body) {
		return nil
	}
	return fmt.Errorf("predicado insuficiente: %s", predicate)
}

func pgQueryKeysSeekInvoice(keys []string) bool {
	invoiceAt := -1
	for i, key := range keys {
		if key == "invoice_id" {
			invoiceAt = i
			break
		}
	}
	if invoiceAt < 0 {
		return false
	}
	for _, key := range keys[:invoiceAt] {
		if key != "tenant_id" {
			return false
		}
	}
	return true
}

func pgQueryTenantLeadsInvoice(keys []string) bool {
	invoiceAt := -1
	tenantAt := -1
	for i, key := range keys {
		if key == "invoice_id" && invoiceAt < 0 {
			invoiceAt = i
		}
		if key == "tenant_id" && tenantAt < 0 {
			tenantAt = i
		}
	}
	return invoiceAt >= 0 && tenantAt >= 0 && tenantAt < invoiceAt
}

func pgQueryIndexScans(root any, relation, alias string) []map[string]any {
	var out []map[string]any
	pgQueryWalkPlans(root, func(node map[string]any) {
		kind, _ := node["Node Type"].(string)
		if kind != "Index Scan" && kind != "Index Only Scan" {
			return
		}
		if node["Relation Name"] == relation && node["Alias"] == alias {
			out = append(out, node)
		}
	})
	return out
}

func pgQueryWalkPlans(node any, visit func(map[string]any)) {
	switch value := node.(type) {
	case map[string]any:
		visit(value)
		for _, child := range value {
			pgQueryWalkPlans(child, visit)
		}
	case []any:
		for _, child := range value {
			pgQueryWalkPlans(child, visit)
		}
	}
}

func pgQueryOwnConds(node map[string]any, fields ...string) string {
	parts := make([]string, 0, len(fields))
	for _, field := range fields {
		text, _ := node[field].(string)
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " ")
}

var (
	pgQueryInvoiceCorr = regexp.MustCompile(`(?i)(?:\b(?:mv|py)\.)?\binvoice_id\b\s*=\s*\bi\.id\b|\bi\.id\b\s*=\s*(?:\b(?:mv|py)\.)?\binvoice_id\b`)
	pgQueryTenantCorr  = regexp.MustCompile(`(?i)(?:\b(?:mv|py)\.)?\btenant_id\b\s*=\s*\bi\.tenant_id\b|\bi\.tenant_id\b\s*=\s*(?:\b(?:mv|py)\.)?\btenant_id\b`)
	pgQueryAllowedPred = regexp.MustCompile(`^(?:invoice_id is not null|tenant_id is not null)(?: and (?:invoice_id is not null|tenant_id is not null))*$`)
	pgQuerySpace       = regexp.MustCompile(`\s+`)
)

func pgQueryCorrelatesInvoice(text string) bool {
	return pgQueryInvoiceCorr.MatchString(text)
}

func pgQueryCorrelatesTenant(text string) bool {
	return pgQueryTenantCorr.MatchString(text)
}

func pgQueryHasWord(text, word string) bool {
	if word == "" {
		return false
	}
	return regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(word) + `\b`).MatchString(text)
}

func pgQueryCSV(value any) []string {
	text, _ := value.(string)
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	parts := strings.Split(text, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
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

func TestBalanceReadPGExplainVerifier(t *testing.T) {
	catalog := pgQueryCatalog74()
	paid := []byte(pgQueryPlanPaid7cde)
	page := []byte(pgQueryPlanPagina7cde)
	if err := pgQueryProvePlan(paid, "fatura", []string{"278a1e56-338f-4263-bae9-8ee2cdea7b22"}, catalog); err != nil {
		t.Fatalf("plano real da fatura 7cde1e6: %v", err)
	}
	if err := pgQueryProvePlan(page, "pagina", []string{"pagina"}, catalog); err != nil {
		t.Fatalf("plano real da pagina 7cde1e6: %v", err)
	}
	pgQueryRequireObservedScan(t, paid, 1)
	pgQueryRequireObservedScan(t, page, 7)
	if err := pgQueryProvePlan(paid, "fatura", []string{"278a1e56-338f-4263-bae9-8ee2cdea7b22"}, nil); err == nil {
		t.Fatal("nome isolado foi aceito sem catálogo")
	}
	movements := pgQueryScanJSON("invoice_movements", "mv", "invoice_movements_invoice", "((tenant_id = i.tenant_id) AND (invoice_id = i.id))", "", "")
	paymentsInvoice := pgQueryScanJSON("payments", "py", "payments_invoice", "(invoice_id = i.id)", "(tenant_id = i.tenant_id)", pgQueryScanJSON("contracts", "k", "contracts_list", "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)", "(invoice_id = i.id)", ""))
	if err := pgQueryProvePlan(pgQueryWrapPlans(movements, paymentsInvoice), "fatura", []string{"paid"}, catalog); err != nil {
		t.Fatalf("caminho payments_invoice: %v", err)
	}
	payments := pgQueryScanJSON("payments", "py", "payments_tenant_invoice_identity_uq", "((tenant_id = i.tenant_id) AND (invoice_id = i.id))", "", "")
	rls := pgQueryScanJSON("payments", "py", "payments_tenant_invoice_identity_uq", "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)", "(SubPlan 11)", pgQueryScanJSON("invoices", "i_1", "invoices_tenant_id_id_key", "((tenant_id = py.tenant_id) AND (id = py.invoice_id))", "(invoice_id = i.id)", ""))
	splitLeft := pgQueryScanJSON("invoice_movements", "mv", "invoice_movements_invoice", "(invoice_id = i.id)", "", "")
	splitRight := pgQueryScanJSON("invoice_movements", "mv", "invoice_movements_invoice", "(tenant_id = i.tenant_id)", "", "")
	cases := []struct {
		name     string
		plan     []byte
		catalog  map[string]pgQueryIndexFact
		fragment string
	}{
		{name: "nome isolado", plan: paid, catalog: nil, fragment: "nome isolado"},
		{name: "nome sem chaves", plan: paid, catalog: pgQueryCatalogNameOnly(), fragment: "chaves inadequadas"},
		{name: "indice de outra relacao", plan: paid, catalog: pgQueryCatalogMutate("payments_tenant_invoice_identity_uq", func(fact *pgQueryIndexFact) {
			fact.Relation = "invoices"
			fact.IndexDef = "CREATE UNIQUE INDEX payments_tenant_invoice_identity_uq ON public.invoices USING btree (tenant_id, invoice_id, id)"
		}), fragment: "outra relação"},
		{name: "so tenant RLS", plan: pgQueryWrapPlans(movements, rls), catalog: catalog, fragment: "no mesmo nó"},
		{name: "invoice sem tenant", plan: pgQueryWrapPlans(movements, pgQueryScanJSON("payments", "py", "payments_invoice", "(invoice_id = i.id)", "", "")), catalog: catalog, fragment: "no mesmo nó"},
		{name: "predicado insuficiente", plan: pgQueryWrapPlans(movements, paymentsInvoice), catalog: pgQueryCatalogMutate("payments_invoice", func(fact *pgQueryIndexFact) {
			fact.Predicate = "(status = 'open'::text)"
			fact.IndexDef = "CREATE INDEX payments_invoice ON public.payments USING btree (invoice_id) INCLUDE (signed_cents) WHERE (status = 'open'::text)"
		}), fragment: "predicado insuficiente"},
		{name: "indice invalido", plan: paid, catalog: pgQueryCatalogMutate("payments_tenant_invoice_identity_uq", func(fact *pgQueryIndexFact) {
			fact.Valid = false
		}), fragment: "índice inválido"},
		{name: "indice sem prontidao", plan: paid, catalog: pgQueryCatalogMutate("invoice_movements_invoice", func(fact *pgQueryIndexFact) {
			fact.Ready = false
		}), fragment: "sem prontidão"},
		{name: "condicoes divididas", plan: pgQueryWrapPlans(splitLeft, splitRight, payments), catalog: catalog, fragment: "no mesmo nó"},
		{name: "tenant chave so no filtro", plan: pgQueryWrapPlans(movements, pgQueryScanJSON("payments", "py", "payments_tenant_invoice_identity_uq", "(invoice_id = i.id)", "(tenant_id = i.tenant_id)", "")), catalog: catalog, fragment: "chave anterior"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := pgQueryProvePlan(tc.plan, tc.name, []string{"caso"}, tc.catalog)
			if err == nil {
				t.Fatal("plano reprovável foi aceito")
			}
			if !strings.Contains(err.Error(), tc.fragment) {
				t.Fatalf("evidência %q ausente em %v", tc.fragment, err)
			}
		})
	}
}

func pgQueryRequireObservedScan(t *testing.T, raw []byte, loops float64) {
	t.Helper()
	var docs any
	if err := json.Unmarshal(raw, &docs); err != nil {
		t.Fatal(err)
	}
	for _, target := range []struct {
		relation string
		alias    string
		index    string
	}{
		{"invoice_movements", "mv", "invoice_movements_invoice"},
		{"payments", "py", "payments_tenant_invoice_identity_uq"},
	} {
		scans := pgQueryIndexScans(docs, target.relation, target.alias)
		if len(scans) != 1 {
			t.Fatalf("%s scans=%d", target.relation, len(scans))
		}
		if scans[0]["Index Name"] != target.index {
			t.Fatalf("índice %v", scans[0]["Index Name"])
		}
		if scans[0]["Index Cond"] != "((tenant_id = i.tenant_id) AND (invoice_id = i.id))" {
			t.Fatalf("cond %v", scans[0]["Index Cond"])
		}
		if scans[0]["Actual Loops"] != loops || scans[0]["Actual Rows"] != float64(1) {
			t.Fatalf("loops=%v rows=%v", scans[0]["Actual Loops"], scans[0]["Actual Rows"])
		}
	}
}

func pgQueryCatalog74() map[string]pgQueryIndexFact {
	return map[string]pgQueryIndexFact{
		"invoice_movements_invoice": {
			Name: "invoice_movements_invoice", Relation: "invoice_movements", Valid: true, Ready: true,
			Keys:     []string{"tenant_id", "invoice_id", "id"},
			IndexDef: "CREATE INDEX invoice_movements_invoice ON public.invoice_movements USING btree (tenant_id, invoice_id, id)",
		},
		"payments_tenant_invoice_identity_uq": {
			Name: "payments_tenant_invoice_identity_uq", Relation: "payments", Valid: true, Ready: true,
			Keys:     []string{"tenant_id", "invoice_id", "id"},
			IndexDef: "CREATE UNIQUE INDEX payments_tenant_invoice_identity_uq ON public.payments USING btree (tenant_id, invoice_id, id)",
		},
		"payments_invoice": {
			Name: "payments_invoice", Relation: "payments", Valid: true, Ready: true,
			Keys:     []string{"invoice_id"},
			Include:  []string{"signed_cents"},
			IndexDef: "CREATE INDEX payments_invoice ON public.payments USING btree (invoice_id) INCLUDE (signed_cents)",
		},
	}
}

func pgQueryCatalogNameOnly() map[string]pgQueryIndexFact {
	return map[string]pgQueryIndexFact{
		"invoice_movements_invoice": pgQueryCatalog74()["invoice_movements_invoice"],
		"payments_tenant_invoice_identity_uq": {
			Name: "payments_tenant_invoice_identity_uq", Relation: "payments", Valid: true, Ready: true,
			IndexDef: "payments_tenant_invoice_identity_uq ON payments",
		},
	}
}

func pgQueryCatalogMutate(name string, edit func(*pgQueryIndexFact)) map[string]pgQueryIndexFact {
	out := pgQueryCatalog74()
	fact := out[name]
	edit(&fact)
	out[name] = fact
	return out
}

func pgQueryScanJSON(relation, alias, index, indexCond, filter, child string) string {
	extra := ""
	if filter != "" {
		extra += `,"Filter":` + strconv.Quote(filter)
	}
	if child != "" {
		extra += `,"Plans":[` + child + `]`
	}
	return `{"Node Type":"Index Scan","Index Name":` + strconv.Quote(index) + `,"Relation Name":` + strconv.Quote(relation) + `,"Alias":` + strconv.Quote(alias) + `,"Index Cond":` + strconv.Quote(indexCond) + extra + `}`
}

func pgQueryWrapPlans(plans ...string) []byte {
	return []byte(`[{"Plan":{"Node Type":"Nested Loop","Plans":[` + strings.Join(plans, ",") + `]}}]`)
}

const pgQueryPlanPaid7cde = `
[
  {
    "Plan": {
      "Node Type": "Nested Loop",
      "Parallel Aware": false,
      "Async Capable": false,
      "Join Type": "Left",
      "Startup Cost": 50.37,
      "Total Cost": 66.94,
      "Plan Rows": 1,
      "Plan Width": 191,
      "Actual Startup Time": 0.09,
      "Actual Total Time": 0.093,
      "Actual Rows": 1,
      "Actual Loops": 1,
      "Inner Unique": false,
      "Shared Hit Blocks": 13,
      "Shared Read Blocks": 0,
      "Shared Dirtied Blocks": 0,
      "Shared Written Blocks": 0,
      "Local Hit Blocks": 0,
      "Local Read Blocks": 0,
      "Local Dirtied Blocks": 0,
      "Local Written Blocks": 0,
      "Temp Read Blocks": 0,
      "Temp Written Blocks": 0,
      "Plans": [
        {
          "Node Type": "Nested Loop",
          "Parent Relationship": "Outer",
          "Parallel Aware": false,
          "Async Capable": false,
          "Join Type": "Left",
          "Startup Cost": 25.33,
          "Total Cost": 41.82,
          "Plan Rows": 1,
          "Plan Width": 138,
          "Actual Startup Time": 0.071,
          "Actual Total Time": 0.073,
          "Actual Rows": 1,
          "Actual Loops": 1,
          "Inner Unique": false,
          "Shared Hit Blocks": 10,
          "Shared Read Blocks": 0,
          "Shared Dirtied Blocks": 0,
          "Shared Written Blocks": 0,
          "Local Hit Blocks": 0,
          "Local Read Blocks": 0,
          "Local Dirtied Blocks": 0,
          "Local Written Blocks": 0,
          "Temp Read Blocks": 0,
          "Temp Written Blocks": 0,
          "Plans": [
            {
              "Node Type": "Index Scan",
              "Parent Relationship": "Outer",
              "Parallel Aware": false,
              "Async Capable": false,
              "Scan Direction": "Forward",
              "Index Name": "invoices_pkey",
              "Relation Name": "invoices",
              "Alias": "i",
              "Startup Cost": 0.28,
              "Total Cost": 16.73,
              "Plan Rows": 1,
              "Plan Width": 82,
              "Actual Startup Time": 0.02,
              "Actual Total Time": 0.021,
              "Actual Rows": 1,
              "Actual Loops": 1,
              "Index Cond": "(id = ANY ('{278a1e56-338f-4263-bae9-8ee2cdea7b22}'::uuid[]))",
              "Rows Removed by Index Recheck": 0,
              "Filter": "((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (hashed SubPlan 2)))",
              "Rows Removed by Filter": 0,
              "Shared Hit Blocks": 3,
              "Shared Read Blocks": 0,
              "Shared Dirtied Blocks": 0,
              "Shared Written Blocks": 0,
              "Local Hit Blocks": 0,
              "Local Read Blocks": 0,
              "Local Dirtied Blocks": 0,
              "Local Written Blocks": 0,
              "Temp Read Blocks": 0,
              "Temp Written Blocks": 0,
              "Plans": [
                {
                  "Node Type": "Index Scan",
                  "Parent Relationship": "SubPlan",
                  "Subplan Name": "SubPlan 2",
                  "Parallel Aware": false,
                  "Async Capable": false,
                  "Scan Direction": "Forward",
                  "Index Name": "contracts_list",
                  "Relation Name": "contracts",
                  "Alias": "k",
                  "Startup Cost": 0.15,
                  "Total Cost": 8.34,
                  "Plan Rows": 1,
                  "Plan Width": 16,
                  "Actual Startup Time": 0.0,
                  "Actual Total Time": 0.0,
                  "Actual Rows": 0,
                  "Actual Loops": 0,
                  "Index Cond": "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
                  "Rows Removed by Index Recheck": 0,
                  "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (pop_id IS NULL) OR (pop_id = ANY ((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[]))))",
                  "Rows Removed by Filter": 0,
                  "Shared Hit Blocks": 0,
                  "Shared Read Blocks": 0,
                  "Shared Dirtied Blocks": 0,
                  "Shared Written Blocks": 0,
                  "Local Hit Blocks": 0,
                  "Local Read Blocks": 0,
                  "Local Dirtied Blocks": 0,
                  "Local Written Blocks": 0,
                  "Temp Read Blocks": 0,
                  "Temp Written Blocks": 0
                }
              ]
            },
            {
              "Node Type": "Aggregate",
              "Strategy": "Plain",
              "Partial Mode": "Simple",
              "Parent Relationship": "Inner",
              "Parallel Aware": false,
              "Async Capable": false,
              "Startup Cost": 25.05,
              "Total Cost": 25.06,
              "Plan Rows": 1,
              "Plan Width": 56,
              "Actual Startup Time": 0.049,
              "Actual Total Time": 0.05,
              "Actual Rows": 1,
              "Actual Loops": 1,
              "Shared Hit Blocks": 7,
              "Shared Read Blocks": 0,
              "Shared Dirtied Blocks": 0,
              "Shared Written Blocks": 0,
              "Local Hit Blocks": 0,
              "Local Read Blocks": 0,
              "Local Dirtied Blocks": 0,
              "Local Written Blocks": 0,
              "Temp Read Blocks": 0,
              "Temp Written Blocks": 0,
              "Plans": [
                {
                  "Node Type": "Result",
                  "Parent Relationship": "Outer",
                  "Parallel Aware": false,
                  "Async Capable": false,
                  "Startup Cost": 0.28,
                  "Total Cost": 25.03,
                  "Plan Rows": 1,
                  "Plan Width": 37,
                  "Actual Startup Time": 0.037,
                  "Actual Total Time": 0.039,
                  "Actual Rows": 1,
                  "Actual Loops": 1,
                  "One-Time Filter": "((NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid = i.tenant_id)",
                  "Shared Hit Blocks": 7,
                  "Shared Read Blocks": 0,
                  "Shared Dirtied Blocks": 0,
                  "Shared Written Blocks": 0,
                  "Local Hit Blocks": 0,
                  "Local Read Blocks": 0,
                  "Local Dirtied Blocks": 0,
                  "Local Written Blocks": 0,
                  "Temp Read Blocks": 0,
                  "Temp Written Blocks": 0,
                  "Plans": [
                    {
                      "Node Type": "Index Scan",
                      "Parent Relationship": "Outer",
                      "Parallel Aware": false,
                      "Async Capable": false,
                      "Scan Direction": "Backward",
                      "Index Name": "invoice_movements_invoice",
                      "Relation Name": "invoice_movements",
                      "Alias": "mv",
                      "Startup Cost": 0.28,
                      "Total Cost": 25.03,
                      "Plan Rows": 1,
                      "Plan Width": 37,
                      "Actual Startup Time": 0.035,
                      "Actual Total Time": 0.036,
                      "Actual Rows": 1,
                      "Actual Loops": 1,
                      "Index Cond": "((tenant_id = i.tenant_id) AND (invoice_id = i.id))",
                      "Rows Removed by Index Recheck": 0,
                      "Filter": "(SubPlan 5)",
                      "Rows Removed by Filter": 0,
                      "Shared Hit Blocks": 7,
                      "Shared Read Blocks": 0,
                      "Shared Dirtied Blocks": 0,
                      "Shared Written Blocks": 0,
                      "Local Hit Blocks": 0,
                      "Local Read Blocks": 0,
                      "Local Dirtied Blocks": 0,
                      "Local Written Blocks": 0,
                      "Temp Read Blocks": 0,
                      "Temp Written Blocks": 0,
                      "Plans": [
                        {
                          "Node Type": "Result",
                          "Parent Relationship": "SubPlan",
                          "Subplan Name": "SubPlan 5",
                          "Parallel Aware": false,
                          "Async Capable": false,
                          "Startup Cost": 0.28,
                          "Total Cost": 16.73,
                          "Plan Rows": 1,
                          "Plan Width": 0,
                          "Actual Startup Time": 0.024,
                          "Actual Total Time": 0.024,
                          "Actual Rows": 1,
                          "Actual Loops": 1,
                          "One-Time Filter": "((NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid = mv.tenant_id)",
                          "Shared Hit Blocks": 3,
                          "Shared Read Blocks": 0,
                          "Shared Dirtied Blocks": 0,
                          "Shared Written Blocks": 0,
                          "Local Hit Blocks": 0,
                          "Local Read Blocks": 0,
                          "Local Dirtied Blocks": 0,
                          "Local Written Blocks": 0,
                          "Temp Read Blocks": 0,
                          "Temp Written Blocks": 0,
                          "Plans": [
                            {
                              "Node Type": "Index Scan",
                              "Parent Relationship": "Outer",
                              "Parallel Aware": false,
                              "Async Capable": false,
                              "Scan Direction": "Forward",
                              "Index Name": "invoices_tenant_id_id_key",
                              "Relation Name": "invoices",
                              "Alias": "i_1",
                              "Startup Cost": 0.28,
                              "Total Cost": 16.73,
                              "Plan Rows": 1,
                              "Plan Width": 0,
                              "Actual Startup Time": 0.022,
                              "Actual Total Time": 0.022,
                              "Actual Rows": 1,
                              "Actual Loops": 1,
                              "Index Cond": "((tenant_id = mv.tenant_id) AND (id = mv.invoice_id))",
                              "Rows Removed by Index Recheck": 0,
                              "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (hashed SubPlan 4)))",
                              "Rows Removed by Filter": 0,
                              "Shared Hit Blocks": 3,
                              "Shared Read Blocks": 0,
                              "Shared Dirtied Blocks": 0,
                              "Shared Written Blocks": 0,
                              "Local Hit Blocks": 0,
                              "Local Read Blocks": 0,
                              "Local Dirtied Blocks": 0,
                              "Local Written Blocks": 0,
                              "Temp Read Blocks": 0,
                              "Temp Written Blocks": 0,
                              "Plans": [
                                {
                                  "Node Type": "Index Scan",
                                  "Parent Relationship": "SubPlan",
                                  "Subplan Name": "SubPlan 4",
                                  "Parallel Aware": false,
                                  "Async Capable": false,
                                  "Scan Direction": "Forward",
                                  "Index Name": "contracts_list",
                                  "Relation Name": "contracts",
                                  "Alias": "k_1",
                                  "Startup Cost": 0.15,
                                  "Total Cost": 8.34,
                                  "Plan Rows": 1,
                                  "Plan Width": 16,
                                  "Actual Startup Time": 0.0,
                                  "Actual Total Time": 0.0,
                                  "Actual Rows": 0,
                                  "Actual Loops": 0,
                                  "Index Cond": "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
                                  "Rows Removed by Index Recheck": 0,
                                  "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (pop_id IS NULL) OR (pop_id = ANY ((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[]))))",
                                  "Rows Removed by Filter": 0,
                                  "Shared Hit Blocks": 0,
                                  "Shared Read Blocks": 0,
                                  "Shared Dirtied Blocks": 0,
                                  "Shared Written Blocks": 0,
                                  "Local Hit Blocks": 0,
                                  "Local Read Blocks": 0,
                                  "Local Dirtied Blocks": 0,
                                  "Local Written Blocks": 0,
                                  "Temp Read Blocks": 0,
                                  "Temp Written Blocks": 0
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "Node Type": "Aggregate",
          "Strategy": "Plain",
          "Partial Mode": "Simple",
          "Parent Relationship": "Inner",
          "Parallel Aware": false,
          "Async Capable": false,
          "Startup Cost": 25.05,
          "Total Cost": 25.06,
          "Plan Rows": 1,
          "Plan Width": 8,
          "Actual Startup Time": 0.014,
          "Actual Total Time": 0.014,
          "Actual Rows": 1,
          "Actual Loops": 1,
          "Shared Hit Blocks": 3,
          "Shared Read Blocks": 0,
          "Shared Dirtied Blocks": 0,
          "Shared Written Blocks": 0,
          "Local Hit Blocks": 0,
          "Local Read Blocks": 0,
          "Local Dirtied Blocks": 0,
          "Local Written Blocks": 0,
          "Temp Read Blocks": 0,
          "Temp Written Blocks": 0,
          "Plans": [
            {
              "Node Type": "Result",
              "Parent Relationship": "Outer",
              "Parallel Aware": false,
              "Async Capable": false,
              "Startup Cost": 0.28,
              "Total Cost": 25.04,
              "Plan Rows": 1,
              "Plan Width": 4,
              "Actual Startup Time": 0.012,
              "Actual Total Time": 0.013,
              "Actual Rows": 1,
              "Actual Loops": 1,
              "One-Time Filter": "((NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid = i.tenant_id)",
              "Shared Hit Blocks": 3,
              "Shared Read Blocks": 0,
              "Shared Dirtied Blocks": 0,
              "Shared Written Blocks": 0,
              "Local Hit Blocks": 0,
              "Local Read Blocks": 0,
              "Local Dirtied Blocks": 0,
              "Local Written Blocks": 0,
              "Temp Read Blocks": 0,
              "Temp Written Blocks": 0,
              "Plans": [
                {
                  "Node Type": "Index Scan",
                  "Parent Relationship": "Outer",
                  "Parallel Aware": false,
                  "Async Capable": false,
                  "Scan Direction": "Forward",
                  "Index Name": "payments_tenant_invoice_identity_uq",
                  "Relation Name": "payments",
                  "Alias": "py",
                  "Startup Cost": 0.28,
                  "Total Cost": 25.04,
                  "Plan Rows": 1,
                  "Plan Width": 4,
                  "Actual Startup Time": 0.01,
                  "Actual Total Time": 0.011,
                  "Actual Rows": 1,
                  "Actual Loops": 1,
                  "Index Cond": "((tenant_id = i.tenant_id) AND (invoice_id = i.id))",
                  "Rows Removed by Index Recheck": 0,
                  "Filter": "(((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (SubPlan 11))",
                  "Rows Removed by Filter": 0,
                  "Shared Hit Blocks": 3,
                  "Shared Read Blocks": 0,
                  "Shared Dirtied Blocks": 0,
                  "Shared Written Blocks": 0,
                  "Local Hit Blocks": 0,
                  "Local Read Blocks": 0,
                  "Local Dirtied Blocks": 0,
                  "Local Written Blocks": 0,
                  "Temp Read Blocks": 0,
                  "Temp Written Blocks": 0,
                  "Plans": [
                    {
                      "Node Type": "Index Scan",
                      "Parent Relationship": "SubPlan",
                      "Subplan Name": "SubPlan 11",
                      "Parallel Aware": false,
                      "Async Capable": false,
                      "Scan Direction": "Forward",
                      "Index Name": "invoices_pkey",
                      "Relation Name": "invoices",
                      "Alias": "i_2",
                      "Startup Cost": 0.28,
                      "Total Cost": 16.73,
                      "Plan Rows": 1,
                      "Plan Width": 0,
                      "Actual Startup Time": 0.0,
                      "Actual Total Time": 0.0,
                      "Actual Rows": 0,
                      "Actual Loops": 0,
                      "Index Cond": "(id = py.invoice_id)",
                      "Rows Removed by Index Recheck": 0,
                      "Filter": "((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (hashed SubPlan 10)))",
                      "Rows Removed by Filter": 0,
                      "Shared Hit Blocks": 0,
                      "Shared Read Blocks": 0,
                      "Shared Dirtied Blocks": 0,
                      "Shared Written Blocks": 0,
                      "Local Hit Blocks": 0,
                      "Local Read Blocks": 0,
                      "Local Dirtied Blocks": 0,
                      "Local Written Blocks": 0,
                      "Temp Read Blocks": 0,
                      "Temp Written Blocks": 0,
                      "Plans": [
                        {
                          "Node Type": "Index Scan",
                          "Parent Relationship": "SubPlan",
                          "Subplan Name": "SubPlan 10",
                          "Parallel Aware": false,
                          "Async Capable": false,
                          "Scan Direction": "Forward",
                          "Index Name": "contracts_list",
                          "Relation Name": "contracts",
                          "Alias": "k_2",
                          "Startup Cost": 0.15,
                          "Total Cost": 8.34,
                          "Plan Rows": 1,
                          "Plan Width": 16,
                          "Actual Startup Time": 0.0,
                          "Actual Total Time": 0.0,
                          "Actual Rows": 0,
                          "Actual Loops": 0,
                          "Index Cond": "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
                          "Rows Removed by Index Recheck": 0,
                          "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (pop_id IS NULL) OR (pop_id = ANY ((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[]))))",
                          "Rows Removed by Filter": 0,
                          "Shared Hit Blocks": 0,
                          "Shared Read Blocks": 0,
                          "Shared Dirtied Blocks": 0,
                          "Shared Written Blocks": 0,
                          "Local Hit Blocks": 0,
                          "Local Read Blocks": 0,
                          "Local Dirtied Blocks": 0,
                          "Local Written Blocks": 0,
                          "Temp Read Blocks": 0,
                          "Temp Written Blocks": 0
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "Planning": {
      "Shared Hit Blocks": 76,
      "Shared Read Blocks": 0,
      "Shared Dirtied Blocks": 0,
      "Shared Written Blocks": 0,
      "Local Hit Blocks": 0,
      "Local Read Blocks": 0,
      "Local Dirtied Blocks": 0,
      "Local Written Blocks": 0,
      "Temp Read Blocks": 0,
      "Temp Written Blocks": 0
    },
    "Planning Time": 4.312,
    "Triggers": [],
    "Execution Time": 0.471
  }
]
`

const pgQueryPlanPagina7cde = `
[
  {
    "Plan": {
      "Node Type": "Nested Loop",
      "Parallel Aware": false,
      "Async Capable": false,
      "Join Type": "Left",
      "Startup Cost": 50.38,
      "Total Cost": 154.24,
      "Plan Rows": 1,
      "Plan Width": 191,
      "Actual Startup Time": 0.09,
      "Actual Total Time": 0.184,
      "Actual Rows": 7,
      "Actual Loops": 1,
      "Inner Unique": false,
      "Shared Hit Blocks": 84,
      "Shared Read Blocks": 0,
      "Shared Dirtied Blocks": 0,
      "Shared Written Blocks": 0,
      "Local Hit Blocks": 0,
      "Local Read Blocks": 0,
      "Local Dirtied Blocks": 0,
      "Local Written Blocks": 0,
      "Temp Read Blocks": 0,
      "Temp Written Blocks": 0,
      "Plans": [
        {
          "Node Type": "Nested Loop",
          "Parent Relationship": "Outer",
          "Parallel Aware": false,
          "Async Capable": false,
          "Join Type": "Left",
          "Startup Cost": 25.34,
          "Total Cost": 129.11,
          "Plan Rows": 1,
          "Plan Width": 138,
          "Actual Startup Time": 0.06,
          "Actual Total Time": 0.124,
          "Actual Rows": 7,
          "Actual Loops": 1,
          "Inner Unique": false,
          "Shared Hit Blocks": 64,
          "Shared Read Blocks": 0,
          "Shared Dirtied Blocks": 0,
          "Shared Written Blocks": 0,
          "Local Hit Blocks": 0,
          "Local Read Blocks": 0,
          "Local Dirtied Blocks": 0,
          "Local Written Blocks": 0,
          "Temp Read Blocks": 0,
          "Temp Written Blocks": 0,
          "Plans": [
            {
              "Node Type": "Index Scan",
              "Parent Relationship": "Outer",
              "Parallel Aware": false,
              "Async Capable": false,
              "Scan Direction": "Forward",
              "Index Name": "invoices_tenant_id_id_key",
              "Relation Name": "invoices",
              "Alias": "i",
              "Startup Cost": 0.29,
              "Total Cost": 104.03,
              "Plan Rows": 1,
              "Plan Width": 82,
              "Actual Startup Time": 0.023,
              "Actual Total Time": 0.038,
              "Actual Rows": 7,
              "Actual Loops": 1,
              "Index Cond": "((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (id = ANY ('{fb0dd183-0102-44b8-89ae-b0f69fcaf63a,278a1e56-338f-4263-bae9-8ee2cdea7b22,011c3ae4-a1c7-483b-96bd-562d3e5415fa,48c1bb0c-48b6-49f0-895f-a751a1b6caab,47c49264-8dca-4e94-a361-8b945e8f23c5,43ef1b5f-f45b-49a3-92c3-7752e58cd317,cb7baded-532f-43d2-bcbc-479a58377d0e}'::uuid[])))",
              "Rows Removed by Index Recheck": 0,
              "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (hashed SubPlan 2)))",
              "Rows Removed by Filter": 0,
              "Shared Hit Blocks": 15,
              "Shared Read Blocks": 0,
              "Shared Dirtied Blocks": 0,
              "Shared Written Blocks": 0,
              "Local Hit Blocks": 0,
              "Local Read Blocks": 0,
              "Local Dirtied Blocks": 0,
              "Local Written Blocks": 0,
              "Temp Read Blocks": 0,
              "Temp Written Blocks": 0,
              "Plans": [
                {
                  "Node Type": "Index Scan",
                  "Parent Relationship": "SubPlan",
                  "Subplan Name": "SubPlan 2",
                  "Parallel Aware": false,
                  "Async Capable": false,
                  "Scan Direction": "Forward",
                  "Index Name": "contracts_list",
                  "Relation Name": "contracts",
                  "Alias": "k",
                  "Startup Cost": 0.15,
                  "Total Cost": 8.34,
                  "Plan Rows": 1,
                  "Plan Width": 16,
                  "Actual Startup Time": 0.0,
                  "Actual Total Time": 0.0,
                  "Actual Rows": 0,
                  "Actual Loops": 0,
                  "Index Cond": "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
                  "Rows Removed by Index Recheck": 0,
                  "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (pop_id IS NULL) OR (pop_id = ANY ((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[]))))",
                  "Rows Removed by Filter": 0,
                  "Shared Hit Blocks": 0,
                  "Shared Read Blocks": 0,
                  "Shared Dirtied Blocks": 0,
                  "Shared Written Blocks": 0,
                  "Local Hit Blocks": 0,
                  "Local Read Blocks": 0,
                  "Local Dirtied Blocks": 0,
                  "Local Written Blocks": 0,
                  "Temp Read Blocks": 0,
                  "Temp Written Blocks": 0
                }
              ]
            },
            {
              "Node Type": "Aggregate",
              "Strategy": "Plain",
              "Partial Mode": "Simple",
              "Parent Relationship": "Inner",
              "Parallel Aware": false,
              "Async Capable": false,
              "Startup Cost": 25.05,
              "Total Cost": 25.06,
              "Plan Rows": 1,
              "Plan Width": 56,
              "Actual Startup Time": 0.011,
              "Actual Total Time": 0.012,
              "Actual Rows": 1,
              "Actual Loops": 7,
              "Shared Hit Blocks": 49,
              "Shared Read Blocks": 0,
              "Shared Dirtied Blocks": 0,
              "Shared Written Blocks": 0,
              "Local Hit Blocks": 0,
              "Local Read Blocks": 0,
              "Local Dirtied Blocks": 0,
              "Local Written Blocks": 0,
              "Temp Read Blocks": 0,
              "Temp Written Blocks": 0,
              "Plans": [
                {
                  "Node Type": "Result",
                  "Parent Relationship": "Outer",
                  "Parallel Aware": false,
                  "Async Capable": false,
                  "Startup Cost": 0.28,
                  "Total Cost": 25.03,
                  "Plan Rows": 1,
                  "Plan Width": 37,
                  "Actual Startup Time": 0.008,
                  "Actual Total Time": 0.009,
                  "Actual Rows": 1,
                  "Actual Loops": 7,
                  "One-Time Filter": "((NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid = i.tenant_id)",
                  "Shared Hit Blocks": 49,
                  "Shared Read Blocks": 0,
                  "Shared Dirtied Blocks": 0,
                  "Shared Written Blocks": 0,
                  "Local Hit Blocks": 0,
                  "Local Read Blocks": 0,
                  "Local Dirtied Blocks": 0,
                  "Local Written Blocks": 0,
                  "Temp Read Blocks": 0,
                  "Temp Written Blocks": 0,
                  "Plans": [
                    {
                      "Node Type": "Index Scan",
                      "Parent Relationship": "Outer",
                      "Parallel Aware": false,
                      "Async Capable": false,
                      "Scan Direction": "Backward",
                      "Index Name": "invoice_movements_invoice",
                      "Relation Name": "invoice_movements",
                      "Alias": "mv",
                      "Startup Cost": 0.28,
                      "Total Cost": 25.03,
                      "Plan Rows": 1,
                      "Plan Width": 37,
                      "Actual Startup Time": 0.007,
                      "Actual Total Time": 0.008,
                      "Actual Rows": 1,
                      "Actual Loops": 7,
                      "Index Cond": "((tenant_id = i.tenant_id) AND (invoice_id = i.id))",
                      "Rows Removed by Index Recheck": 0,
                      "Filter": "(SubPlan 5)",
                      "Rows Removed by Filter": 0,
                      "Shared Hit Blocks": 49,
                      "Shared Read Blocks": 0,
                      "Shared Dirtied Blocks": 0,
                      "Shared Written Blocks": 0,
                      "Local Hit Blocks": 0,
                      "Local Read Blocks": 0,
                      "Local Dirtied Blocks": 0,
                      "Local Written Blocks": 0,
                      "Temp Read Blocks": 0,
                      "Temp Written Blocks": 0,
                      "Plans": [
                        {
                          "Node Type": "Result",
                          "Parent Relationship": "SubPlan",
                          "Subplan Name": "SubPlan 5",
                          "Parallel Aware": false,
                          "Async Capable": false,
                          "Startup Cost": 0.28,
                          "Total Cost": 16.73,
                          "Plan Rows": 1,
                          "Plan Width": 0,
                          "Actual Startup Time": 0.004,
                          "Actual Total Time": 0.004,
                          "Actual Rows": 1,
                          "Actual Loops": 7,
                          "One-Time Filter": "((NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid = mv.tenant_id)",
                          "Shared Hit Blocks": 21,
                          "Shared Read Blocks": 0,
                          "Shared Dirtied Blocks": 0,
                          "Shared Written Blocks": 0,
                          "Local Hit Blocks": 0,
                          "Local Read Blocks": 0,
                          "Local Dirtied Blocks": 0,
                          "Local Written Blocks": 0,
                          "Temp Read Blocks": 0,
                          "Temp Written Blocks": 0,
                          "Plans": [
                            {
                              "Node Type": "Index Scan",
                              "Parent Relationship": "Outer",
                              "Parallel Aware": false,
                              "Async Capable": false,
                              "Scan Direction": "Forward",
                              "Index Name": "invoices_tenant_id_id_key",
                              "Relation Name": "invoices",
                              "Alias": "i_1",
                              "Startup Cost": 0.28,
                              "Total Cost": 16.73,
                              "Plan Rows": 1,
                              "Plan Width": 0,
                              "Actual Startup Time": 0.003,
                              "Actual Total Time": 0.003,
                              "Actual Rows": 1,
                              "Actual Loops": 7,
                              "Index Cond": "((tenant_id = mv.tenant_id) AND (id = mv.invoice_id))",
                              "Rows Removed by Index Recheck": 0,
                              "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (hashed SubPlan 4)))",
                              "Rows Removed by Filter": 0,
                              "Shared Hit Blocks": 21,
                              "Shared Read Blocks": 0,
                              "Shared Dirtied Blocks": 0,
                              "Shared Written Blocks": 0,
                              "Local Hit Blocks": 0,
                              "Local Read Blocks": 0,
                              "Local Dirtied Blocks": 0,
                              "Local Written Blocks": 0,
                              "Temp Read Blocks": 0,
                              "Temp Written Blocks": 0,
                              "Plans": [
                                {
                                  "Node Type": "Index Scan",
                                  "Parent Relationship": "SubPlan",
                                  "Subplan Name": "SubPlan 4",
                                  "Parallel Aware": false,
                                  "Async Capable": false,
                                  "Scan Direction": "Forward",
                                  "Index Name": "contracts_list",
                                  "Relation Name": "contracts",
                                  "Alias": "k_1",
                                  "Startup Cost": 0.15,
                                  "Total Cost": 8.34,
                                  "Plan Rows": 1,
                                  "Plan Width": 16,
                                  "Actual Startup Time": 0.0,
                                  "Actual Total Time": 0.0,
                                  "Actual Rows": 0,
                                  "Actual Loops": 0,
                                  "Index Cond": "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
                                  "Rows Removed by Index Recheck": 0,
                                  "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (pop_id IS NULL) OR (pop_id = ANY ((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[]))))",
                                  "Rows Removed by Filter": 0,
                                  "Shared Hit Blocks": 0,
                                  "Shared Read Blocks": 0,
                                  "Shared Dirtied Blocks": 0,
                                  "Shared Written Blocks": 0,
                                  "Local Hit Blocks": 0,
                                  "Local Read Blocks": 0,
                                  "Local Dirtied Blocks": 0,
                                  "Local Written Blocks": 0,
                                  "Temp Read Blocks": 0,
                                  "Temp Written Blocks": 0
                                }
                              ]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        },
        {
          "Node Type": "Aggregate",
          "Strategy": "Plain",
          "Partial Mode": "Simple",
          "Parent Relationship": "Inner",
          "Parallel Aware": false,
          "Async Capable": false,
          "Startup Cost": 25.05,
          "Total Cost": 25.06,
          "Plan Rows": 1,
          "Plan Width": 8,
          "Actual Startup Time": 0.007,
          "Actual Total Time": 0.007,
          "Actual Rows": 1,
          "Actual Loops": 7,
          "Shared Hit Blocks": 20,
          "Shared Read Blocks": 0,
          "Shared Dirtied Blocks": 0,
          "Shared Written Blocks": 0,
          "Local Hit Blocks": 0,
          "Local Read Blocks": 0,
          "Local Dirtied Blocks": 0,
          "Local Written Blocks": 0,
          "Temp Read Blocks": 0,
          "Temp Written Blocks": 0,
          "Plans": [
            {
              "Node Type": "Result",
              "Parent Relationship": "Outer",
              "Parallel Aware": false,
              "Async Capable": false,
              "Startup Cost": 0.28,
              "Total Cost": 25.04,
              "Plan Rows": 1,
              "Plan Width": 4,
              "Actual Startup Time": 0.006,
              "Actual Total Time": 0.007,
              "Actual Rows": 1,
              "Actual Loops": 7,
              "One-Time Filter": "((NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid = i.tenant_id)",
              "Shared Hit Blocks": 20,
              "Shared Read Blocks": 0,
              "Shared Dirtied Blocks": 0,
              "Shared Written Blocks": 0,
              "Local Hit Blocks": 0,
              "Local Read Blocks": 0,
              "Local Dirtied Blocks": 0,
              "Local Written Blocks": 0,
              "Temp Read Blocks": 0,
              "Temp Written Blocks": 0,
              "Plans": [
                {
                  "Node Type": "Index Scan",
                  "Parent Relationship": "Outer",
                  "Parallel Aware": false,
                  "Async Capable": false,
                  "Scan Direction": "Forward",
                  "Index Name": "payments_tenant_invoice_identity_uq",
                  "Relation Name": "payments",
                  "Alias": "py",
                  "Startup Cost": 0.28,
                  "Total Cost": 25.04,
                  "Plan Rows": 1,
                  "Plan Width": 4,
                  "Actual Startup Time": 0.005,
                  "Actual Total Time": 0.005,
                  "Actual Rows": 1,
                  "Actual Loops": 7,
                  "Index Cond": "((tenant_id = i.tenant_id) AND (invoice_id = i.id))",
                  "Rows Removed by Index Recheck": 0,
                  "Filter": "(((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (SubPlan 11))",
                  "Rows Removed by Filter": 0,
                  "Shared Hit Blocks": 20,
                  "Shared Read Blocks": 0,
                  "Shared Dirtied Blocks": 0,
                  "Shared Written Blocks": 0,
                  "Local Hit Blocks": 0,
                  "Local Read Blocks": 0,
                  "Local Dirtied Blocks": 0,
                  "Local Written Blocks": 0,
                  "Temp Read Blocks": 0,
                  "Temp Written Blocks": 0,
                  "Plans": [
                    {
                      "Node Type": "Index Scan",
                      "Parent Relationship": "SubPlan",
                      "Subplan Name": "SubPlan 11",
                      "Parallel Aware": false,
                      "Async Capable": false,
                      "Scan Direction": "Forward",
                      "Index Name": "invoices_pkey",
                      "Relation Name": "invoices",
                      "Alias": "i_2",
                      "Startup Cost": 0.28,
                      "Total Cost": 16.73,
                      "Plan Rows": 1,
                      "Plan Width": 0,
                      "Actual Startup Time": 0.0,
                      "Actual Total Time": 0.0,
                      "Actual Rows": 0,
                      "Actual Loops": 0,
                      "Index Cond": "(id = py.invoice_id)",
                      "Rows Removed by Index Recheck": 0,
                      "Filter": "((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (hashed SubPlan 10)))",
                      "Rows Removed by Filter": 0,
                      "Shared Hit Blocks": 0,
                      "Shared Read Blocks": 0,
                      "Shared Dirtied Blocks": 0,
                      "Shared Written Blocks": 0,
                      "Local Hit Blocks": 0,
                      "Local Read Blocks": 0,
                      "Local Dirtied Blocks": 0,
                      "Local Written Blocks": 0,
                      "Temp Read Blocks": 0,
                      "Temp Written Blocks": 0,
                      "Plans": [
                        {
                          "Node Type": "Index Scan",
                          "Parent Relationship": "SubPlan",
                          "Subplan Name": "SubPlan 10",
                          "Parallel Aware": false,
                          "Async Capable": false,
                          "Scan Direction": "Forward",
                          "Index Name": "contracts_list",
                          "Relation Name": "contracts",
                          "Alias": "k_2",
                          "Startup Cost": 0.15,
                          "Total Cost": 8.34,
                          "Plan Rows": 1,
                          "Plan Width": 16,
                          "Actual Startup Time": 0.0,
                          "Actual Total Time": 0.0,
                          "Actual Rows": 0,
                          "Actual Loops": 0,
                          "Index Cond": "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
                          "Rows Removed by Index Recheck": 0,
                          "Filter": "((((NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid IS NULL) OR (subscriber_id = (NULLIF(current_setting('app.subscriber_id'::text, true), ''::text))::uuid)) AND (((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[] IS NULL) OR (pop_id IS NULL) OR (pop_id = ANY ((NULLIF(string_to_array(NULLIF(current_setting('app.pop_ids'::text, true), ''::text), ','::text), '{}'::text[]))::uuid[]))))",
                          "Rows Removed by Filter": 0,
                          "Shared Hit Blocks": 0,
                          "Shared Read Blocks": 0,
                          "Shared Dirtied Blocks": 0,
                          "Shared Written Blocks": 0,
                          "Local Hit Blocks": 0,
                          "Local Read Blocks": 0,
                          "Local Dirtied Blocks": 0,
                          "Local Written Blocks": 0,
                          "Temp Read Blocks": 0,
                          "Temp Written Blocks": 0
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    "Planning": {
      "Shared Hit Blocks": 41,
      "Shared Read Blocks": 0,
      "Shared Dirtied Blocks": 0,
      "Shared Written Blocks": 0,
      "Local Hit Blocks": 0,
      "Local Read Blocks": 0,
      "Local Dirtied Blocks": 0,
      "Local Written Blocks": 0,
      "Temp Read Blocks": 0,
      "Temp Written Blocks": 0
    },
    "Planning Time": 3.108,
    "Triggers": [],
    "Execution Time": 0.528
  }
]
`
