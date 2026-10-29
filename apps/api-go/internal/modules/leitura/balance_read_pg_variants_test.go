package leitura

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

// errPgVariantsRollback força o rollback da fixture. Não é falha de SQL.
var errPgVariantsRollback = errors.New("pgvariants rollback")

// pgVariantsRole é o papel efetivo fechado da sessão. Só estes dois valores
// existem; o nome não vem do ambiente e não é interpolado em SQL.
type pgVariantsRole uint8

const (
	pgVariantsRoleGo pgVariantsRole = 1 + iota
	pgVariantsRoleApp
)

var pgVariantsIDs = []string{
	balanceReaderInvoiceDetail,
	balanceReaderContractFinanceList,
	balanceReaderContractFinanceTotals,
	balanceReaderReconciliationInvoices,
	balanceReaderFinanceSummary,
	balanceReaderInvoiceList,
	balanceReaderTodayOverdue,
	balanceReaderTerminationQuoteGet,
}

type pgVariantsFixture struct {
	tenant         string
	subscriberName string
	planName       string
	subscriber     string
	contract       string
	emptyContract  string
	pop            string
	otherPop       string
	company        string
	partial        string
	excess         string
	future         string
	reconciling    string
	paid           string
	canceled       string
	today          any
	quoteDate      any
	overdueBefore  int64
	reconBefore    int64
}

type pgVariantsCall struct {
	id           string
	legacy       string
	variant      string
	args         []any
	shape        string
	order        string
	requireMatch bool
	own          []string
}

func TestBalanceReadPGVariants(t *testing.T) {
	pgVariantsWithFixture(t, func(ctx context.Context, tx *db.Tx, fx pgVariantsFixture) error {
		readers := pgVariantsReaders(t)
		var problems []string
		for _, id := range pgVariantsIDs {
			call, err := pgVariantsPrimary(readers[id], fx)
			if err != nil {
				problems = append(problems, err.Error())
				continue
			}
			rows, err := pgVariantsCompare(ctx, tx, call)
			if err != nil {
				problems = append(problems, err.Error())
				continue
			}
			if err = pgVariantsExpectPrimary(id, rows, fx); err != nil {
				problems = append(problems, err.Error())
			}
		}
		if err := pgVariantsInvoicePages(ctx, tx, readers[balanceReaderInvoiceList], fx); err != nil {
			problems = append(problems, err.Error())
		}
		return pgVariantsJoin(problems)
	})
}

func TestBalanceReadPGVariantsEmpty(t *testing.T) {
	pgVariantsWithFixture(t, func(ctx context.Context, tx *db.Tx, fx pgVariantsFixture) error {
		readers := pgVariantsReaders(t)
		var problems []string
		detail, err := pgVariantsPrimary(readers[balanceReaderInvoiceDetail], fx)
		if err != nil {
			return err
		}
		seen, err := pgVariantsCompare(ctx, tx, detail)
		if err != nil {
			return err
		}
		if len(seen) != 1 {
			return fmt.Errorf("invoice-detail da fixture veio vazio antes do caso vazio")
		}
		absent := uuid.NewString()
		none := []pgVariantsCall{
			{id: balanceReaderInvoiceDetail, legacy: readers[balanceReaderInvoiceDetail].legacy, variant: readers[balanceReaderInvoiceDetail].variant, args: []any{absent}, shape: "none", order: "position"},
			pgVariantsListCall(readers[balanceReaderInvoiceList], fx, fx.emptyContract, nil, nil, fx.company, "24", "0", "none", false),
			{id: balanceReaderTerminationQuoteGet, legacy: readers[balanceReaderTerminationQuoteGet].legacy, variant: readers[balanceReaderTerminationQuoteGet].variant, args: []any{absent, fx.quoteDate}, shape: "none", order: "position"},
		}
		for _, call := range none {
			if _, err = pgVariantsCompare(ctx, tx, call); err != nil {
				problems = append(problems, err.Error())
			}
		}
		totals := pgVariantsCall{
			id: balanceReaderContractFinanceTotals, legacy: readers[balanceReaderContractFinanceTotals].legacy, variant: readers[balanceReaderContractFinanceTotals].variant,
			args: []any{fx.emptyContract}, shape: "zero", order: "position", requireMatch: true,
		}
		rows, err := pgVariantsCompare(ctx, tx, totals)
		if err != nil {
			problems = append(problems, err.Error())
		} else if err = pgVariantsExpectZeros(totals.id, rows, pgVariantsTotalFields); err != nil {
			problems = append(problems, err.Error())
		}
		if err = pgVariantsForeignEmpty(ctx, tx, readers, fx); err != nil {
			problems = append(problems, err.Error())
		}
		again, err := pgVariantsCompare(ctx, tx, detail)
		if err != nil {
			return err
		}
		if len(again) != 1 {
			problems = append(problems, "o caso vazio alterou a fatura visível da fixture")
		}
		return pgVariantsJoin(problems)
	})
}

func TestBalanceReadPGVariantsRLS(t *testing.T) {
	pgVariantsWithFixture(t, func(ctx context.Context, tx *db.Tx, fx pgVariantsFixture) error {
		readers := pgVariantsReaders(t)
		detail, err := pgVariantsPrimary(readers[balanceReaderInvoiceDetail], fx)
		if err != nil {
			return err
		}
		if rows, err := pgVariantsCompare(ctx, tx, detail); err != nil || len(rows) != 1 {
			if err != nil {
				return err
			}
			return errors.New("RLS partiu sem a fatura da fixture")
		}
		var problems []string
		foreignPop := pgVariantsCall{id: detail.id, legacy: detail.legacy, variant: detail.variant, args: detail.args, shape: "none", order: "position"}
		if err = pgVariantsUnderScope(ctx, tx, fx.tenant, "", fx.otherPop, foreignPop); err != nil {
			problems = append(problems, "outro POP: "+err.Error())
		}
		if err = pgVariantsUnderScope(ctx, tx, fx.tenant, uuid.NewString(), "", foreignPop); err != nil {
			problems = append(problems, "outro assinante: "+err.Error())
		}
		if err = pgVariantsUnderScope(ctx, tx, uuid.NewString(), "", "", foreignPop); err != nil {
			problems = append(problems, "outro provedor: "+err.Error())
		}
		ownPop := detail
		ownPop.requireMatch = true
		ownPop.shape = "rows"
		if rows, err := pgVariantsScopedRows(ctx, tx, fx.tenant, "", fx.pop, ownPop); err != nil {
			problems = append(problems, "POP da fixture: "+err.Error())
		} else if len(rows) != 1 || fmt.Sprint(rows[0].Get("id")) != fx.excess {
			problems = append(problems, "POP da fixture não devolveu a fatura própria")
		}
		restored, err := pgVariantsCompare(ctx, tx, detail)
		if err != nil {
			return err
		}
		if len(restored) != 1 || fmt.Sprint(restored[0].Get("id")) != fx.excess {
			problems = append(problems, "o escopo RLS não foi desfeito")
		}
		return pgVariantsJoin(problems)
	})
}

