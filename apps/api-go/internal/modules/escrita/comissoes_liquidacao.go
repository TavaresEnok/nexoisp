package escrita

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/csvx"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

// Liquidação de comissões: aberta (rascunho revisável) → fechada → paga, com
// estorno de liquidação fechada ou paga. A criação congela cada linha apurada
// (origem, regra aplicada e valor em centavos); o relatório lê o valor congelado
// das liquidações fechadas e pagas. Leitura com finance:read, ações com
// finance:write, como o relatório de comissões existente.

// commissionSourcesSQL apura, pelas regras vigentes, cada origem de comissão do
// período: OS concluída (responsável e cada auxiliar) e prospecto ganho.
// $1 início, $2 fim (datas no fuso $3), $4 pessoa (opcional).
const commissionSourcesSQL = `with w as (
	select w.id, w.number, w.kind, w.assignee_id, w.finished_at,
		coalesce(rk.id, rg.id) as rule_id, case when rk.id is not null then rk.os_kind end as rule_os_kind,
		coalesce(rk.assignee_cents, rg.assignee_cents, 0)::bigint as a_cents,
		coalesce(rk.helper_cents, rg.helper_cents, 0)::bigint as h_cents
	from work_orders w
	left join commission_rules rk on rk.active and rk.subject = 'work_order' and rk.os_kind = w.kind
	left join commission_rules rg on rg.active and rg.subject = 'work_order' and rg.os_kind is null
	where w.status = 'done' and w.finished_at >= $1::date::timestamp at time zone $3 and w.finished_at < ($2::date + 1)::timestamp at time zone $3
), src as (
	select 'work_order'::text as source_kind, w.id as source_id, 'assignee'::text as role, 'assignee'::text as slot, w.assignee_id as user_id,
		'OS #' || w.number as source_label, w.finished_at as occurred_at, w.kind as os_kind, w.rule_id, w.rule_os_kind, w.a_cents as amount_cents
	from w where w.assignee_id is not null
	union all
	select 'work_order', w.id, 'helper', 'helper:' || h.user_id, h.user_id, 'OS #' || w.number, w.finished_at, w.kind, w.rule_id, w.rule_os_kind, w.h_cents
	from w join work_order_helpers h on h.work_order_id = w.id
	union all
	select 'sale', l.id, 'sale', 'sale', l.owner_id, left('Prospecto ' || l.name, 200), l.updated_at, null, r.id, null, coalesce(r.assignee_cents, 0)::bigint
	from leads l left join commission_rules r on r.active and r.subject = 'sale'
	where l.stage = 'won' and l.owner_id is not null
		and l.updated_at >= $1::date::timestamp at time zone $3 and l.updated_at < ($2::date + 1)::timestamp at time zone $3
)
select s.source_kind, s.source_id, s.role, s.slot, s.user_id, u.name as user_name, s.source_label, s.occurred_at, s.os_kind,
	s.rule_id, s.rule_os_kind, s.amount_cents, c.settlement_id as claim_settlement_id, cs.status as claim_status
from src s join users u on u.id = s.user_id
left join commission_settlement_claims c on c.source_kind = s.source_kind and c.source_id = s.source_id and c.slot = s.slot
left join commission_settlements cs on cs.id = c.settlement_id
where ($4::uuid is null or s.user_id = $4::uuid)`

// commissionFrozenSQL lê as linhas congeladas de liquidações fechadas ou pagas.
const commissionFrozenSQL = `select l.source_kind, l.source_id, l.role, l.user_id, coalesce(u.name, l.user_name) as user_name, l.amount_cents
from commission_settlement_lines l join commission_settlements c on c.id = l.settlement_id left join users u on u.id = l.user_id
where c.status in ('closed', 'paid') and l.occurred_at >= $1::date::timestamp at time zone $3 and l.occurred_at < ($2::date + 1)::timestamp at time zone $3
	and ($4::uuid is null or l.user_id = $4::uuid)`

var settlementStatusLabels = map[string]string{"open": "aberta", "closed": "fechada", "paid": "paga", "reversed": "estornada"}
var settlementMethods = []string{"pix", "transfer", "cash", "payroll", "other"}
var commissionRoleLabels = map[string]string{"assignee": "OS como responsável", "helper": "OS como auxiliar", "sale": "Venda"}

