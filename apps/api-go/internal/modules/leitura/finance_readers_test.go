package leitura

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura/gen"
)

func TestR08ExactJSON(t *testing.T) {
	for _, n := range []int64{0, 2147483648, -2147483648, financeMaxSafeInteger, -financeMaxSafeInteger} {
		raw := fmt.Sprintf(`[{"received_cents":%d}]`, n)
		rows, err := financeDecodeRows(raw)
		if err != nil || len(rows) != 1 || rows[0].Get("received_cents") != n {
			t.Fatalf("integer %d: rows=%v err=%v", n, rows, err)
		}
		encoded, err := jsonx.Encode(rows)
		if err != nil || string(encoded) != raw {
			t.Fatalf("integer %d lost cents in JSON: %s, %v", n, encoded, err)
		}
	}
	for _, n := range []string{"9007199254740992", "9007199254740993", "-9007199254740992", "9223372036854775808", "1.5"} {
		rows, err := financeDecodeRows(`[{"received_cents":` + n + `}]`)
		r08RepresentationError(t, rows, err)
	}
	// Compile-time DTO contract, regenerated from the SQL sources.
	var _ int64 = gen.Readf038858eRow{}.ReceivedMonthCents
	var _ int64 = gen.Group3a79e37d0Row{}.ReceivedCents
}

func r08RepresentationError(t *testing.T, rows []jsonx.Object, err error) {
	t.Helper()
	var api *apierr.Error
	if rows != nil || !errors.As(err, &api) || api.Status != 422 || api.Code != "finance_aggregate_out_of_range" || api.Detail != "" {
		t.Fatalf("expected sanitized explicit range error, got rows=%v err=%v", rows, err)
	}
	if strings.Contains(api.Message, "select") || strings.Contains(api.Message, "9007199") {
		t.Fatalf("range error leaked query or value: %s", api.Message)
	}
}

type r08ErrorRow struct{ err error }

func (row r08ErrorRow) Scan(...any) error                                { return row.err }
func (row r08ErrorRow) QueryRow(context.Context, string, ...any) pgx.Row { return row }

func TestR08SQLOverflowSanitized(t *testing.T) {
	rows, err := financeReadRows(context.Background(), r08ErrorRow{&pgconn.PgError{
		Code: "22003", Message: "bigint out of range", Detail: "private database detail",
	}}, gen.Readf038858e, nil)
	r08RepresentationError(t, rows, err)
}

func TestR08RejectsEntireSeriesOutsideSafeRange(t *testing.T) {
	rows, err := financeDecodeRows(`[{"month":"2026-09","received_cents":2147483648},{"month":"2026-10","received_cents":9007199254740992}]`)
	r08RepresentationError(t, rows, err)
	// The HTTP mapper must retain the explicit error without exposing a partial
	// series, the offending amount or the database failure's private details.
	public := apierr.Map(err)
	body, encodeErr := jsonx.Encode(public)
	if encodeErr != nil || public.Status != 422 || string(body) != `{"error":"agregado financeiro fora do intervalo de representação exata","code":"finance_aggregate_out_of_range"}` {
		t.Fatalf("public representation error: %s, %v", body, encodeErr)
	}
}