func TestBalanceReadPGVariantsApp(t *testing.T) {
	pgVariantsWithRole(t, pgVariantsRoleApp, func(ctx context.Context, tx *db.Tx, fx pgVariantsFixture) error {
		if err := pgVariantsExpectApp(ctx, tx, fx.tenant); err != nil {
			return err
		}
		readers := pgVariantsReaders(t)
		if err := pgVariantsExercise(ctx, tx, readers, fx); err != nil {
			return err
		}
		detail, err := pgVariantsPrimary(readers[balanceReaderInvoiceDetail], fx)
		if err != nil {
			return err
		}
		list, err := pgVariantsPrimary(readers[balanceReaderContractFinanceList], fx)
		if err != nil {
			return err
		}
		if err = pgVariantsOwnVisible(ctx, tx, fx.tenant, "", "", detail, list, fx, "provedor da fixture"); err != nil {
			return err
		}
		if err = pgVariantsOwnVisible(ctx, tx, fx.tenant, fx.subscriber, "", detail, list, fx, "assinante titular"); err != nil {
			return err
		}
		if err = pgVariantsOwnVisible(ctx, tx, fx.tenant, "", fx.pop, detail, list, fx, "POP da fixture"); err != nil {
			return err
		}
		hiddenDetail := detail
		hiddenDetail.shape = "none"
		hiddenDetail.requireMatch = false
		hiddenDetail.own = nil
		hiddenList := list
		hiddenList.shape = "none"
		hiddenList.requireMatch = false
		hiddenList.own = nil
		var problems []string
		foreign := []struct {
			label, tenant, subscriber, pop string
		}{
			{"outro provedor", uuid.NewString(), "", ""},
			{"outro assinante", fx.tenant, uuid.NewString(), ""},
			{"outro POP", fx.tenant, "", fx.otherPop},
		}
		for _, item := range foreign {
			if err = pgVariantsUnderScope(ctx, tx, item.tenant, item.subscriber, item.pop, hiddenDetail); err != nil {
				problems = append(problems, item.label+" detalhe: "+err.Error())
			}
			if err = pgVariantsUnderScope(ctx, tx, item.tenant, item.subscriber, item.pop, hiddenList); err != nil {
				problems = append(problems, item.label+" lista: "+err.Error())
			}
		}
		restored, err := pgVariantsCompare(ctx, tx, detail)
		if err != nil {
			return err
		}
		if len(restored) != 1 || fmt.Sprint(restored[0].Get("id")) != fx.excess {
			problems = append(problems, "o escopo RLS não foi desfeito")
		}
		restoredList, err := pgVariantsCompare(ctx, tx, list)
		if err != nil {
			return err
		}
		if err = pgVariantsExpectIDs(list.id, restoredList, []string{fx.future, fx.paid, fx.reconciling, fx.excess, fx.partial, fx.canceled}); err != nil {
			problems = append(problems, "lista após restaurar: "+err.Error())
		}
		if err = pgVariantsExpectApp(ctx, tx, fx.tenant); err != nil {
			return err
		}
		return pgVariantsJoin(problems)
	})
}

func pgVariantsWithFixture(t *testing.T, fn func(context.Context, *db.Tx, pgVariantsFixture) error) {
	t.Helper()
	pgVariantsWithRole(t, pgVariantsRoleGo, fn)
}

func pgVariantsWithRole(t *testing.T, role pgVariantsRole, fn func(context.Context, *db.Tx, pgVariantsFixture) error) {
	t.Helper()
	if role != pgVariantsRoleGo && role != pgVariantsRoleApp {
		t.Fatal("papel fora do conjunto fechado nexo_go/nexo_app")
	}
	d, scope, secret := pgVariantsDB(t)
	ctx := context.Background()
	err := d.WithScope(ctx, scope, func(tx *db.Tx) error {
		if err := pgVariantsIdentity(ctx, tx, scope); err != nil {
			return err
		}
		zone, err := pgVariantsSetting(ctx, tx, "TimeZone")
		if err != nil {
			return err
		}
		before := cloneVariants(balanceVariants)
		fx, err := pgVariantsSeed(ctx, tx, scope)
		if err != nil {
			return err
		}
		if again, err := pgVariantsSetting(ctx, tx, "TimeZone"); err != nil || again != zone {
			return fmt.Errorf("timezone da sessão mudou de %s para %s", zone, again)
		}
		if err = pgVariantsUseRole(ctx, tx, role); err != nil {
			return err
		}
		if role == pgVariantsRoleApp {
			if err = pgVariantsExpectApp(ctx, tx, fx.tenant); err != nil {
				return err
			}
		}
		if err = fn(ctx, tx, fx); err != nil {
			return err
		}
		if !sameVariants(before, balanceVariants) || len(productionShadowAllowlist()) != 0 || len(productionCutAllowlist()) != 0 || balanceReadDatabaseGate != "pending" {
			return errors.New("registro, allowlist ou gate histórico foram alterados")
		}
		return errPgVariantsRollback
	})
	if errors.Is(err, errPgVariantsRollback) {
		return
	}
	t.Fatal(pgVariantsRedact(err, secret))
}

func pgVariantsDB(t *testing.T) (*db.DB, tenancy.Scope, string) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_BALANCE_READ_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_BALANCE_READ_PG_REQUIRED=1; a ausência não aprova PostgreSQL")
		}
		t.Skip("NEXO_GO_TEST_DATABASE_URL ausente; este skip não aprova PostgreSQL, EXPLAIN nem o corte. A gerência executa com nexo_test e nexo_go.")
	}
	cfg, err := pgconn.ParseConfig(url)
	if err != nil || cfg == nil || cfg.User != "nexo_go" || cfg.Database != "nexo_test" {
		user, database := "", ""
		if cfg != nil {
			user, database = cfg.User, cfg.Database
		}
		detail := "conexão diferente de nexo_test/nexo_go"
		if err != nil {
			detail = pgVariantsRedact(err, url)
		}
		t.Fatalf("URL de teste recusada (usuário %q banco %q): %s", user, database, detail)
	}
	d, err := db.Open(context.Background(), url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatalf("abertura recusada: %s", pgVariantsRedact(err, url))
	}
	t.Cleanup(d.Close)
	var tenant string
	err = d.WithScope(context.Background(), tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(context.Background(), `select tenant_id::text from nexo_go_directory() order by tenant_id limit 1`).Scan(&tenant)
	})
	if err != nil || tenant == "" {
		t.Fatalf("diretório nexo_go: %s", pgVariantsRedact(err, url))
	}
	return d, tenancy.Scope{TenantID: tenant}, url
}