// commissionReport soma, por pessoa, o valor congelado das origens já liquidadas
// (fechadas ou pagas) e o valor pelas regras vigentes das demais.
func commissionReport(ctx context.Context, tx *db.Tx, from, to, tz string, user any) ([]map[string]any, float64, error) {
	current, err := tx.Objects(ctx, commissionSourcesSQL, from, to, tz, user)
	if err != nil {
		return nil, 0, err
	}
	frozen, err := tx.Objects(ctx, commissionFrozenSQL, from, to, tz, user)
	if err != nil {
		return nil, 0, err
	}
	people := []map[string]any{}
	positions := map[string]int{}
	add := func(r jsonx.Object, settled bool) {
		id := jsonx.String(r.Get("user_id"))
		i, exists := positions[id]
		if !exists {
			i = len(people)
			positions[id] = i
			people = append(people, map[string]any{"user_id": id, "name": r.Get("user_name"), "os_assignee": float64(0), "os_assignee_cents": float64(0), "os_helper": float64(0), "os_helper_cents": float64(0), "sales": float64(0), "sales_cents": float64(0), "total_cents": float64(0), "settled_cents": float64(0), "pending_cents": float64(0)})
		}
		prefix := map[string]string{"assignee": "os_assignee", "helper": "os_helper", "sale": "sales"}[jsonx.String(r.Get("role"))]
		cents := num(r.Get("amount_cents"))
		person := people[i]
		person[prefix] = num(person[prefix]) + 1
		person[prefix+"_cents"] = num(person[prefix+"_cents"]) + cents
		person["total_cents"] = num(person["total_cents"]) + cents
		if settled {
			person["settled_cents"] = num(person["settled_cents"]) + cents
		} else {
			person["pending_cents"] = num(person["pending_cents"]) + cents
		}
	}
	for _, r := range current {
		if status := r.Get("claim_status"); status != "closed" && status != "paid" {
			add(r, false)
		}
	}
	for _, r := range frozen {
		add(r, true)
	}
	total := float64(0)
	for _, p := range people {
		total += num(p["total_cents"])
	}
	sort.SliceStable(people, func(i, j int) bool { return num(people[i]["total_cents"]) > num(people[j]["total_cents"]) })
	return people, total, nil
}

func monthBounds(competence string) (string, string, bool) {
	start, err := time.Parse("2006-01", competence)
	if err != nil {
		return "", "", false
	}
	return start.Format("2006-01-02"), start.AddDate(0, 1, -1).Format("2006-01-02"), true
}

const settlementColumns = `c.id, c.number, c.period_from::text as period_from, c.period_to::text as period_to, c.competence, c.user_id, u.name as user_name,
	c.status, c.note, c.timezone, c.created_at, c.closed_at, c.paid_on::text as paid_on, c.paid_method, c.paid_note, c.paid_at, c.reversed_at,
	r.reason as reversal_reason, r.created_at as reversal_at,
	(select count(*)::int from commission_settlement_lines l where l.settlement_id = c.id) as lines_count,
	(select coalesce(sum(l.amount_cents), 0)::bigint from commission_settlement_lines l where l.settlement_id = c.id) as total_cents`
const settlementFrom = ` from commission_settlements c left join users u on u.id = c.user_id left join commission_settlement_reversals r on r.settlement_id = c.id`

func settlementDetail(ctx context.Context, tx *db.Tx, id any) (jsonx.Object, error) {
	row, err := firstRow("liquidação não encontrada")(tx.Objects(ctx, "select "+settlementColumns+settlementFrom+" where c.id = $1", id))
	if err != nil {
		return nil, err
	}
	lines, err := tx.Objects(ctx, `select l.id, l.user_id, l.user_name, l.source_kind, l.source_id, l.role, l.source_label, l.occurred_at, l.os_kind,
			l.rule_id, l.rule_os_kind, l.amount_cents
		from commission_settlement_lines l where l.settlement_id = $1 order by l.user_name, l.occurred_at, l.source_label, l.role, l.id`, id)
	if err != nil {
		return nil, err
	}
	people, err := tx.Objects(ctx, `select l.user_id, min(l.user_name) as name, count(*)::int as lines, sum(l.amount_cents)::bigint as total_cents
		from commission_settlement_lines l where l.settlement_id = $1 group by l.user_id order by 4 desc, 2`, id)
	if err != nil {
		return nil, err
	}
	row.Set("lines", lines)
	row.Set("people", people)
	return row, nil
}