// Only temporary synthetic relations in nexo_test. Payments deliberately use
// bigint to reach JS/int64 boundaries without millions of real writer calls.
// No persistent schema, invoice journal, writer or migration is modified.
func r08Postgres(t *testing.T, fn func(context.Context, pgx.Tx, time.Time, time.Time)) {
	t.Helper()
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("PG_REQUIRED") == "1" || os.Getenv("NEXO_BALANCE_READ_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL required; PostgreSQL was NOT RUN")
		}
		t.Skip("NEXO_GO_TEST_DATABASE_URL absent: PostgreSQL NOT RUN; set PG_REQUIRED=1 to forbid SKIP")
	}
	cfg, err := pgx.ParseConfig(url)
	if err != nil || cfg.Database != "nexo_test" || cfg.User != "nexo_go" {
		t.Fatal("fixture requires disposable nexo_test as nexo_go")
	}
	ctx := context.Background()
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal("cannot connect to disposable PostgreSQL (details redacted)")
	}
	defer conn.Close(ctx)
	var database, user string
	if err := conn.QueryRow(ctx, "select current_database(), current_user").Scan(&database, &user); err != nil || database != "nexo_test" || user != "nexo_go" {
		t.Fatal("unexpected database or effective role; fixture refused")
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		t.Fatal("cannot begin synthetic fixture")
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `
set local timezone = 'UTC';
select set_config('app.tenant_id', '19819819-8198-4198-8198-198198198198', true);
create temp table tenant_settings (tenant_id uuid, timezone text) on commit drop;
insert into tenant_settings values ('19819819-8198-4198-8198-198198198198', 'America/Fortaleza');
create temp table invoices (like public.invoices including defaults) on commit drop;
create temp table payments (invoice_id uuid, signed_cents bigint, paid_at timestamptz, tenant_id uuid default app_tenant()) on commit drop;
insert into invoices (id, tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, status, company_id)
values ('11111111-1111-4111-8111-111111111111', app_tenant(), gen_random_uuid(), gen_random_uuid(), 'manual', current_date, 1, 'paid', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
       ('22222222-2222-4222-8222-222222222222', app_tenant(), gen_random_uuid(), gen_random_uuid(), 'manual', current_date, 1, 'paid', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');`)
	if err != nil {
		t.Fatalf("temporary fixture: %s", pgQueryRedact(err))
	}
	var start, end time.Time
	err = tx.QueryRow(ctx, `select date_trunc('month', now() at time zone 'America/Fortaleza') at time zone 'America/Fortaleza',
 (date_trunc('month', now() at time zone 'America/Fortaleza') + interval '1 month') at time zone 'America/Fortaleza'`).Scan(&start, &end)
	if err != nil {
		t.Fatal(pgQueryRedact(err))
	}
	fn(ctx, tx, start, end)
}

func r08Payment(t *testing.T, ctx context.Context, tx pgx.Tx, invoice string, cents int64, at time.Time) {
	t.Helper()
	if _, err := tx.Exec(ctx, "insert into payments (invoice_id, signed_cents, paid_at) values ($1, $2, $3)", invoice, cents, at); err != nil {
		t.Fatal(pgQueryRedact(err))
	}
}

const r08Invoice = "11111111-1111-4111-8111-111111111111"

func TestR08PostgresAggregates(t *testing.T) {
	r08Postgres(t, func(ctx context.Context, tx pgx.Tx, start, end time.Time) {
		cases := []struct {
			name    string
			parts   []int64
			want    int64
			invalid bool
		}{
			{"above-int32", []int64{math.MaxInt32, 1}, 2147483648, false},
			{"negative-reversals", []int64{-math.MaxInt32, -2}, -2147483649, false},
			{"safe-positive", []int64{financeMaxSafeInteger - 1, 1}, financeMaxSafeInteger, false},
			{"safe-negative", []int64{-financeMaxSafeInteger + 1, -1}, -financeMaxSafeInteger, false},
			{"unsafe-positive", []int64{financeMaxSafeInteger, 1}, 0, true},
			{"unsafe-negative", []int64{-financeMaxSafeInteger, -1}, 0, true},
			{"int64-overflow", []int64{math.MaxInt64, 1}, 0, true},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				// SAVEPOINT also recovers from PostgreSQL's bigint cast overflow.
				if _, err := tx.Exec(ctx, "savepoint r08_case"); err != nil {
					t.Fatal(err)
				}
				defer tx.Exec(ctx, "rollback to savepoint r08_case")
				for _, n := range tc.parts {
					r08Payment(t, ctx, tx, r08Invoice, n, start)
				}
				for _, query := range []struct {
					sql, field string
					args       []any
				}{
					{gen.Readf038858e, "received_month_cents", []any{nil}},
					{mustRead(t, "shadow/readf038858e.sql"), "received_month_cents", []any{nil}},
					{gen.Group3a79e37d0, "received_cents", []any{"America/Fortaleza"}},
				} {
					if _, err := tx.Exec(ctx, "savepoint r08_query"); err != nil {
						t.Fatal(err)
					}
					rows, err := financeReadRows(ctx, tx, query.sql, query.args...)
					if tc.invalid {
						r08RepresentationError(t, rows, err)
					} else if err != nil || len(rows) == 0 || rows[len(rows)-1].Get(query.field) != tc.want {
						t.Fatalf("%s want %d rows=%v err=%v", query.field, tc.want, rows, err)
					}
					if _, err := tx.Exec(ctx, "rollback to savepoint r08_query"); err != nil {
						t.Fatal(err)
					}
				}
			})
		}
	})
}