func pgVariantsIdentity(ctx context.Context, tx *db.Tx, scope tenancy.Scope) error {
	var database, current, session, tenant string
	var member bool
	err := tx.QueryRow(ctx, `select current_database(), current_user, session_user::text, pg_has_role(current_user, 'nexo_app', 'member'), app_tenant()::text`).Scan(&database, &current, &session, &member, &tenant)
	if err != nil {
		return err
	}
	if database != "nexo_test" || current != "nexo_go" || session != "nexo_go" || !member || tenant != scope.TenantID {
		return fmt.Errorf("escopo nexo_app recusado: banco=%s current_user=%s session_user=%s membro_nexo_app=%v app_tenant=%s", database, current, session, member, tenant)
	}
	return nil
}

func pgVariantsUseRole(ctx context.Context, tx *db.Tx, role pgVariantsRole) error {
	switch role {
	case pgVariantsRoleGo:
		return nil
	case pgVariantsRoleApp:
		if err := tx.Exec(ctx, `set local role nexo_app`); err != nil {
			return fmt.Errorf("set local role nexo_app: %w", err)
		}
		return nil
	default:
		return errors.New("papel fora do conjunto fechado nexo_go/nexo_app")
	}
}

func pgVariantsExpectApp(ctx context.Context, tx *db.Tx, tenant string) error {
	var database, current, session, seen string
	var super, bypass, owner bool
	err := tx.QueryRow(ctx, `select current_database(), current_user, session_user::text, r.rolsuper, r.rolbypassrls,
		(select pg_get_userbyid(c.relowner) = current_user from pg_class c where c.oid = 'public.invoices'::regclass),
		app_tenant()::text
		from pg_roles r where r.rolname = current_user`).Scan(&database, &current, &session, &super, &bypass, &owner, &seen)
	if err != nil {
		return err
	}
	if database != "nexo_test" || current != "nexo_app" || session != "nexo_go" || super || bypass || owner || seen != tenant {
		return fmt.Errorf("papel efetivo recusado: banco=%s current_user=%s session_user=%s super=%v bypass=%v owner=%v app_tenant=%s", database, current, session, super, bypass, owner, seen)
	}
	return nil
}

func pgVariantsExercise(ctx context.Context, tx *db.Tx, readers map[string]balanceGateReader, fx pgVariantsFixture) error {
	var problems []string
	for _, id := range pgVariantsIDs {
		call, err := pgVariantsPrimary(readers[id], fx)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		rows, err := pgVariantsCompare(ctx, tx, call)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		if len(rows) == 0 {
			problems = append(problems, id+" veio vazio no provedor da fixture")
			continue
		}
		if err = pgVariantsExpectPrimary(id, rows, fx); err != nil {
			problems = append(problems, err.Error())
		}
	}
	if err := pgVariantsInvoicePages(ctx, tx, readers[balanceReaderInvoiceList], fx); err != nil {
		problems = append(problems, err.Error())
	}
	return pgVariantsJoin(problems)
}

func pgVariantsOwnVisible(ctx context.Context, tx *db.Tx, tenant, subscriber, pop string, detail, list pgVariantsCall, fx pgVariantsFixture, label string) error {
	rows, err := pgVariantsScopedRows(ctx, tx, tenant, subscriber, pop, detail)
	if err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	if len(rows) != 1 || fmt.Sprint(rows[0].Get("id")) != fx.excess {
		return fmt.Errorf("%s não devolveu a fatura própria", label)
	}
	listed, err := pgVariantsScopedRows(ctx, tx, tenant, subscriber, pop, list)
	if err != nil {
		return fmt.Errorf("%s lista: %w", label, err)
	}
	if len(listed) == 0 {
		return fmt.Errorf("%s lista vazia", label)
	}
	if err = pgVariantsExpectIDs(list.id, listed, []string{fx.future, fx.paid, fx.reconciling, fx.excess, fx.partial, fx.canceled}); err != nil {
		return fmt.Errorf("%s: %w", label, err)
	}
	return nil
}

