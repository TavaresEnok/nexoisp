package escrita

import (
	"context"
	"fmt"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// Contas a pagar. Os títulos nascem do recebimento de um pedido de compra ou de
// lançamento manual e seguem aberto → pago ou aberto → cancelado; título baixado
// ou cancelado é imutável (gatilho payable_guard). Leitura com finance:read e
// ações com finance:write: o título é obrigação financeira do provedor, mesmo
// quando nasce no estoque; o recebimento do pedido continua exigindo stock:write.

const payableColumns = `p.id, p.number, p.supplier_id, s.name as supplier_name, p.purchase_order_id, o.number as purchase_order_number,
	p.description, p.installment, p.installments, p.amount_cents, p.due_date::text as due_date, p.status,
	p.paid_on::text as paid_on, p.paid_method, p.paid_note, p.paid_at, p.canceled_at, p.cancel_reason, p.created_at,
	(p.status = 'open' and p.due_date < $1::date) as overdue`
const payableFrom = ` from payables p left join suppliers s on s.id = p.supplier_id left join purchase_orders o on o.id = p.purchase_order_id`

var payableMethods = []string{"pix", "boleto", "transfer", "cash", "card", "other"}

// createPayables divide total em parcelas mensais; os centavos que sobram da
// divisão vão para as primeiras parcelas, então a soma é exatamente o total.
func createPayables(ctx context.Context, tx *db.Tx, supplier, order any, description string, total int64, firstDue string, installments int) ([]jsonx.Object, error) {
	if installments < 1 || installments > 24 {
		return nil, apierr.New(400, "parcelas: de 1 a 24")
	}
	if total < int64(installments) {
		return nil, apierr.New(400, "valor menor que um centavo por parcela")
	}
	if err := tx.Exec(ctx, "select pg_advisory_xact_lock(hashtext('payables:' || app_tenant()::text))"); err != nil {
		return nil, err
	}
	base, rest := total/int64(installments), total%int64(installments)
	ids := []any{}
	for i := 1; i <= installments; i++ {
		amount := base
		if int64(i) <= rest {
			amount++
		}
		text := description
		if installments > 1 {
			text = fmt.Sprintf("%s · parcela %d/%d", description, i, installments)
		}
		row, err := firstRow("título não criado")(tx.Objects(ctx, `insert into payables (tenant_id, number, supplier_id, purchase_order_id, description, installment, installments, amount_cents, due_date, created_by)
			values (app_tenant(), coalesce((select max(number) from payables), 0) + 1, $1, $2, $3, $4, $5, $6, ($7::date + make_interval(months => $9::int))::date, $8) returning id`,
			supplier, order, text, i, installments, amount, firstDue, nullableUser(auth.From(ctx)), i-1))
		if err != nil {
			return nil, catalogConflict(err, "o pedido já gerou títulos a pagar")
		}
		ids = append(ids, row.Get("id"))
	}
	_, today, err := tenantClock(ctx, tx)
	if err != nil {
		return nil, err
	}
	return tx.Objects(ctx, "select "+payableColumns+payableFrom+" where p.id = any($2::uuid[]) order by p.installment", today, ids)
}

func registerPayables(api huma.API, registry *endpoint.Registry, s Service) {
	f, o, str, n := validate.F, validate.Object, validate.String, validate.Number
	create := o(
		f("supplier_id", str().UUID().Nullish()),
		f("description", str().Trimmed().Min(3).Max(160)),
		f("amount_cents", n().Int().Min(1).Max(100000000000)),
		f("due_date", dateRule()),
		f("installments", n().Int().Min(1).Max(24).Def(float64(1))),
	)
	pay := o(f("paid_on", dateRule()), f("method", validate.Enum(payableMethods...)), f("note", str().Trimmed().Max(300).Def("")))
	cancel := o(f("reason", str().Trimmed().Min(5).Max(300)))
	route := func(method, path, permission string, rule *validate.Rule, optionalBody bool, run scopedHandler) {
		routeScoped(api, registry, s, method, path, permission, rule, optionalBody, tenantWide(run))
	}

	route(http.MethodGet, "/api/finance/payables", "finance:read", nil, false, func(ctx context.Context, tx *db.Tx, r *http.Request, _ map[string]string, _ map[string]any) (any, error) {
		q := reportQuery(ctx)
		status := q.Enum("status", "all", "all", "open", "overdue", "paid", "canceled")
		supplier := q.UUID("supplier_id", false)
		from, to := queryDate(&q, "due_from"), queryDate(&q, "due_to")
		if err := q.Err(); err != nil {
			return nil, err
		}
		if from != "" && to != "" && to < from {
			return nil, apierr.New(400, "o fim do vencimento é anterior ao início")
		}
		_, today, err := tenantClock(ctx, tx)
		if err != nil {
			return nil, err
		}
		where := ` where ($2 = 'all' or ($2 = 'overdue' and p.status = 'open' and p.due_date < $1::date) or p.status = $2)
			and ($3::uuid is null or p.supplier_id = $3::uuid) and ($4::date is null or p.due_date >= $4::date) and ($5::date is null or p.due_date <= $5::date)`
		args := []any{today, status, textNil(supplier), textNil(from), textNil(to)}
		rows, err := tx.Objects(ctx, "select "+payableColumns+payableFrom+where+" order by p.due_date, p.number limit 201", args...)
		if err != nil {
			return nil, err
		}
		truncated := len(rows) > 200
		if truncated {
			rows = rows[:200]
		}
		totals, err := firstRow("")(tx.Objects(ctx, `select
			coalesce(sum(p.amount_cents) filter (where p.status = 'open'), 0)::bigint as open_cents,
			count(*) filter (where p.status = 'open')::int as open_count,
			coalesce(sum(p.amount_cents) filter (where p.status = 'open' and p.due_date < $1::date), 0)::bigint as overdue_cents,
			count(*) filter (where p.status = 'open' and p.due_date < $1::date)::int as overdue_count,
			coalesce(sum(p.amount_cents) filter (where p.status = 'paid'), 0)::bigint as paid_cents,
			count(*) filter (where p.status = 'paid')::int as paid_count,
			coalesce(sum(p.amount_cents) filter (where p.status = 'canceled'), 0)::bigint as canceled_cents,
			count(*) filter (where p.status = 'canceled')::int as canceled_count
			from payables p`+where, args...))
		if err != nil {
			return nil, err
		}
		suppliers, err := tx.Objects(ctx, "select id, name, active from suppliers order by active desc, name")
		if err != nil {
			return nil, err
		}
		return map[string]any{"items": rows, "truncated": truncated, "totals": totals, "today": today, "suppliers": suppliers}, nil
	})
	route(http.MethodPost, "/api/finance/payables", "finance:write", &create, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]string, b map[string]any) (any, error) {
		if b["supplier_id"] != nil {
			supplier, err := tx.Objects(ctx, "select active from suppliers where id = $1", b["supplier_id"])
			if err != nil {
				return nil, err
			}
			if len(supplier) == 0 || supplier[0].Get("active") != true {
				return nil, apierr.New(400, "fornecedor não encontrado ou inativo")
			}
		}
		items, err := createPayables(ctx, tx, b["supplier_id"], nil, b["description"].(string), int64(num(b["amount_cents"])), b["due_date"].(string), int(num(b["installments"])))
		if err != nil {
			return nil, err
		}
		detail := map[string]any{"amount_cents": b["amount_cents"], "installments": b["installments"], "supplier_id": b["supplier_id"]}
		if err = record(ctx, tx, "finance.payable_create", "payable", items[0].Get("id"), detail); err != nil {
			return nil, err
		}
		return map[string]any{"items": items}, nil
	})
	lock := func(ctx context.Context, tx *db.Tx, id string) (jsonx.Object, error) {
		row, err := firstRow("título a pagar não encontrado")(tx.Objects(ctx, "select number, status from payables where id = $1 for update", id))
		if err != nil {
			return nil, err
		}
		if row.Get("status") != "open" {
			state := "pago"
			if row.Get("status") == "canceled" {
				state = "cancelado"
			}
			return nil, apierr.New(409, fmt.Sprintf("título %v já está %s", row.Get("number"), state))
		}
		return row, nil
	}
	byID := func(ctx context.Context, tx *db.Tx, id string) (any, error) {
		_, today, err := tenantClock(ctx, tx)
		if err != nil {
			return nil, err
		}
		return firstRow("título a pagar não encontrado")(tx.Objects(ctx, "select "+payableColumns+payableFrom+" where p.id = $2", today, id))
	}
	route(http.MethodPost, "/api/finance/payables/{id}/pay", "finance:write", &pay, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, b map[string]any) (any, error) {
		row, err := lock(ctx, tx, p["id"])
		if err != nil {
			return nil, err
		}
		_, today, err := tenantClock(ctx, tx)
		if err != nil {
			return nil, err
		}
		if b["paid_on"].(string) > today {
			return nil, apierr.New(400, "data do pagamento no futuro")
		}
		if err = tx.Exec(ctx, `update payables set status = 'paid', paid_on = $2::date, paid_method = $3, paid_note = $4, paid_at = now(), paid_by = $5 where id = $1`,
			p["id"], b["paid_on"], b["method"], b["note"], nullableUser(auth.From(ctx))); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "finance.payable_pay", "payable", p["id"], map[string]any{"number": row.Get("number"), "paid_on": b["paid_on"], "method": b["method"]}); err != nil {
			return nil, err
		}
		return byID(ctx, tx, p["id"])
	})
	route(http.MethodPost, "/api/finance/payables/{id}/cancel", "finance:write", &cancel, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, b map[string]any) (any, error) {
		row, err := lock(ctx, tx, p["id"])
		if err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, `update payables set status = 'canceled', canceled_at = now(), canceled_by = $2, cancel_reason = $3 where id = $1`,
			p["id"], nullableUser(auth.From(ctx)), b["reason"]); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "finance.payable_cancel", "payable", p["id"], map[string]any{"number": row.Get("number"), "reason": b["reason"]}); err != nil {
			return nil, err
		}
		return byID(ctx, tx, p["id"])
	})
}
