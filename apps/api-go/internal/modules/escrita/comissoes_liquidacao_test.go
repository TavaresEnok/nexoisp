package escrita

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
)

func TestCommissionSettlementMonthBounds(t *testing.T) {
	for competence, want := range map[string][2]string{"2024-02": {"2024-02-01", "2024-02-29"}, "2023-12": {"2023-12-01", "2023-12-31"}} {
		from, to, ok := monthBounds(competence)
		if !ok || from != want[0] || to != want[1] {
			t.Fatalf("%s: %s..%s", competence, from, to)
		}
	}
	if _, _, ok := monthBounds("2024-13"); ok {
		t.Fatal("competência inválida aceita")
	}
}

// Congelamento, não duplicidade, transições, estorno, exportação, permissões e
// isolamento entre provedores da liquidação de comissões, com PostgreSQL real.
func TestCommissionSettlementPG(t *testing.T) {
	h := newPGHarness(t, "settle", func(api huma.API, registry *endpoint.Registry, s Service) {
		registerCommissionSettlements(api, registry, s)
		registerCommissionReportForTest(api, registry, s)
	})
	// Competência antiga e aleatória: não colide com dados de demonstração nem com execuções anteriores.
	competence := fmt.Sprintf("%d-%02d", 1980+rand.Intn(40), 1+rand.Intn(12))
	from, to, _ := monthBounds(competence)
	var tech1, tech2, install, repair, lead string
	h.scope(0, func(tx *db.Tx) error {
		for _, target := range []*string{&tech1, &tech2} {
			if e := tx.QueryRow(h.ctx, `insert into users (tenant_id,email,name,password_hash,role) values (app_tenant(),$1,$2,'!','noc') returning id::text`,
				uuid.NewString()+"@example.invalid", "Técnico "+uuid.NewString()[:8]).Scan(target); e != nil {
				return e
			}
		}
		var subscriber string
		if e := tx.QueryRow(h.ctx, "insert into subscribers(tenant_id,name) values(app_tenant(),$1) returning id::text", "Comissão "+uuid.NewString()).Scan(&subscriber); e != nil {
			return e
		}
		for _, order := range []struct {
			target   *string
			kind     string
			day      string
			assignee string
		}{{&install, "install", "10", tech1}, {&repair, "repair", "20", tech2}} {
			if e := tx.QueryRow(h.ctx, `insert into work_orders (tenant_id,number,kind,status,subscriber_id,assignee_id,description,resolution,finished_at)
				values (app_tenant(),(select coalesce(max(number),0)+1 from work_orders),$1,'done',$2,$3,'comissão sintética','concluída',($4 || ' 15:00')::timestamp at time zone 'UTC') returning id::text`,
				order.kind, subscriber, order.assignee, competence+"-"+order.day).Scan(order.target); e != nil {
				return e
			}
		}
		if e := tx.Exec(h.ctx, "insert into work_order_helpers (tenant_id,work_order_id,user_id) values (app_tenant(),$1,$2)", install, tech2); e != nil {
			return e
		}
		if e := tx.QueryRow(h.ctx, `insert into leads (tenant_id,name,email,stage,owner_id,subscriber_id,updated_at)
			values (app_tenant(),'Venda sintética','venda@example.invalid','won',$1,$2,($3 || ' 15:00')::timestamp at time zone 'UTC') returning id::text`,
			tech1, subscriber, competence+"-15").Scan(&lead); e != nil {
			return e
		}
		return setCommissionRules(h, tx, 2500, 500, 1000, 300, 700)
	})
	report := func() map[string]map[string]any {
		r := h.call(actorFinanceReadA, "GET", "/api/reports/commissions?from="+from+"&to="+to, nil, 200)
		people := map[string]map[string]any{}
		for _, raw := range r["rows"].([]any) {
			row := raw.(map[string]any)
			people[row["user_id"].(string)] = row
		}
		return people
	}
	people := report()
	if centsOf(people[tech1]["total_cents"]) != 3200 || centsOf(people[tech2]["total_cents"]) != 1500 || centsOf(people[tech1]["settled_cents"]) != 0 {
		t.Fatalf("apuração pelas regras vigentes: %v / %v", people[tech1], people[tech2])
	}

	// Permissões, escopo e isolamento antes de qualquer liquidação.
	body := map[string]any{"competence": competence, "note": "Fechamento sintético"}
	h.call(actorFinanceReadA, "POST", "/api/commission-settlements", body, 403)
	h.call(actorStockWriteA, "GET", "/api/commission-settlements", nil, 403)
	h.call(actorPopA, "POST", "/api/commission-settlements", body, 403)
	h.call(actorAdminA, "POST", "/api/commission-settlements", map[string]any{"competence": competence, "from": from, "to": to}, 400)
	h.call(actorAdminA, "POST", "/api/commission-settlements", map[string]any{"from": to, "to": from}, 400)
	h.call(actorAdminA, "POST", "/api/commission-settlements", map[string]any{"from": "2023-02-30", "to": "2023-03-01"}, 400)
	h.call(actorAdminA, "POST", "/api/commission-settlements", map[string]any{"competence": competence, "user_id": uuid.NewString()}, 400)

	first := h.call(actorFinanceWriteA, "POST", "/api/commission-settlements", body, 201)
	id := first["id"].(string)
	path := "/api/commission-settlements/" + id
	if first["status"] != "open" || centsOf(first["lines_count"]) != 4 || centsOf(first["total_cents"]) != 4700 {
		t.Fatalf("liquidação criada: %v", first)
	}
	var saleLine string
	for _, raw := range first["lines"].([]any) {
		line := raw.(map[string]any)
		if line["source_kind"] == "work_order" && line["role"] == "assignee" && line["source_id"] == install && (line["rule_id"] == nil || line["rule_os_kind"] != "install" || centsOf(line["amount_cents"]) != 2500) {
			t.Fatalf("regra específica não registrada: %v", line)
		}
		if line["source_id"] == repair && (line["rule_os_kind"] != nil || centsOf(line["amount_cents"]) != 1000) {
			t.Fatalf("regra geral não registrada: %v", line)
		}
		if line["source_kind"] == "sale" {
			saleLine = line["id"].(string)
		}
	}
	// Não duplicidade: nada pendente no período, nem para uma pessoa.
	h.call(actorAdminA, "POST", "/api/commission-settlements", body, 409)
	h.call(actorAdminA, "POST", "/api/commission-settlements", map[string]any{"from": from, "to": to, "user_id": tech1}, 409)
	// Isolamento: outro provedor e sessão restrita a POP não enxergam nem alteram.
	h.call(actorAdminB, "GET", path, nil, 404)
	h.call(actorAdminB, "POST", path+"/close", nil, 404)
	h.call(actorAdminB, "GET", path+"/export.csv", nil, 404)
	h.call(actorPopA, "GET", path, nil, 403)
	for _, raw := range h.call(actorAdminB, "GET", "/api/commission-settlements", nil, 200)["items"].([]any) {
		if raw.(map[string]any)["id"] == id {
			t.Fatal("liquidação de outro provedor listada")
		}
	}
	h.scope(1, func(tx *db.Tx) error {
		rows, e := tx.Objects(h.ctx, "select 1 from commission_settlement_lines where settlement_id = $1 union all select 1 from commission_settlement_claims where settlement_id = $1", id)
		if e == nil && len(rows) != 0 {
			t.Fatal("RLS expôs linhas de outro provedor")
		}
		return e
	})

	// Revisão do rascunho: retirar a venda devolve a origem para apuração futura.
	h.call(actorFinanceReadA, "DELETE", path+"/lines/"+saleLine, nil, 403)
	h.call(actorAdminA, "DELETE", path+"/lines/"+uuid.NewString(), nil, 404)
	revised := h.call(actorAdminA, "DELETE", path+"/lines/"+saleLine, nil, 200)
	if centsOf(revised["total_cents"]) != 4000 || centsOf(revised["lines_count"]) != 3 {
		t.Fatalf("revisão: %v", revised)
	}

	// Congelamento: a regra muda depois do fechamento e o período fechado não muda.
	h.call(actorFinanceReadA, "POST", path+"/close", nil, 403)
	closed := h.call(actorAdminA, "POST", path+"/close", nil, 200)
	if closed["status"] != "closed" || closed["closed_at"] == nil {
		t.Fatalf("fechamento: %v", closed)
	}
	h.scope(0, func(tx *db.Tx) error { return setCommissionRules(h, tx, 9999, 888, 7777, 666, 555) })
	people = report()
	if centsOf(people[tech1]["total_cents"]) != 2500+555 || centsOf(people[tech1]["settled_cents"]) != 2500 || centsOf(people[tech1]["pending_cents"]) != 555 {
		t.Fatalf("período fechado deveria manter 2500 congelados e a venda pela regra nova: %v", people[tech1])
	}
	if centsOf(people[tech2]["total_cents"]) != 1500 || centsOf(people[tech2]["pending_cents"]) != 0 {
		t.Fatalf("auxiliar e responsável congelados: %v", people[tech2])
	}
	detail := h.call(actorFinanceReadA, "GET", path, nil, 200)
	if centsOf(detail["total_cents"]) != 4000 || len(detail["people"].([]any)) != 2 {
		t.Fatalf("detalhe congelado: %v", detail)
	}
	// Imutável pela API e pelo banco.
	h.call(actorAdminA, "DELETE", path+"/lines/"+detail["lines"].([]any)[0].(map[string]any)["id"].(string), nil, 409)
	h.call(actorAdminA, "DELETE", path, nil, 409)
	h.call(actorAdminA, "POST", path+"/close", nil, 409)
	for _, statement := range []string{
		"update commission_settlement_lines set amount_cents = 1 where settlement_id = $1",
		"delete from commission_settlement_lines where settlement_id = $1",
		"delete from commission_settlements where id = $1",
		"update commission_settlements set status = 'open', closed_at = null where id = $1",
		"update commission_settlements set period_to = period_to + 1 where id = $1",
	} {
		err := h.d.WithScope(h.ctx, scopeOf(h, 0), func(tx *db.Tx) error { return tx.Exec(h.ctx, statement, id) })
		if err == nil {
			t.Fatalf("banco aceitou alteração de período fechado: %s", statement)
		}
	}

	// A venda devolvida entra numa segunda liquidação; o restante não se repete.
	second := h.call(actorAdminA, "POST", "/api/commission-settlements", map[string]any{"from": from, "to": to, "user_id": tech1}, 201)
	if centsOf(second["lines_count"]) != 1 || centsOf(second["total_cents"]) != 555 || centsOf(second["skipped"]) != 1 {
		t.Fatalf("segunda liquidação deveria ter só a venda: %v", second)
	}
	// Rascunho descartado libera a origem; recriado, volta a reservá-la.
	h.call(actorAdminA, "DELETE", "/api/commission-settlements/"+second["id"].(string), nil, 200)
	h.call(actorAdminA, "GET", "/api/commission-settlements/"+second["id"].(string), nil, 404)
	second = h.call(actorAdminA, "POST", "/api/commission-settlements", map[string]any{"competence": competence}, 201)
	if centsOf(second["lines_count"]) != 1 {
		t.Fatalf("rascunho descartado deveria liberar a venda: %v", second)
	}

	// Pagamento: só de liquidação fechada, data não futura, forma válida; depois imutável.
	h.call(actorAdminA, "POST", "/api/commission-settlements/"+second["id"].(string)+"/pay", map[string]any{"paid_on": "2024-01-10", "method": "pix"}, 409)
	h.call(actorAdminA, "POST", path+"/pay", map[string]any{"paid_on": "2999-01-01", "method": "pix"}, 400)
	h.call(actorAdminA, "POST", path+"/pay", map[string]any{"paid_on": "2024-01-10", "method": "cheque"}, 400)
	h.call(actorFinanceReadA, "POST", path+"/pay", map[string]any{"paid_on": "2024-01-10", "method": "pix"}, 403)
	paid := h.call(actorFinanceWriteA, "POST", path+"/pay", map[string]any{"paid_on": "2024-01-10", "method": "payroll", "note": "Folha sintética"}, 200)
	if paid["status"] != "paid" || paid["paid_on"] != "2024-01-10" || paid["paid_method"] != "payroll" {
		t.Fatalf("pagamento: %v", paid)
	}
	h.call(actorAdminA, "POST", path+"/pay", map[string]any{"paid_on": "2024-01-11", "method": "pix"}, 409)

	// Exportação CSV com linhas congeladas e total.
	csv := h.request(actorFinanceReadA, "GET", path+"/export.csv", nil)
	text := string(csv.body)
	if csv.status != 200 || !strings.HasPrefix(csv.header.Get("Content-Type"), "text/csv") || !strings.Contains(csv.header.Get("Content-Disposition"), "liquidacao-comissoes-") ||
		!strings.HasPrefix(text, "liquidacao;competencia;") || strings.Count(text, "\r\n") != 5 || !strings.Contains(text, `;"2500"`+"\r\n") || !strings.HasSuffix(text, `;"Total";;;;"4000"`+"\r\n") || !strings.Contains(text, `;"paga";`) {
		t.Fatalf("CSV: %d %s", csv.status, text)
	}

	// Estorno: exige motivo, gera registro, preserva linhas e libera as origens.
	h.call(actorAdminA, "POST", path+"/reverse", map[string]any{"reason": "x"}, 400)
	h.call(actorFinanceReadA, "POST", path+"/reverse", map[string]any{"reason": "Pagamento em duplicidade"}, 403)
	reversed := h.call(actorAdminA, "POST", path+"/reverse", map[string]any{"reason": "Pagamento em duplicidade"}, 200)
	if reversed["status"] != "reversed" || reversed["reversal_reason"] != "Pagamento em duplicidade" || centsOf(reversed["lines_count"]) != 3 || centsOf(reversed["total_cents"]) != 4000 || reversed["paid_on"] != "2024-01-10" {
		t.Fatalf("estorno: %v", reversed)
	}
	h.call(actorAdminA, "POST", path+"/reverse", map[string]any{"reason": "Outra tentativa"}, 409)
	h.scope(0, func(tx *db.Tx) error {
		rows, e := tx.Objects(h.ctx, "select was_paid, amount_cents from commission_settlement_reversals where settlement_id = $1", id)
		if e != nil {
			return e
		}
		if len(rows) != 1 || rows[0].Get("was_paid") != true || centsOf(rows[0].Get("amount_cents")) != 4000 {
			t.Fatalf("registro de estorno: %v", rows)
		}
		return nil
	})
	if err := h.d.WithScope(h.ctx, scopeOf(h, 0), func(tx *db.Tx) error {
		return tx.Exec(h.ctx, "delete from commission_settlement_reversals where settlement_id = $1", id)
	}); err == nil {
		t.Fatal("estorno apagado")
	}
	people = report()
	if centsOf(people[tech1]["total_cents"]) != 9999+555 || centsOf(people[tech1]["settled_cents"]) != 0 {
		t.Fatalf("estorno deveria devolver as origens à apuração vigente: %v", people[tech1])
	}
	third := h.call(actorAdminA, "POST", "/api/commission-settlements", map[string]any{"competence": competence}, 201)
	if centsOf(third["lines_count"]) != 3 || centsOf(third["total_cents"]) != 9999+888+7777 {
		t.Fatalf("origens estornadas deveriam entrar em nova liquidação pela regra vigente: %v", third)
	}
	listing := h.call(actorFinanceReadA, "GET", "/api/commission-settlements?status=reversed", nil, 200)
	found := false
	for _, raw := range listing["items"].([]any) {
		item := raw.(map[string]any)
		if item["status"] != "reversed" {
			t.Fatalf("filtro de situação: %v", item)
		}
		found = found || item["id"] == id
	}
	if !found {
		t.Fatal("liquidação estornada fora da lista")
	}
	h.call(actorAdminA, "GET", "/api/commission-settlements?status=qualquer", nil, 400)
}

// setCommissionRules substitui as regras vigentes do provedor no escopo de tx.
func setCommissionRules(h *pgHarness, tx *db.Tx, install, installHelper, general, generalHelper, sale int) error {
	if e := tx.Exec(h.ctx, "update commission_rules set active = false where active"); e != nil {
		return e
	}
	return tx.Exec(h.ctx, `insert into commission_rules (tenant_id,subject,os_kind,assignee_cents,helper_cents) values
		(app_tenant(),'work_order','install',$1,$2),(app_tenant(),'work_order',null,$3,$4),(app_tenant(),'sale',null,$5,0)`,
		install, installHelper, general, generalHelper, sale)
}