func pgVariantsSeed(ctx context.Context, tx *db.Tx, scope tenancy.Scope) (pgVariantsFixture, error) {
	var fx pgVariantsFixture
	fx.tenant = scope.TenantID
	mark := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	fx.subscriberName = "pgvariants " + mark
	fx.planName = "plano pgvariants " + mark
	baseline, err := tx.Objects(ctx, dynamicSQL("/api/today", 3, nil))
	if err != nil {
		return fx, fmt.Errorf("today antes da fixture: %w", err)
	}
	if len(baseline) != 1 {
		return fx, fmt.Errorf("today antes da fixture: %d linhas", len(baseline))
	}
	fx.overdueBefore, err = pgVariantsNumber(baseline[0].Get("overdue"))
	if err != nil {
		return fx, fmt.Errorf("overdue anterior: %w", err)
	}
	fx.reconBefore, err = pgVariantsNumber(baseline[0].Get("reconciling"))
	if err != nil {
		return fx, fmt.Errorf("reconciling anterior: %w", err)
	}
	today, err := tx.Objects(ctx, dynamicSQL("/api/invoices", 0, nil), scope.TenantID)
	if err != nil || len(today) != 1 || today[0].Get("d") == nil {
		return fx, fmt.Errorf("data da lista: %v", err)
	}
	fx.today = today[0].Get("d")
	quote, err := tx.Objects(ctx, dynamicSQL("helper:localToday", 0, nil), 0)
	if err != nil || len(quote) != 1 || quote[0].Get("d") == nil {
		return fx, fmt.Errorf("data da cotação: %v", err)
	}
	fx.quoteDate = quote[0].Get("d")
	err = tx.QueryRow(ctx, `insert into pops (tenant_id, name) values ($1::uuid, $2) returning id::text`, scope.TenantID, "POP pgvariants "+mark).Scan(&fx.pop)
	if err != nil {
		return fx, fmt.Errorf("pop: %w", err)
	}
	err = tx.QueryRow(ctx, `insert into pops (tenant_id, name) values ($1::uuid, $2) returning id::text`, scope.TenantID, "POP pgvariants fora "+mark).Scan(&fx.otherPop)
	if err != nil {
		return fx, fmt.Errorf("pop alheio: %w", err)
	}
	err = tx.QueryRow(ctx, `insert into companies (tenant_id, name) values ($1::uuid, $2) returning id::text`, scope.TenantID, "Empresa pgvariants "+mark).Scan(&fx.company)
	if err != nil {
		return fx, fmt.Errorf("empresa: %w", err)
	}
	err = tx.QueryRow(ctx, `insert into subscribers (tenant_id, name) values ($1::uuid, $2) returning id::text`, scope.TenantID, fx.subscriberName).Scan(&fx.subscriber)
	if err != nil {
		return fx, fmt.Errorf("assinante: %w", err)
	}
	var plan string
	err = tx.QueryRow(ctx, `insert into plans (tenant_id, name) values ($1::uuid, $2) returning id::text`, scope.TenantID, fx.planName).Scan(&plan)
	if err != nil {
		return fx, fmt.Errorf("plano: %w", err)
	}
	var version string
	err = tx.QueryRow(ctx, `insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name) values ($1::uuid, $2::uuid, 1, 10000, 100000, 50000, 'pgv') returning id::text`, scope.TenantID, plan).Scan(&version)
	if err != nil {
		return fx, fmt.Errorf("versão: %w", err)
	}
	err = tx.QueryRow(ctx, `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, pop_id, company_id, loyalty_until, penalty_model, penalty_cents)
		values ($1::uuid, $2::uuid, $3::uuid, 15, $4::uuid, $5::uuid, $6::date + 400, 'fixed', 1500) returning id::text`,
		scope.TenantID, fx.subscriber, version, fx.pop, fx.company, fx.quoteDate).Scan(&fx.contract)
	if err != nil {
		return fx, fmt.Errorf("contrato: %w", err)
	}
	err = tx.QueryRow(ctx, `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day, pop_id, company_id)
		values ($1::uuid, $2::uuid, $3::uuid, 15, $4::uuid, $5::uuid) returning id::text`,
		scope.TenantID, fx.subscriber, version, fx.pop, fx.company).Scan(&fx.emptyContract)
	if err != nil {
		return fx, fmt.Errorf("contrato vazio: %w", err)
	}
	type pgVariantsTitle struct {
		dest     *string
		due      string
		amount   int
		fee      int
		discount int
		status   string
		paid     int
		paidAt   string
	}
	titles := []pgVariantsTitle{
		{&fx.partial, "$7::date - 30", 10000, 500, 1000, "open", 4000, "now() - interval '100 days'"},
		{&fx.excess, "$7::date - 10", 10000, 500, 1000, "open", 12000, "now()"},
		{&fx.future, "$7::date + 15", 9000, 0, 0, "open", 0, ""},
		{&fx.reconciling, "$7::date - 5", 7000, 0, 0, "reconciling", 7000, "now()"},
		{&fx.paid, "$7::date - 3", 8000, 0, 0, "paid", 8000, "now()"},
		{&fx.canceled, "$7::date - 40", 6000, 0, 0, "canceled", 0, ""},
	}
	for _, title := range titles {
		err = tx.QueryRow(ctx, `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, fee_cents, discount_cents, status)
			values ($1::uuid, $2::uuid, $3::uuid, 'manual', `+title.due+`, $4, $5, $6, $8) returning id::text`,
			scope.TenantID, fx.contract, fx.subscriber, title.amount, title.fee, title.discount, fx.today, title.status).Scan(title.dest)
		if err != nil {
			return fx, fmt.Errorf("fatura %s: %w", title.status, err)
		}
		if title.paid == 0 {
			continue
		}
		err = tx.Exec(ctx, `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, source) values ($1::uuid, $2::uuid, $3, `+title.paidAt+`, 'manual')`, scope.TenantID, *title.dest, title.paid)
		if err != nil {
			return fx, fmt.Errorf("pagamento %s: %w", title.status, err)
		}
	}
	return fx, nil
}

func pgVariantsReaders(t *testing.T) map[string]balanceGateReader {
	t.Helper()
	all := balanceGateReaders(t)
	out := make(map[string]balanceGateReader, len(pgVariantsIDs))
	for _, reader := range all {
		if reader.id == balanceReaderInvoiceDue {
			continue
		}
		out[reader.id] = reader
	}
	if len(out) != len(pgVariantsIDs) {
		t.Fatalf("conjunto fechado sem invoice-due: %d", len(out))
	}
	for _, id := range pgVariantsIDs {
		reader, ok := out[id]
		if !ok || reader.legacy == "" || reader.variant == "" {
			t.Fatalf("leitor %s sem SQL canônico", id)
		}
	}
	canonical := dynamicSQL("/api/invoices", 1, map[string]string{"limit": "24", "offset": "0"})
	if out[balanceReaderInvoiceList].legacy != canonical {
		t.Fatal("o legado canônico da lista não é limit 24 offset 0")
	}
	return out
}

func pgVariantsPrimary(reader balanceGateReader, fx pgVariantsFixture) (pgVariantsCall, error) {
	call := pgVariantsCall{id: reader.id, legacy: reader.legacy, variant: reader.variant, shape: "rows", order: "position", requireMatch: true}
	switch reader.id {
	case balanceReaderInvoiceDetail:
		call.args = []any{fx.excess}
		call.own = []string{fx.excess}
	case balanceReaderContractFinanceList:
		call.args = []any{fx.contract}
		call.order = "due_desc"
		call.own = []string{fx.partial, fx.excess, fx.future, fx.reconciling, fx.paid, fx.canceled}
	case balanceReaderContractFinanceTotals:
		call.args = []any{fx.contract}
	case balanceReaderReconciliationInvoices:
		call.order = "due_asc"
		call.requireMatch = false
		call.own = []string{fx.reconciling}
	case balanceReaderFinanceSummary:
		call.args = []any{fx.company}
	case balanceReaderInvoiceList:
		call = pgVariantsListCall(reader, fx, fx.contract, nil, nil, fx.company, "24", "0", "rows", true)
		call.own = []string{fx.partial, fx.excess, fx.future, fx.reconciling, fx.paid, fx.canceled}
		return call, nil
	case balanceReaderTodayOverdue:
		call.requireMatch = false
	case balanceReaderTerminationQuoteGet:
		call.args = []any{fx.contract, fx.quoteDate}
	default:
		return call, fmt.Errorf("leitor fora da frente: %s", reader.id)
	}
	return call, nil
}