func registerCommissionSettlements(api huma.API, registry *endpoint.Registry, s Service) {
	f, o, str := validate.F, validate.Object, validate.String
	create := o(
		f("competence", str().Pattern(`^\d{4}-(0[1-9]|1[0-2])$`, "use AAAA-MM").Nullish()),
		f("from", dateRule().Nullish()), f("to", dateRule().Nullish()),
		f("user_id", str().UUID().Nullish()),
		f("note", str().Trimmed().Max(500).Def("")),
	)
	pay := o(f("paid_on", dateRule()), f("method", validate.Enum(settlementMethods...)), f("note", str().Trimmed().Max(500).Def("")))
	reverse := o(f("reason", str().Trimmed().Min(5).Max(300)))
	route := func(method, path, permission string, rule *validate.Rule, optionalBody bool, run scopedHandler) {
		routeScoped(api, registry, s, method, path, permission, rule, optionalBody, tenantWide(run))
	}
	lock := func(ctx context.Context, tx *db.Tx, id string, allowed ...string) (jsonx.Object, error) {
		row, err := firstRow("liquidação não encontrada")(tx.Objects(ctx, "select number, status from commission_settlements where id = $1 for update", id))
		if err != nil {
			return nil, err
		}
		status := jsonx.String(row.Get("status"))
		for _, ok := range allowed {
			if status == ok {
				return row, nil
			}
		}
		return nil, apierr.New(409, fmt.Sprintf("liquidação %v está %s", row.Get("number"), settlementStatusLabels[status]))
	}
	write := func(method, path string, rule *validate.Rule, run scopedHandler) {
		route(method, path, "finance:write", rule, false, run)
	}

	route(http.MethodGet, "/api/commission-settlements", "finance:read", nil, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]string, _ map[string]any) (any, error) {
		q := reportQuery(ctx)
		status := q.Enum("status", "all", "all", "open", "closed", "paid", "reversed")
		if err := q.Err(); err != nil {
			return nil, err
		}
		rows, err := tx.Objects(ctx, "select "+settlementColumns+settlementFrom+" where ($1 = 'all' or c.status = $1) order by c.number desc limit 101", status)
		if err != nil {
			return nil, err
		}
		truncated := len(rows) > 100
		if truncated {
			rows = rows[:100]
		}
		return map[string]any{"items": rows, "truncated": truncated}, nil
	})
	route(http.MethodGet, "/api/commission-settlements/{id}", "finance:read", nil, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		return settlementDetail(ctx, tx, p["id"])
	})
	route(http.MethodGet, "/api/commission-settlements/{id}/export.csv", "finance:read", nil, false, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		row, err := settlementDetail(ctx, tx, p["id"])
		if err != nil {
			return nil, err
		}
		lines := []string{"liquidacao;competencia;periodo_inicio;periodo_fim;situacao;pessoa;origem;registro;papel;data;natureza_os;regra_id;valor_centavos"}
		competence := row.Get("competence")
		for _, raw := range row.Get("lines").([]jsonx.Object) {
			occurred := ""
			if at, ok := raw.Get("occurred_at").(jsonx.Time); ok {
				occurred = at.UTC().Format(time.RFC3339)
			}
			cells := []any{row.Get("number"), competence, row.Get("period_from"), row.Get("period_to"), settlementStatusLabels[jsonx.String(row.Get("status"))],
				raw.Get("user_name"), map[string]string{"work_order": "OS", "sale": "Venda"}[jsonx.String(raw.Get("source_kind"))], raw.Get("source_label"),
				commissionRoleLabels[jsonx.String(raw.Get("role"))], occurred, raw.Get("os_kind"), raw.Get("rule_id"), raw.Get("amount_cents")}
			text := make([]string, len(cells))
			for i, cell := range cells {
				text[i] = csvx.Cell(cell)
			}
			lines = append(lines, strings.Join(text, ";"))
		}
		lines = append(lines, strings.Join([]string{csvx.Cell(row.Get("number")), "", "", "", "", "", "", "", csvx.Cell("Total"), "", "", "", csvx.Cell(row.Get("total_cents"))}, ";"))
		if err = record(ctx, tx, "commission_settlement.export", "commission_settlement", p["id"], map[string]any{"lines": len(lines) - 2}); err != nil {
			return nil, err
		}
		return endpoint.Result{CSV: []byte(strings.Join(lines, "\r\n") + "\r\n"), Filename: fmt.Sprintf("liquidacao-comissoes-%v.csv", row.Get("number")), CacheControl: "private, no-store"}, nil
	})
	write(http.MethodPost, "/api/commission-settlements", &create, func(ctx context.Context, tx *db.Tx, _ *http.Request, _ map[string]string, b map[string]any) (any, error) {
		var from, to string
		competence := b["competence"]
		switch {
		case competence != nil && b["from"] == nil && b["to"] == nil:
			from, to, _ = monthBounds(competence.(string))
		case competence == nil && b["from"] != nil && b["to"] != nil:
			from, to = b["from"].(string), b["to"].(string)
		default:
			return nil, apierr.New(400, "informe a competência (AAAA-MM) ou o período com início e fim")
		}
		if to < from {
			return nil, apierr.New(400, "o fim do período é anterior ao início")
		}
		start, _ := time.Parse("2006-01-02", from)
		end, _ := time.Parse("2006-01-02", to)
		if end.Sub(start) > 366*24*time.Hour {
			return nil, apierr.New(400, "período de no máximo 366 dias")
		}
		tz, today, err := tenantClock(ctx, tx)
		if err != nil {
			return nil, err
		}
		if from > today {
			return nil, apierr.New(400, "o período ainda não começou")
		}
		if b["user_id"] != nil {
			found, err := tx.Objects(ctx, "select 1 from users where id = $1 and tenant_id = app_tenant() and role <> 'subscriber'", b["user_id"])
			if err != nil {
				return nil, err
			}
			if len(found) == 0 {
				return nil, apierr.New(400, "pessoa não encontrada neste provedor")
			}
		}
		if err = tx.Exec(ctx, "select pg_advisory_xact_lock(hashtext('commission_settlements:' || app_tenant()::text))"); err != nil {
			return nil, err
		}
		settlement, err := firstRow("liquidação não criada")(tx.Objects(ctx, `insert into commission_settlements (tenant_id, number, period_from, period_to, competence, user_id, timezone, note, created_by)
			values (app_tenant(), coalesce((select max(number) from commission_settlements), 0) + 1, $1::date, $2::date, $3, $4, $5, $6, $7) returning id, number`,
			from, to, competence, b["user_id"], tz, b["note"], nullableUser(auth.From(ctx))))
		if err != nil {
			return nil, err
		}
		id := settlement.Get("id")
		inserted, err := firstRow("")(tx.Objects(ctx, `with src as (`+commissionSourcesSQL+`), pending as (select * from src where claim_settlement_id is null),
			lines as (
				insert into commission_settlement_lines (tenant_id, settlement_id, user_id, user_name, source_kind, source_id, role, source_label, occurred_at, os_kind, rule_id, rule_os_kind, amount_cents)
				select app_tenant(), $5, user_id, user_name, source_kind, source_id, role, source_label, occurred_at, os_kind, rule_id, rule_os_kind, amount_cents from pending
				returning id, source_kind, source_id, role, user_id),
			claims as (
				insert into commission_settlement_claims (tenant_id, source_kind, source_id, slot, settlement_id, line_id)
				select app_tenant(), source_kind, source_id, case when role = 'helper' then 'helper:' || user_id else role end, $5, id from lines returning line_id)
			select (select count(*) from claims)::int as lines, (select count(*) from src where claim_settlement_id is not null)::int as skipped`,
			from, to, tz, b["user_id"], id))
		if err != nil {
			return nil, catalogConflict(err, "outra liquidação reservou parte destes registros; tente novamente")
		}
		if num(inserted.Get("lines")) == 0 {
			return nil, apierr.New(409, "nenhuma comissão pendente de liquidação no período")
		}
		detail := map[string]any{"number": settlement.Get("number"), "from": from, "to": to, "user_id": b["user_id"], "lines": inserted.Get("lines"), "skipped": inserted.Get("skipped")}
		if err = record(ctx, tx, "commission_settlement.create", "commission_settlement", id, detail); err != nil {
			return nil, err
		}
		row, err := settlementDetail(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		row.Set("skipped", inserted.Get("skipped"))
		return row, nil
	})
	write(http.MethodDelete, "/api/commission-settlements/{id}", nil, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		row, err := lock(ctx, tx, p["id"], "open")
		if err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, "delete from commission_settlements where id = $1", p["id"]); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "number": row.Get("number")}, record(ctx, tx, "commission_settlement.discard", "commission_settlement", p["id"], map[string]any{"number": row.Get("number")})
	})
	write(http.MethodDelete, "/api/commission-settlements/{id}/lines/{lineId}", nil, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		if _, err := lock(ctx, tx, p["id"], "open"); err != nil {
			return nil, err
		}
		removed, err := tx.Affected(ctx, "delete from commission_settlement_lines where settlement_id = $1 and id = $2", p["id"], p["lineId"])
		if err != nil {
			return nil, err
		}
		if removed == 0 {
			return nil, apierr.New(404, "linha não encontrada nesta liquidação")
		}
		if err = record(ctx, tx, "commission_settlement.line_remove", "commission_settlement", p["id"], map[string]any{"line_id": p["lineId"]}); err != nil {
			return nil, err
		}
		return settlementDetail(ctx, tx, p["id"])
	})
	write(http.MethodPost, "/api/commission-settlements/{id}/close", nil, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, _ map[string]any) (any, error) {
		row, err := lock(ctx, tx, p["id"], "open")
		if err != nil {
			return nil, err
		}
		count, err := firstRow("")(tx.Objects(ctx, "select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as total from commission_settlement_lines where settlement_id = $1", p["id"]))
		if err != nil {
			return nil, err
		}
		if num(count.Get("n")) == 0 {
			return nil, apierr.New(409, "liquidação sem linhas: descarte-a em vez de fechar")
		}
		if err = tx.Exec(ctx, "update commission_settlements set status = 'closed', closed_at = now(), closed_by = $2 where id = $1", p["id"], nullableUser(auth.From(ctx))); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "commission_settlement.close", "commission_settlement", p["id"], map[string]any{"number": row.Get("number"), "total_cents": count.Get("total")}); err != nil {
			return nil, err
		}
		return settlementDetail(ctx, tx, p["id"])
	})
	write(http.MethodPost, "/api/commission-settlements/{id}/pay", &pay, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, b map[string]any) (any, error) {
		row, err := lock(ctx, tx, p["id"], "closed")
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
		if err = tx.Exec(ctx, "update commission_settlements set status = 'paid', paid_on = $2::date, paid_method = $3, paid_note = $4, paid_at = now(), paid_by = $5 where id = $1",
			p["id"], b["paid_on"], b["method"], b["note"], nullableUser(auth.From(ctx))); err != nil {
			return nil, err
		}
		if err = record(ctx, tx, "commission_settlement.pay", "commission_settlement", p["id"], map[string]any{"number": row.Get("number"), "paid_on": b["paid_on"], "method": b["method"]}); err != nil {
			return nil, err
		}
		return settlementDetail(ctx, tx, p["id"])
	})
	write(http.MethodPost, "/api/commission-settlements/{id}/reverse", &reverse, func(ctx context.Context, tx *db.Tx, _ *http.Request, p map[string]string, b map[string]any) (any, error) {
		row, err := lock(ctx, tx, p["id"], "closed", "paid")
		if err != nil {
			return nil, err
		}
		total, err := firstRow("")(tx.Objects(ctx, "select coalesce(sum(amount_cents), 0)::bigint as total from commission_settlement_lines where settlement_id = $1", p["id"]))
		if err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, "insert into commission_settlement_reversals (tenant_id, settlement_id, reason, amount_cents, was_paid, created_by) values (app_tenant(), $1, $2, $3, $4, $5)",
			p["id"], b["reason"], total.Get("total"), row.Get("status") == "paid", nullableUser(auth.From(ctx))); err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, "update commission_settlements set status = 'reversed', reversed_at = now() where id = $1", p["id"]); err != nil {
			return nil, err
		}
		// Libera as origens para uma nova liquidação; linhas e estorno permanecem.
		if err = tx.Exec(ctx, "delete from commission_settlement_claims where settlement_id = $1", p["id"]); err != nil {
			return nil, err
		}
		detail := map[string]any{"number": row.Get("number"), "reason": b["reason"], "amount_cents": total.Get("total"), "was_paid": row.Get("status") == "paid"}
		if err = record(ctx, tx, "commission_settlement.reverse", "commission_settlement", p["id"], detail); err != nil {
			return nil, err
		}
		return settlementDetail(ctx, tx, p["id"])
	})
}