func TestR09PostgresProviderMonth(t *testing.T) {
	r08Postgres(t, func(ctx context.Context, tx pgx.Tx, start, end time.Time) {
		for _, p := range []struct {
			n  int64
			at time.Time
		}{
			{400, start.Add(-time.Microsecond)}, // previous month
			{700, start.Add(-90 * time.Minute)}, // 01:30 UTC day 1 is previous month in Fortaleza
			{2147483647, start},                 // inclusive lower bound
			{-47, start.Add(time.Hour)},         // signed reversal
			{1, end.Add(-time.Microsecond)},     // inclusive final instant
			{900, end},                          // exclusive upper bound
			{800, end.Add(time.Hour)},           // future month
		} {
			r08Payment(t, ctx, tx, r08Invoice, p.n, p.at)
		}
		r08Payment(t, ctx, tx, "22222222-2222-4222-8222-222222222222", 100, start)
		const want int64 = 2147483701
		for _, zone := range []string{"UTC", "Asia/Tokyo"} {
			if _, err := tx.Exec(ctx, "select set_config('TimeZone', $1, true)", zone); err != nil {
				t.Fatal(err)
			}
			summary, err := financeReadRows(ctx, tx, gen.Readf038858e, nil)
			if err != nil || summary[0].Get("received_month_cents") != want {
				t.Fatalf("summary: %v %v", summary, err)
			}
			monthly, err := financeReadRows(ctx, tx, gen.Group3a79e37d0, "America/Fortaleza")
			if err != nil || len(monthly) != 6 || monthly[5].Get("received_cents") != want || monthly[4].Get("received_cents") != int64(1100) {
				t.Fatalf("monthly/boundaries: %v %v", monthly, err)
			}
			filtered, err := financeReadRows(ctx, tx, gen.Readf038858e, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
			if err != nil || filtered[0].Get("received_month_cents") != want-100 {
				t.Fatalf("company filter: %v %v", filtered, err)
			}
			shadow := mustRead(t, "shadow/readf038858e.sql")
			compared, err := financeReadRows(ctx, tx, shadow, nil)
			if err != nil {
				t.Fatal(pgQueryRedact(err))
			}
			for _, field := range summary[0] {
				if compared[0].Get(field.Name) != field.Value {
					t.Fatalf("shadow projection %s differs", field.Name)
				}
			}
		}
		// Missing tenant settings keeps the existing São Paulo fallback. These
		// months share Fortaleza's UTC-03 boundaries; no global test clock.
		if _, err := tx.Exec(ctx, "delete from tenant_settings"); err != nil {
			t.Fatal(err)
		}
		rows, err := financeReadRows(ctx, tx, gen.Readf038858e, nil)
		if err != nil || rows[0].Get("received_month_cents") != want {
			t.Fatalf("fallback: %v %v", rows, err)
		}
		monthly, err := financeReadRows(ctx, tx, gen.Group3a79e37d0, "America/Sao_Paulo")
		if err != nil || len(monthly) != 6 || monthly[5].Get("received_cents") != want {
			t.Fatalf("monthly fallback: %v %v", monthly, err)
		}
	})
}