func pgVariantsListCall(reader balanceGateReader, fx pgVariantsFixture, contract string, status, q any, company, limit, offset, shape string, match bool) pgVariantsCall {
	legacy := dynamicSQL("/api/invoices", 1, map[string]string{"limit": limit, "offset": offset})
	variant, err := pgVariantsPage(reader.variant, limit, offset)
	call := pgVariantsCall{
		id: reader.id, legacy: legacy, variant: variant, shape: shape, order: "position", requireMatch: match,
		args: []any{pgVariantsNull(contract), status, fx.today, q, pgVariantsNull(company)},
	}
	if err != nil {
		call.variant = reader.variant
		call.shape = "error:" + err.Error()
	}
	return call
}

func pgVariantsInvoicePages(ctx context.Context, tx *db.Tx, reader balanceGateReader, fx pgVariantsFixture) error {
	full := pgVariantsListCall(reader, fx, fx.contract, nil, nil, fx.company, "24", "0", "rows", true)
	if strings.HasPrefix(full.shape, "error:") {
		return errors.New(full.shape)
	}
	all, err := pgVariantsCompare(ctx, tx, full)
	if err != nil {
		return err
	}
	if len(all) < 2 {
		return fmt.Errorf("lista sem página: %d", len(all))
	}
	page := pgVariantsListCall(reader, fx, fx.contract, nil, nil, fx.company, "1", "1", "rows", true)
	got, err := pgVariantsCompare(ctx, tx, page)
	if err != nil {
		return err
	}
	if len(got) != 1 || !reflect.DeepEqual(got[0], all[1]) {
		return fmt.Errorf("limit 1 offset 1 não é a segunda fatura da ordem due_date, created_at, id")
	}
	overdue := pgVariantsListCall(reader, fx, fx.contract, "overdue", nil, fx.company, "24", "0", "rows", true)
	overdue.own = []string{fx.partial, fx.excess}
	rows, err := pgVariantsCompare(ctx, tx, overdue)
	if err != nil {
		return err
	}
	if len(rows) != 2 {
		return fmt.Errorf("filtro overdue: %d linhas", len(rows))
	}
	named := pgVariantsListCall(reader, fx, "", nil, fx.subscriberName, "", "24", "0", "rows", true)
	named.own = full.own
	namedRows, err := pgVariantsCompare(ctx, tx, named)
	if err != nil {
		return err
	}
	if len(namedRows) < len(full.own) {
		return fmt.Errorf("filtro q não trouxe a fixture: %d", len(namedRows))
	}
	miss := pgVariantsListCall(reader, fx, fx.contract, nil, "pgvariants-nenhuma-"+uuid.NewString(), fx.company, "24", "0", "none", false)
	_, err = pgVariantsCompare(ctx, tx, miss)
	return err
}

func pgVariantsForeignEmpty(ctx context.Context, tx *db.Tx, readers map[string]balanceGateReader, fx pgVariantsFixture) error {
	if err := tx.Exec(ctx, "savepoint pgvariants_foreign"); err != nil {
		return err
	}
	if err := pgVariantsSetScope(ctx, tx, uuid.NewString(), "", ""); err != nil {
		_ = tx.Exec(ctx, "rollback to savepoint pgvariants_foreign")
		return err
	}
	var problems []string
	for _, id := range pgVariantsIDs {
		call, err := pgVariantsPrimary(readers[id], fx)
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		call.requireMatch = false
		call.own = nil
		call.shape = "none"
		if id == balanceReaderContractFinanceTotals || id == balanceReaderFinanceSummary || id == balanceReaderTodayOverdue {
			call.shape = "zero"
			call.requireMatch = true
		}
		rows, err := pgVariantsCompare(ctx, tx, call)
		if err != nil {
			problems = append(problems, "provedor alheio "+err.Error())
			continue
		}
		if call.shape == "zero" {
			fields := pgVariantsSummaryFields
			if id == balanceReaderContractFinanceTotals {
				fields = pgVariantsTotalFields
			}
			if id == balanceReaderTodayOverdue {
				fields = pgVariantsTodayFields
			}
			if err = pgVariantsExpectZeros(id, rows, fields); err != nil {
				problems = append(problems, err.Error())
			}
		}
	}
	if err := tx.Exec(ctx, "rollback to savepoint pgvariants_foreign"); err != nil {
		return err
	}
	if err := tx.Exec(ctx, "release savepoint pgvariants_foreign"); err != nil {
		return err
	}
	return pgVariantsJoin(problems)
}

func pgVariantsUnderScope(ctx context.Context, tx *db.Tx, tenant, subscriber, pop string, call pgVariantsCall) error {
	_, err := pgVariantsScopedRows(ctx, tx, tenant, subscriber, pop, call)
	return err
}

func pgVariantsScopedRows(ctx context.Context, tx *db.Tx, tenant, subscriber, pop string, call pgVariantsCall) ([]jsonx.Object, error) {
	if err := tx.Exec(ctx, "savepoint pgvariants_scope"); err != nil {
		return nil, err
	}
	if err := pgVariantsSetScope(ctx, tx, tenant, subscriber, pop); err != nil {
		_ = tx.Exec(ctx, "rollback to savepoint pgvariants_scope")
		return nil, err
	}
	rows, err := pgVariantsCompare(ctx, tx, call)
	if releaseErr := tx.Exec(ctx, "rollback to savepoint pgvariants_scope"); releaseErr != nil && err == nil {
		err = releaseErr
	}
	if releaseErr := tx.Exec(ctx, "release savepoint pgvariants_scope"); releaseErr != nil && err == nil {
		err = releaseErr
	}
	return rows, err
}

func pgVariantsCompare(ctx context.Context, tx *db.Tx, call pgVariantsCall) ([]jsonx.Object, error) {
	if strings.HasPrefix(call.shape, "error:") {
		return nil, errors.New(call.id + " " + call.shape)
	}
	if err := tx.Exec(ctx, "savepoint pgvariants_pair"); err != nil {
		return nil, fmt.Errorf("%s savepoint: %w", call.id, err)
	}
	fail := func(err error) ([]jsonx.Object, error) {
		_ = tx.Exec(ctx, "rollback to savepoint pgvariants_pair")
		_ = tx.Exec(ctx, "release savepoint pgvariants_pair")
		return nil, err
	}
	selected, err := (balanceReadPolicy{
		Mode: "shadow", Shadow: map[string]struct{}{call.id: {}}, Cut: map[string]struct{}{},
		Variants: map[string]string{call.id: call.variant},
	}).pick(call.id, call.legacy)
	if err != nil || !selected.Shadow || selected.SQL != call.variant || selected.Reader != call.id {
		return fail(fmt.Errorf("%s política local: err=%v shadow=%v", call.id, err, selected.Shadow))
	}
	production, err := Pick(call.id, call.legacy)
	if err != nil || production.Shadow || production.SQL != call.legacy {
		return fail(fmt.Errorf("%s produção deixou de ser uma sentença legada: err=%v shadow=%v", call.id, err, production.Shadow))
	}
	if err = pgVariantsExplain(ctx, tx, call.legacy, call.args); err != nil {
		return fail(fmt.Errorf("%s explain legado: %w", call.id, err))
	}
	if err = pgVariantsExplain(ctx, tx, call.variant, call.args); err != nil {
		return fail(fmt.Errorf("%s explain variante: %w", call.id, err))
	}
	legacyRows, err := tx.Objects(ctx, call.legacy, call.args...)
	if err != nil {
		return fail(fmt.Errorf("%s SQL legado: %w", call.id, err))
	}
	variantRows, err := tx.Objects(ctx, call.variant, call.args...)
	if err != nil {
		return fail(fmt.Errorf("%s SQL variante: %w", call.id, err))
	}
	if err = pgVariantsShape(call, legacyRows, variantRows); err != nil {
		return fail(err)
	}
	if err = pgVariantsOwnMatches(call, variantRows); err != nil {
		return fail(err)
	}
	matchBefore := counterValue(call.id, balanceReadMatch)
	mismatchBefore := counterValue(call.id, balanceReadMismatch)
	if err = Strip(selected, variantRows); err != nil {
		return fail(fmt.Errorf("%s Strip: %w", call.id, err))
	}
	if err = pgVariantsNoCompare(call.id, "variante", variantRows); err != nil || pgVariantsNoCompare(call.id, "legado", legacyRows) != nil {
		if err == nil {
			err = pgVariantsNoCompare(call.id, "legado", legacyRows)
		}
		return fail(err)
	}
	matchDelta := counterValue(call.id, balanceReadMatch) - matchBefore
	mismatchDelta := counterValue(call.id, balanceReadMismatch) - mismatchBefore
	counted := 0
	for _, row := range variantRows {
		if len(row) > 0 {
			counted++
		}
	}
	if matchDelta+mismatchDelta != float64(counted) {
		return fail(fmt.Errorf("%s delta local match=%v mismatch=%v linhas=%d", call.id, matchDelta, mismatchDelta, counted))
	}
	if call.requireMatch && (mismatchDelta != 0 || matchDelta != float64(counted)) {
		return fail(fmt.Errorf("%s cmp_matches da fixture: match=%v mismatch=%v", call.id, matchDelta, mismatchDelta))
	}
	if err = pgVariantsBodies(call, legacyRows, variantRows); err != nil {
		return fail(err)
	}
	if err = pgVariantsCasts(call, legacyRows); err != nil {
		return fail(err)
	}
	if err = tx.Exec(ctx, "release savepoint pgvariants_pair"); err != nil {
		return nil, err
	}
	return variantRows, nil
}

func pgVariantsExpectPrimary(id string, rows []jsonx.Object, fx pgVariantsFixture) error {
	switch id {
	case balanceReaderInvoiceDetail:
		if len(rows) != 1 {
			return fmt.Errorf("invoice-detail: %d linhas", len(rows))
		}
		return pgVariantsExpectDetail(rows[0], fx)
	case balanceReaderContractFinanceList:
		return pgVariantsExpectIDs(id, rows, []string{fx.future, fx.paid, fx.reconciling, fx.excess, fx.partial, fx.canceled})
	case balanceReaderContractFinanceTotals:
		return pgVariantsExpectNumbers(id, rows, map[string]int64{
			"open": 3, "overdue": 2, "reconciling": 1,
			"nominal_open_cents": 29000, "received_open_cents": 16000, "received_cents": 31000,
			"open_cents": 14500, "overdue_cents": 5500,
		})
	case balanceReaderReconciliationInvoices:
		return pgVariantsHasID(id, rows, fx.reconciling)
	case balanceReaderFinanceSummary:
		return pgVariantsExpectNumbers(id, rows, map[string]int64{
			"open": 3, "overdue": 2, "reconciling": 1,
			"nominal_open_cents": 29000, "received_open_cents": 16000,
			"open_cents": 14500, "overdue_cents": 5500, "received_month_cents": 27000,
		})
	case balanceReaderInvoiceList:
		return pgVariantsExpectIDs(id, rows, []string{fx.future, fx.paid, fx.reconciling, fx.excess, fx.partial, fx.canceled})
	case balanceReaderTodayOverdue:
		if len(rows) != 1 {
			return fmt.Errorf("today-overdue: %d linhas", len(rows))
		}
		overdue, err := pgVariantsNumber(rows[0].Get("overdue"))
		if err != nil {
			return fmt.Errorf("today-overdue overdue: %w", err)
		}
		recon, err := pgVariantsNumber(rows[0].Get("reconciling"))
		if err != nil {
			return fmt.Errorf("today-overdue reconciling: %w", err)
		}
		if overdue != fx.overdueBefore+2 || recon != fx.reconBefore+1 {
			return fmt.Errorf("today-overdue não somou a fixture: overdue %d->%d reconciling %d->%d", fx.overdueBefore, overdue, fx.reconBefore, recon)
		}
		return nil
	case balanceReaderTerminationQuoteGet:
		return pgVariantsExpectQuote(rows, fx)
	default:
		return fmt.Errorf("sem expectativa: %s", id)
	}
}

func pgVariantsExpectDetail(row jsonx.Object, fx pgVariantsFixture) error {
	paid, err := pgVariantsNumber(row.Get("paid_cents"))
	if err != nil {
		return fmt.Errorf("paid_cents: %w", err)
	}
	amount, err := pgVariantsNumber(row.Get("amount_cents"))
	if err != nil {
		return err
	}
	fee, err := pgVariantsNumber(row.Get("fee_cents"))
	if err != nil {
		return err
	}
	discount, err := pgVariantsNumber(row.Get("discount_cents"))
	if err != nil {
		return err
	}
	if _, ok := row.Get("paid_cents").(int32); !ok {
		return fmt.Errorf("paid_cents perdeu o cast ::int: %T", row.Get("paid_cents"))
	}
	if paid != 12000 || amount != 10000 || fee != 500 || discount != 1000 || row.Get("status") != "open" || row.Get("overdue") != true {
		return fmt.Errorf("detalhe do excesso: paid=%d amount=%d fee=%d discount=%d status=%v overdue=%v", paid, amount, fee, discount, row.Get("status"), row.Get("overdue"))
	}
	if row.Get("subscriber_name") != fx.subscriberName || row.Get("plan_name") != fx.planName || fmt.Sprint(row.Get("id")) != fx.excess {
		return fmt.Errorf("detalhe não é a fatura da fixture")
	}
	return nil
}

func pgVariantsExpectQuote(rows []jsonx.Object, fx pgVariantsFixture) error {
	if len(rows) != 1 {
		return fmt.Errorf("termination-quote-get: %d linhas", len(rows))
	}
	row := rows[0]
	openCount, err := pgVariantsNumber(row.Get("open_count"))
	if err != nil {
		return err
	}
	openCents, err := pgVariantsNumber(row.Get("open_cents"))
	if err != nil {
		return err
	}
	remaining, err := pgVariantsNumber(row.Get("remaining_months"))
	if err != nil {
		return err
	}
	penalty, err := pgVariantsNumber(row.Get("penalty_cents"))
	if err != nil {
		return err
	}
	if row.Get("status") != "active" || row.Get("within_loyalty") != true || row.Get("penalty_model") != "fixed" || openCount != 3 || openCents != 14500 || remaining <= 0 || penalty != 1500 {
		return fmt.Errorf("cotação: status=%v loyalty=%v model=%v open=%d cents=%d months=%d penalty=%d", row.Get("status"), row.Get("within_loyalty"), row.Get("penalty_model"), openCount, openCents, remaining, penalty)
	}
	if _, ok := row.Get("open_cents").(int32); !ok || row.Get("loyalty_until") == nil {
		return fmt.Errorf("cotação perdeu cast ou loyalty_until: cents=%T until=%v", row.Get("open_cents"), row.Get("loyalty_until"))
	}
	return nil
}

var pgVariantsTotalFields = []string{"open", "overdue", "reconciling", "nominal_open_cents", "received_open_cents", "received_cents", "open_cents", "overdue_cents"}
var pgVariantsSummaryFields = []string{"open", "open_cents", "nominal_open_cents", "received_open_cents", "overdue", "overdue_cents", "reconciling", "received_month_cents"}
var pgVariantsTodayFields = []string{"overdue", "overdue_cents", "reconciling"}

func pgVariantsExpectZeros(id string, rows []jsonx.Object, fields []string) error {
	if len(rows) != 1 {
		return fmt.Errorf("%s agregado vazio: %d linhas", id, len(rows))
	}
	for _, field := range fields {
		n, err := pgVariantsNumber(rows[0].Get(field))
		if err != nil || n != 0 {
			return fmt.Errorf("%s %s no vazio: %v err=%v", id, field, rows[0].Get(field), err)
		}
	}
	return nil
}

func pgVariantsExpectNumbers(id string, rows []jsonx.Object, want map[string]int64) error {
	if len(rows) != 1 {
		return fmt.Errorf("%s: %d linhas", id, len(rows))
	}
	for field, value := range want {
		got, err := pgVariantsNumber(rows[0].Get(field))
		if err != nil || got != value {
			return fmt.Errorf("%s %s=%v esperado %d err=%v", id, field, rows[0].Get(field), value, err)
		}
	}
	if id == balanceReaderContractFinanceTotals {
		if _, ok := rows[0].Get("nominal_open_cents").(float64); !ok {
			return fmt.Errorf("totais ganharam cast ::int: %T", rows[0].Get("nominal_open_cents"))
		}
	}
	if id == balanceReaderFinanceSummary {
		if _, ok := rows[0].Get("received_month_cents").(int32); !ok {
			return fmt.Errorf("caixa do mês perdeu ::int: %T", rows[0].Get("received_month_cents"))
		}
	}
	return nil
}

func pgVariantsExpectIDs(id string, rows []jsonx.Object, ids []string) error {
	if len(rows) != len(ids) {
		return fmt.Errorf("%s: %d linhas, fixture %d", id, len(rows), len(ids))
	}
	for i, want := range ids {
		if fmt.Sprint(rows[i].Get("id")) != want {
			return fmt.Errorf("%s posição %d: id %v", id, i, rows[i].Get("id"))
		}
	}
	return nil
}

func pgVariantsHasID(id string, rows []jsonx.Object, want string) error {
	for _, row := range rows {
		if fmt.Sprint(row.Get("id")) == want {
			return nil
		}
	}
	return fmt.Errorf("%s não contém %s (%d linhas)", id, want, len(rows))
}

func pgVariantsShape(call pgVariantsCall, legacy, variant []jsonx.Object) error {
	switch call.shape {
	case "none":
		if len(legacy) != 0 || len(variant) != 0 {
			return fmt.Errorf("%s vazio: legado %d variante %d", call.id, len(legacy), len(variant))
		}
	case "rows", "zero":
		if len(legacy) == 0 || len(variant) == 0 {
			return fmt.Errorf("%s sem linhas: legado %d variante %d", call.id, len(legacy), len(variant))
		}
	default:
		return fmt.Errorf("%s forma desconhecida %s", call.id, call.shape)
	}
	return nil
}

func pgVariantsOwnMatches(call pgVariantsCall, rows []jsonx.Object) error {
	if len(call.own) == 0 {
		return nil
	}
	found := map[string]bool{}
	for _, row := range rows {
		id := fmt.Sprint(row.Get("id"))
		for _, want := range call.own {
			if id == want {
				found[want] = true
				if row.Get("cmp_matches") != true {
					return fmt.Errorf("%s cmp_matches falso na fatura %s", call.id, id)
				}
			}
		}
	}
	for _, want := range call.own {
		if !found[want] {
			return fmt.Errorf("%s não devolveu a fatura %s", call.id, want)
		}
	}
	return nil
}

func pgVariantsBodies(call pgVariantsCall, legacy, variant []jsonx.Object) error {
	if call.order == "position" {
		if len(legacy) != len(variant) {
			return fmt.Errorf("%s linhas legado=%d variante=%d", call.id, len(legacy), len(variant))
		}
		for i := range legacy {
			if err := pgVariantsRow(call.id, i, legacy[i], variant[i]); err != nil {
				return err
			}
		}
		return nil
	}
	if err := pgVariantsDueOrder(call, legacy); err != nil {
		return err
	}
	if err := pgVariantsDueOrder(call, variant); err != nil {
		return err
	}
	left, right := pgVariantsCanon(legacy), pgVariantsCanon(variant)
	if len(left) != len(right) {
		return fmt.Errorf("%s multiconjunto %d/%d", call.id, len(left), len(right))
	}
	for i := range left {
		if left[i] != right[i] {
			return fmt.Errorf("%s ordem de %s é parcial; o multiconjunto difere na entrada %d", call.id, call.order, i)
		}
	}
	return nil
}

func pgVariantsDueOrder(call pgVariantsCall, rows []jsonx.Object) error {
	previous := ""
	for i, row := range rows {
		due, ok := row.Get("due_date").(string)
		if !ok || due == "" {
			return fmt.Errorf("%s linha %d sem due_date para a ordem parcial", call.id, i)
		}
		if i > 0 {
			out := (call.order == "due_asc" && due < previous) || (call.order == "due_desc" && due > previous)
			if out {
				return fmt.Errorf("%s quebrou a ordem %s em %s depois de %s", call.id, call.order, due, previous)
			}
		}
		previous = due
	}
	return nil
}

func pgVariantsRow(id string, index int, left, right jsonx.Object) error {
	if reflect.DeepEqual(left, right) {
		return nil
	}
	limit := len(left)
	if len(right) > limit {
		limit = len(right)
	}
	for i := 0; i < limit; i++ {
		var l, r jsonx.Field
		if i < len(left) {
			l = left[i]
		}
		if i < len(right) {
			r = right[i]
		}
		if i >= len(left) || i >= len(right) || l.Name != r.Name || !reflect.DeepEqual(l.Value, r.Value) {
			return fmt.Errorf("%s linha %d campo %d legado %s=%T(%v) variante %s=%T(%v)", id, index, i, l.Name, l.Value, l.Value, r.Name, r.Value, r.Value)
		}
	}
	return fmt.Errorf("%s linha %d difere", id, index)
}

func pgVariantsCasts(call pgVariantsCall, rows []jsonx.Object) error {
	if call.id == balanceReaderContractFinanceTotals {
		for _, row := range rows {
			if _, ok := row.Get("nominal_open_cents").(float64); !ok {
				return fmt.Errorf("totais nominal_open_cents=%T", row.Get("nominal_open_cents"))
			}
		}
		return nil
	}
	for _, row := range rows {
		value, ok := row.Get("paid_cents").(int32)
		if row.Get("paid_cents") != nil && !ok {
			return fmt.Errorf("%s paid_cents=%T(%v) sem cast ::int", call.id, row.Get("paid_cents"), value)
		}
	}
	return nil
}

func pgVariantsNoCompare(id, side string, rows []jsonx.Object) error {
	for _, row := range rows {
		for _, field := range row {
			if strings.HasPrefix(field.Name, "cmp_") {
				return fmt.Errorf("%s %s vazou %s", id, side, field.Name)
			}
		}
	}
	return nil
}

func pgVariantsExplain(ctx context.Context, tx *db.Tx, sql string, args []any) error {
	body := strings.TrimSpace(sql)
	if strings.HasSuffix(body, ";") {
		body = strings.TrimSpace(strings.TrimSuffix(body, ";"))
	}
	rows, err := tx.Objects(ctx, "explain (format text) "+body, args...)
	if err != nil {
		return err
	}
	if len(rows) == 0 || strings.TrimSpace(fmt.Sprint(rows[0].Get("QUERY PLAN"))) == "" {
		return errors.New("EXPLAIN vazio")
	}
	return nil
}

func pgVariantsPage(sql, limit, offset string) (string, error) {
	if _, err := strconv.Atoi(limit); err != nil || limit == "" || strings.HasPrefix(limit, "-") {
		return "", fmt.Errorf("limit inválido")
	}
	if _, err := strconv.Atoi(offset); err != nil || offset == "" || strings.HasPrefix(offset, "-") {
		return "", fmt.Errorf("offset inválido")
	}
	out := strings.ReplaceAll(strings.ReplaceAll(sql, "{{limit}}", limit), "{{offset}}", offset)
	if strings.Contains(out, "{{") {
		return "", fmt.Errorf("variável SQL não resolvida")
	}
	return out, nil
}

func pgVariantsSetScope(ctx context.Context, tx *db.Tx, tenant, subscriber, pop string) error {
	return tx.Exec(ctx, `select set_config('app.tenant_id', $1, true), set_config('app.is_operator', 'off', true), set_config('app.subscriber_id', $2, true), set_config('app.pop_ids', $3, true)`, tenant, subscriber, pop)
}

func pgVariantsSetting(ctx context.Context, tx *db.Tx, name string) (string, error) {
	var value string
	err := tx.QueryRow(ctx, `select current_setting($1)`, name).Scan(&value)
	return value, err
}

func pgVariantsNull(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func pgVariantsNumber(value any) (int64, error) {
	switch n := value.(type) {
	case int32:
		return int64(n), nil
	case int64:
		return n, nil
	case int:
		return int64(n), nil
	case float64:
		if float64(int64(n)) != n {
			return 0, fmt.Errorf("número não inteiro %v", n)
		}
		return int64(n), nil
	default:
		return 0, fmt.Errorf("tipo %T", value)
	}
}

func pgVariantsCanon(rows []jsonx.Object) []string {
	out := make([]string, len(rows))
	for i, row := range rows {
		var b strings.Builder
		for _, field := range row {
			fmt.Fprintf(&b, "%s=%T:%v\n", field.Name, field.Value, field.Value)
		}
		out[i] = b.String()
	}
	sort.Strings(out)
	return out
}

func pgVariantsJoin(problems []string) error {
	if len(problems) == 0 {
		return nil
	}
	return errors.New(strings.Join(problems, "\n"))
}

func pgVariantsRedact(err error, secret string) string {
	if err == nil {
		return "erro vazio"
	}
	msg := err.Error()
	if secret != "" {
		msg = strings.ReplaceAll(msg, secret, "[dsn]")
	}
	return msg
}
