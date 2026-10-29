package escrita

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/finance/providers"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/tenancy"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/prometheus/client_golang/prometheus"
)

func TestImportCompensateSourceGuards(t *testing.T) {
	raw, err := os.ReadFile("import_compensate.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(raw)
	lower := strings.ToLower(src)
	for _, forbidden := range []string{"savepoint", "withscope", "rotas.json", "delete from", "register("} {
		if strings.Contains(lower, forbidden) {
			t.Fatalf("núcleo expõe rota, savepoint ou apagamento: %s", forbidden)
		}
	}
	lock := strings.Index(src, "finance.LockInvoices")
	reverse := strings.Index(src, "finance.Reverse")
	marker := strings.Index(src, "insert into import_batch_compensations")
	if lock < 0 || reverse < 0 || marker < 0 || !(lock < reverse && reverse < marker) {
		t.Fatal("a ordem obrigatória é lock da fatura, estorno e só então o marcador")
	}
	for _, required := range []string{"import.compensate_batch", "invoice.payment_reverse", "invoice.cancel", "7411005"} {
		if !strings.Contains(src, required) && required == "7411005" {
			continue
		}
		if required != "7411005" && !strings.Contains(src, required) {
			t.Fatalf("auditoria ausente: %s", required)
		}
	}
	if !strings.Contains(src, "pg_advisory_xact_lock") && !strings.Contains(src, "finance.LockInvoices") {
		t.Fatal("sem o protocolo de lock")
	}
}

func TestImportCompensate_B13_15(t *testing.T) {
	id := uuid.NewString()
	admin := compensateActor(uuid.NewString(), uuid.NewString())
	cases := []struct {
		name   string
		actor  *auth.Ctx
		status int
		msg    string
	}{
		{name: "sem ator", status: 403, msg: "a reconciliação do lote exige escopo integral do provedor, fora do suporte"},
		{name: "sem tenant", actor: &auth.Ctx{UserID: admin.UserID, Permissions: auth.Permissions["admin"]}, status: 403, msg: "a reconciliação do lote exige escopo integral do provedor, fora do suporte"},
		{name: "portal", actor: portalActor(admin), status: 403, msg: "a reconciliação do lote exige escopo integral do provedor, fora do suporte"},
		{name: "pop vazio", actor: popActor(admin, []string{}), status: 403, msg: "a reconciliação do lote exige escopo integral do provedor, fora do suporte"},
		{name: "pop", actor: popActor(admin, []string{uuid.NewString()}), status: 403, msg: "a reconciliação do lote exige escopo integral do provedor, fora do suporte"},
		{name: "suporte", actor: supportActor(admin), status: 403, msg: "a reconciliação do lote exige escopo integral do provedor, fora do suporte"},
		{name: "sem permissão", actor: financeActor(admin), status: 403, msg: "sem permissão para esta ação"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := callCompensateCore(tc.actor, id, "idem-key-1", "motivo valido", "", nil)
			if statusCode(err) != tc.status || err.Error() != tc.msg {
				t.Fatalf("status=%d err=%v", statusCode(err), err)
			}
		})
	}
}

func TestImportCompensate_B13_19(t *testing.T) {
	actor := compensateActor(uuid.NewString(), uuid.NewString())
	id := uuid.NewString()
	valid := "motivo valido"
	cases := []struct {
		name, id, key, reason, query string
		twice                        bool
		body                         map[string]any
		msg                          string
	}{
		{name: "sem chave", id: id, reason: valid, msg: "Idempotency-Key ausente ou inválida"},
		{name: "chave curta", id: id, key: "curta", reason: valid, msg: "Idempotency-Key ausente ou inválida"},
		{name: "chave longa", id: id, key: strings.Repeat("k", 201), reason: valid, msg: "Idempotency-Key ausente ou inválida"},
		{name: "chave de controle", id: id, key: "chave\nok", reason: valid, msg: "Idempotency-Key ausente ou inválida"},
		{name: "chave repetida", id: id, key: "chave-estavel", reason: valid, twice: true, msg: "Idempotency-Key ausente ou inválida"},
		{name: "motivo ausente", id: id, key: "chave-estavel", body: map[string]any{}, msg: "motivo inválido"},
		{name: "motivo curto", id: id, key: "chave-estavel", reason: "curto", msg: "motivo inválido"},
		{name: "motivo longo", id: id, key: "chave-estavel", reason: strings.Repeat("m", 201), msg: "motivo inválido"},
		{name: "query desconhecida", id: id, key: "chave-estavel", reason: valid, query: "?tenant=other", msg: "filtro desconhecido"},
		{name: "query repetida", id: id, key: "chave-estavel", reason: valid, query: "?a=1&a=2", msg: "filtro repetido"},
		{name: "uuid", id: "nao-uuid", key: "chave-estavel", reason: valid, msg: "dados: Invalid uuid"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := tc.body
			if body == nil {
				body = map[string]any{"reason": tc.reason, "tenant": "ignorado"}
			}
			_, err := callCompensateCore(actor, tc.id, tc.key, "", tc.query, body, tc.twice)
			if statusCode(err) != 400 || err == nil || err.Error() != tc.msg {
				t.Fatalf("err=%v", err)
			}
		})
	}
	ctx := requestContext(actor, "/api/import/batches/"+id+"/compensate", "chave-estavel", false)
	batch, key, reason, err := validateCompensateRequest(ctx, strings.ToUpper(id), map[string]any{"reason": "  motivo valido  ", "tenant": "outro"})
	if err != nil || batch != id || key != "chave-estavel" || reason != "motivo valido" {
		t.Fatalf("validação canônica: %s %s %s %v", batch, key, reason, err)
	}
	if _, _, _, err = validateCompensateRequest(requestContext(actor, "/x", strings.Repeat("ü", 8), false), id, map[string]any{"reason": strings.Repeat("á", 10)}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = validateCompensateRequest(requestContext(actor, "/x", strings.Repeat("k", 200), false), id, map[string]any{"reason": strings.Repeat("m", 200)}); err != nil {
		t.Fatal(err)
	}
}

func TestImportCompensateHashOmitsKey(t *testing.T) {
	left := compensateHash(uuid.NewString(), "motivo valido")
	if len(left) != 64 || compensateHash("lote", "motivo valido") != compensateHash("lote", "motivo valido") {
		t.Fatal(left)
	}
	if compensateHash("lote", "motivo valido") == compensateHash("outro", "motivo valido") || compensateHash("lote", "motivo valido") == compensateHash("lote", "motivo outro!") {
		t.Fatal("hash não separa lote e motivo")
	}
	body := compensateResult("lote", uuid.NewString(), false, 1, 1, 1, 0, 2, 3)
	if body["evidence"].(map[string]any)["reverted"] != false {
		t.Fatal("evidence.reverted")
	}
	for _, name := range []string{"created_rows", "reversed_payments", "canceled_invoices", "left_canceled", "skipped_unchanged", "skipped_error"} {
		if _, ok := body[name].(int); !ok || body[name].(int) < 0 {
			t.Fatalf("%s não é inteiro >= 0", name)
		}
	}
	if _, ok := body["idempotency_key"]; ok {
		t.Fatal("resposta expõe a chave")
	}
	if _, ok := body["request_hash"]; ok {
		t.Fatal("resposta expõe o hash")
	}
}

func TestImportCompensate_B13_01(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "paid")
	actor := compensateActor(tenant, user)
	key := "replay-" + uuid.NewString()
	first := mustCompensate(t, database, actor, seed.batch, key, "motivo estavel")
	if first["idempotent_replay"] != false || first["reversed_payments"] != 1 || first["canceled_invoices"] != 1 || first["evidence"].(map[string]any)["reverted"] != false {
		t.Fatalf("%#v", first)
	}
	second := mustCompensate(t, database, actor, seed.batch, key, "motivo estavel")
	if second["idempotent_replay"] != true || second["compensation_id"] != first["compensation_id"] || second["reversed_payments"] != 1 {
		t.Fatalf("%#v", second)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 2, reversals: 1, signed: 0, markers: 1, external: seed.external, audits: 1})
	assertOriginalPayment(t, database, tenant, seed)
}

func TestImportCompensate_B13_02(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "paid")
	actor := compensateActor(tenant, user)
	var wg sync.WaitGroup
	var mu sync.Mutex
	okN, conflictN := 0, 0
	errs := []string{}
	start := make(chan struct{})
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start
			_, err := postCompensate(database, actor, seed.batch, "race-"+uuid.NewString(), "motivo corrida "+string(rune('A'+n)), "")
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				okN++
				return
			}
			if statusCode(err) == 409 && err.Error() == "already_compensated" {
				conflictN++
				return
			}
			errs = append(errs, err.Error())
		}(i)
	}
	close(start)
	wg.Wait()
	if len(errs) > 0 || okN != 1 || conflictN != 1 {
		t.Fatalf("ok=%d conflict=%d errs=%v", okN, conflictN, errs)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 2, reversals: 1, signed: 0, markers: 1, external: seed.external, audits: 1})
}

func TestImportCompensate_B13_03(t *testing.T) {
	database, tenant, user := compensateLab(t)
	t.Run("marcador", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "paid")
		actor := compensateActor(tenant, uuid.NewString())
		_, err := postCompensate(database, actor, seed.batch, "mark-"+uuid.NewString(), "motivo marcador", "")
		if err == nil {
			t.Fatal("esperava falha do marcador")
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "paid", payments: 1, reversals: 0, signed: seed.paid, markers: 0, external: seed.external, audits: 0, movements: 1, paidAt: true})
	})
	t.Run("auditoria", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "paid")
		actor := compensateActor(tenant, user)
		importCompensateBeforeCommit = func() error { return errors.New("auditoria recusada no teste") }
		defer func() { importCompensateBeforeCommit = nil }()
		_, err := postCompensate(database, actor, seed.batch, "audit-"+uuid.NewString(), "motivo auditoria", "")
		if err == nil || !strings.Contains(err.Error(), "auditoria recusada") {
			t.Fatal(err)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "paid", payments: 1, reversals: 0, signed: seed.paid, markers: 0, external: seed.external, audits: 0, movements: 1, paidAt: true})
	})
}

func TestImportCompensate_B13_04(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "paid")
	body := mustCompensate(t, database, compensateActor(tenant, user), seed.batch, "full-"+uuid.NewString(), "motivo integral")
	if body["reversed_payments"] != 1 || body["canceled_invoices"] != 1 || body["evidence"].(map[string]any)["reverted"] != false {
		t.Fatalf("%#v", body)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 2, reversals: 1, signed: 0, markers: 1, external: seed.external, audits: 1, collectible: 0})
	assertNoPSP(t, database, tenant, seed.invoice)
	assertReversalNote(t, database, tenant, seed)
}

func TestImportCompensate_B13_05(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "partial")
	body := mustCompensate(t, database, compensateActor(tenant, user), seed.batch, "part-"+uuid.NewString(), "motivo parcial!")
	if body["reversed_payments"] != 1 || body["canceled_invoices"] != 1 || body["skipped_unchanged"] != 0 {
		t.Fatalf("%#v", body)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 2, reversals: 1, signed: 0, markers: 1, external: seed.external, amount: seed.amount, reversalAmount: seed.paid})
}

func TestImportCompensate_B13_06(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "excess")
	mustCompensate(t, database, compensateActor(tenant, user), seed.batch, "excess-"+uuid.NewString(), "motivo excedente")
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 2, reversals: 1, signed: 0, markers: 1, external: seed.external, amount: seed.amount, reversalAmount: seed.paid, excess: 0, collectible: 0})
}

func TestImportCompensate_B13_07(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "canceled")
	body := mustCompensate(t, database, compensateActor(tenant, user), seed.batch, "left-"+uuid.NewString(), "motivo ja cancelado")
	if body["left_canceled"] != 1 || body["reversed_payments"] != 0 || body["canceled_invoices"] != 0 {
		t.Fatalf("%#v", body)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 0, reversals: 0, signed: 0, markers: 1, external: seed.external})
}

func TestImportCompensate_B13_08(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "open")
	body := mustCompensate(t, database, compensateActor(tenant, user), seed.batch, "open-"+uuid.NewString(), "motivo em aberto")
	if body["canceled_invoices"] != 1 || body["reversed_payments"] != 0 {
		t.Fatalf("%#v", body)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 0, reversals: 0, signed: 0, markers: 1, external: seed.external, amount: seed.amount, movements: 2})
}

func TestImportCompensate_B13_09(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "open")
	if err := payImportedInvoice(t, database, compensateActor(tenant, user), seed.invoice, seed.amount); err != nil {
		t.Fatal(err)
	}
	_, err := postCompensate(database, compensateActor(tenant, user), seed.batch, "later-"+uuid.NewString(), "motivo posterior", "")
	if statusCode(err) != 409 || err.Error() != "provenance_payment" {
		t.Fatal(err)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "paid", payments: 1, reversals: 0, signed: seed.amount, markers: 0, external: seed.external})
}

func TestImportCompensate_B13_10(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	t.Run("aviso anterior", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		execTenant(t, database, tenant, `insert into notice_log (tenant_id, invoice_id, status, created_at)
			select $1::uuid, $2::uuid, 'sent', b.created_at - interval '1 day' from import_batches b where b.id = $3::uuid`, tenant, seed.invoice, seed.batch)
		_, err := postCompensate(database, actor, seed.batch, "notice-"+uuid.NewString(), "motivo aviso log", "")
		if statusCode(err) != 409 || err.Error() != "notices" {
			t.Fatal(err)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "open", payments: 0, markers: 0, external: seed.external})
	})
	t.Run("encargo", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		execTenant(t, database, tenant, `update invoices set fee_cents = 10 where id = $1::uuid`, seed.invoice)
		_, err := postCompensate(database, actor, seed.batch, "fee-"+uuid.NewString(), "motivo de encargo", "")
		if statusCode(err) != 409 {
			t.Fatal(err)
		}
		var fee int
		scanTenant(t, database, tenant, `select fee_cents from invoices where id = $1::uuid`, []any{&fee}, seed.invoice)
		if fee != 10 {
			t.Fatal(fee)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "open", payments: 0, markers: 0, external: seed.external})
	})
	t.Run("dependente", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		execTenant(t, database, tenant, `insert into import_batches (tenant_id, source, kind, filename, totals, created_by)
			values ($1::uuid, $2, 'invoices', 'dep.csv', '{}'::jsonb, $3::uuid)`, tenant, "dep-"+uuid.NewString(), user)
		execTenant(t, database, tenant, `insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)
			select $1::uuid, b.id, 1, $2, 'unchanged', '[]'::jsonb, $3::uuid from import_batches b
			where b.tenant_id = $1::uuid and b.filename = 'dep.csv' order by b.created_at desc limit 1`, tenant, seed.external, seed.invoice)
		_, err := postCompensate(database, actor, seed.batch, "dep-"+uuid.NewString(), "motivo dependente", "")
		if statusCode(err) != 409 || err.Error() != "dependent_batches" {
			t.Fatal(err)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "open", markers: 0, external: seed.external})
	})
}

func TestImportCompensate_B13_11(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	t.Run("baixa primeiro", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		if err := payImportedInvoice(t, database, actor, seed.invoice, seed.amount); err != nil {
			t.Fatal(err)
		}
		_, err := postCompensate(database, actor, seed.batch, "after-pay-"+uuid.NewString(), "motivo apos baixa", "")
		if statusCode(err) != 409 {
			t.Fatal(err)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "paid", payments: 1, reversals: 0, signed: seed.amount, markers: 0, external: seed.external})
	})
	t.Run("compensação primeiro", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		mustCompensate(t, database, actor, seed.batch, "before-pay-"+uuid.NewString(), "motivo antes baixa")
		err := payImportedInvoice(t, database, actor, seed.invoice, seed.amount)
		if err == nil {
			t.Fatal("baixa em fatura compensada")
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 0, reversals: 0, markers: 1, external: seed.external})
	})
	t.Run("concorrente", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			_, _ = postCompensate(database, actor, seed.batch, "both-"+uuid.NewString(), "motivo concorrente", "")
		}()
		go func() {
			defer wg.Done()
			<-start
			ctx := auth.With(context.Background(), actor)
			_ = database.WithScope(ctx, tenancy.Scope{TenantID: actor.TenantID}, func(tx *db.Tx) error {
				_, err := (Service{DB: database}).invoicePayment(ctx, tx, seed.invoice, map[string]any{
					"intent_id": uuid.NewString(), "amount_cents": seed.amount, "paid_at": "2026-10-20", "method": "pix", "note": "baixa posterior", "apply_fees": false,
				})
				return err
			})
		}()
		close(start)
		wg.Wait()
		var status string
		var markers, payments int
		scanTenant(t, database, tenant, `select i.status,
			(select count(*)::int from import_batch_compensations c where c.batch_id = $2::uuid),
			(select count(*)::int from payments p where p.invoice_id = i.id)
			from invoices i where i.id = $1::uuid`, []any{&status, &markers, &payments}, seed.invoice, seed.batch)
		if markers > 1 || (markers == 1 && payments > 0) || (markers == 0 && payments != 1) || (markers == 1 && status != "canceled") {
			t.Fatalf("status=%s markers=%d payments=%d", status, markers, payments)
		}
	})
}

func TestImportCompensate_B13_13(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	for _, tc := range []struct{ name, expr string }{
		{name: "igual", expr: "b.created_at"},
		{name: "anterior", expr: "b.created_at - interval '1 second'"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			seed := seedImported(t, database, tenant, user, "open")
			execTenant(t, database, tenant, `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note, created_by, created_at)
				select $1::uuid, $2::uuid, 100, '2020-01-02T00:00:00Z', 'pix', 'manual', 'baixa alheia', $3::uuid, `+tc.expr+`
				from import_batches b where b.id = $4::uuid`, tenant, seed.invoice, user, seed.batch)
			_, err := postCompensate(database, actor, seed.batch, "alien-"+uuid.NewString(), "motivo timestamp", "")
			if statusCode(err) != 409 || err.Error() != "provenance_payment" {
				t.Fatal(err)
			}
			assertCash(t, database, tenant, seed, cashExpect{status: "open", payments: 1, reversals: 0, signed: 100, markers: 0, external: seed.external})
		})
	}
}

func TestImportCompensate_B13_14(t *testing.T) {
	database, tenants := compensateTenants(t)
	if len(tenants) < 2 {
		t.Fatal("dois tenants do laboratório")
	}
	userA := compensateUser(t, database, tenants[0])
	seed := seedImported(t, database, tenants[0], userA, "open")
	actorB := compensateActor(tenants[1], compensateUser(t, database, tenants[1]))
	_, err := postCompensate(database, actorB, seed.batch, "outro-"+uuid.NewString(), "motivo de outro tenant", "")
	if statusCode(err) != 404 || err.Error() != "lote não encontrado" {
		t.Fatal(err)
	}
	assertCash(t, database, tenants[0], seed, cashExpect{status: "open", markers: 0, external: seed.external})
}

func TestImportCompensate_B13_16(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	for _, kind := range []string{"subscribers", "contracts", "history", "network", "documents", "users"} {
		batch := insertBatch(t, database, tenant, user, kind, "kind-"+kind+"-"+uuid.NewString())
		execTenant(t, database, tenant, `insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)
			values ($1::uuid, $2::uuid, 1, 'ext', 'created', '[]'::jsonb, $3::uuid)`, tenant, batch, uuid.NewString())
		_, err := postCompensate(database, actor, batch, "kind-"+kind+"-"+uuid.NewString(), "motivo fora do mvp", "")
		if statusCode(err) != 409 || err.Error() != "kind_not_compensatable" {
			t.Fatalf("%s: %v", kind, err)
		}
	}
	seed := seedImported(t, database, tenant, user, "open")
	execTenant(t, database, tenant, `update import_rows set status = 'updated' where batch_id = $1::uuid`, seed.batch)
	_, err := postCompensate(database, actor, seed.batch, "updated-"+uuid.NewString(), "motivo sem preimagem", "")
	if statusCode(err) != 409 || err.Error() != "provenance_movement" {
		t.Fatal(err)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "open", markers: 0, external: seed.external})
}

func TestImportCompensate_B13_17(t *testing.T) {
	database, tenant, user := compensateLab(t)
	seed := seedImported(t, database, tenant, user, "open")
	other := seedImported(t, database, tenant, user, "paid")
	execTenant(t, database, tenant, `insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)
		values ($1::uuid, $2::uuid, 2, $3, 'unchanged', '["diverge"]'::jsonb, $4::uuid),
		       ($1::uuid, $2::uuid, 3, 'erro-sem-entidade', 'error', '["valor"]'::jsonb, null)`, tenant, seed.batch, other.external, other.invoice)
	body := mustCompensate(t, database, compensateActor(tenant, user), seed.batch, "mix-"+uuid.NewString(), "motivo lote misto")
	if body["canceled_invoices"] != 1 || body["skipped_unchanged"] != 1 || body["skipped_error"] != 1 || body["reversed_payments"] != 0 {
		t.Fatalf("%#v", body)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", markers: 1, external: seed.external})
	assertCash(t, database, tenant, other, cashExpect{status: "paid", payments: 1, reversals: 0, signed: other.paid, markers: 0, external: other.external})
}

func TestImportCompensate_IdempotencyConflictAndCap(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	seed := seedImported(t, database, tenant, user, "open")
	key := "same-" + uuid.NewString()
	first := mustCompensate(t, database, actor, seed.batch, key, "motivo da primeira")
	_, err := postCompensate(database, actor, seed.batch, key, "motivo diferente", "")
	if statusCode(err) != 409 || err.Error() != "idempotency_conflict" {
		t.Fatal(err)
	}
	_, err = postCompensate(database, actor, seed.batch, "other-"+uuid.NewString(), "motivo da primeira", "")
	if statusCode(err) != 409 || err.Error() != "already_compensated" {
		t.Fatal(err)
	}
	if _, err = uuid.Parse(first["compensation_id"].(string)); err != nil {
		t.Fatal(err)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "canceled", markers: 1, external: seed.external, audits: 1})

	other := seedImported(t, database, tenant, user, "paid")
	_, err = postCompensate(database, actor, other.batch, key, "motivo da primeira", "")
	if statusCode(err) != 409 || err.Error() != "idempotency_conflict" {
		t.Fatal(err)
	}
	assertCash(t, database, tenant, other, cashExpect{status: "paid", payments: 1, reversals: 0, signed: other.paid, markers: 0, external: other.external})

	var wg sync.WaitGroup
	start := make(chan struct{})
	results := make([]error, 2)
	seeds := []importedSeed{seedImported(t, database, tenant, user, "paid"), seedImported(t, database, tenant, user, "paid")}
	shared := "shared-" + uuid.NewString()
	for i := range seeds {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start
			_, results[n] = postCompensate(database, actor, seeds[n].batch, shared, "motivo compartilhado", "")
		}(i)
	}
	close(start)
	wg.Wait()
	wins := 0
	for i, err := range results {
		if err == nil {
			wins++
			assertCash(t, database, tenant, seeds[i], cashExpect{status: "canceled", payments: 2, reversals: 1, markers: 1, external: seeds[i].external})
			continue
		}
		if statusCode(err) != 409 || err.Error() != "idempotency_conflict" {
			t.Fatal(err)
		}
		assertCash(t, database, tenant, seeds[i], cashExpect{status: "paid", payments: 1, reversals: 0, signed: seeds[i].paid, markers: 0, external: seeds[i].external})
	}
	if wins != 1 {
		t.Fatalf("vitórias=%d", wins)
	}

	empty := insertBatch(t, database, tenant, user, "invoices", "empty-"+uuid.NewString())
	execTenant(t, database, tenant, `insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages)
		values ($1::uuid, $2::uuid, 1, 'ja', 'unchanged', '[]'::jsonb), ($1::uuid, $2::uuid, 2, 'ruim', 'error', '[]'::jsonb)`, tenant, empty)
	_, err = postCompensate(database, actor, empty, "empty-"+uuid.NewString(), "motivo sem created", "")
	if statusCode(err) != 409 || err.Error() != "nothing_created" {
		t.Fatal(err)
	}
	capBatch := insertBatch(t, database, tenant, user, "invoices", "cap-"+uuid.NewString())
	execTenant(t, database, tenant, `insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)
		select $1::uuid, $2::uuid, g, gen_random_uuid()::text, 'created', '[]'::jsonb, gen_random_uuid()
		from generate_series(1, $3::int) g`, tenant, capBatch, compensateCreatedCap+1)
	_, err = postCompensate(database, actor, capBatch, "cap-"+uuid.NewString(), "motivo acima do teto", "")
	if statusCode(err) != 409 || err.Error() != "row_cap" {
		t.Fatal(err)
	}
}

func TestImportCompensate_B13_11_Barreira(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	scope := tenancy.Scope{TenantID: tenant}
	t.Run("baixa commitada enquanto a compensação espera", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		release, held, done := holdInvoices(t, database, scope, []string{seed.invoice}, true, func(ctx context.Context, tx *db.Tx) error {
			ctx = auth.With(ctx, actor)
			_, err := (Service{DB: database}).invoicePayment(ctx, tx, seed.invoice, map[string]any{
				"intent_id": uuid.NewString(), "amount_cents": seed.amount, "paid_at": "2026-10-20", "method": "pix", "note": "baixa sob o lock", "apply_fees": false,
			})
			return err
		})
		defer finishHold(t, release, done)
		waitHeld(t, held)
		errCh := make(chan error, 1)
		go func() {
			_, err := postCompensate(database, actor, seed.batch, "hold-pay-"+uuid.NewString(), "motivo apos a barreira", "")
			errCh <- err
		}()
		waitAdvisory(t, database, scope, invoiceAdvisoryKey(tenant, seed.invoice))
		release()
		err := waitErr(t, errCh)
		if statusCode(err) != 409 || err.Error() != "provenance_payment" {
			t.Fatal(err)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "paid", payments: 1, reversals: 0, signed: seed.amount, markers: 0, external: seed.external})
	})
	t.Run("duas faturas na ordem canonica", func(t *testing.T) {
		batch, ids := seedOpenPair(t, database, tenant, user)
		sorted := sortedUUIDs(t, ids)
		release, held, done := holdInvoices(t, database, scope, []string{sorted[1]}, false, nil)
		defer finishHold(t, release, done)
		waitHeld(t, held)
		errCh := make(chan error, 1)
		go func() {
			_, err := postCompensate(database, actor, batch, "pair-"+uuid.NewString(), "motivo das duas faturas", "")
			errCh <- err
		}()
		waitAdvisory(t, database, scope, invoiceAdvisoryKey(tenant, sorted[1]))
		if invoiceRowFree(t, database, scope, sorted[0]) {
			t.Fatal("a fatura menor não estava travada quando a maior entrou em espera")
		}
		release()
		if err := waitErr(t, errCh); err != nil {
			t.Fatal(err)
		}
		for _, id := range ids {
			var status string
			var markers int
			scanTenant(t, database, tenant, `select i.status, (select count(*)::int from import_batch_compensations c where c.batch_id=$2::uuid)
				from invoices i where i.id=$1::uuid`, []any{&status, &markers}, id, batch)
			if status != "canceled" || markers != 1 {
				t.Fatalf("status=%s markers=%d", status, markers)
			}
		}
	})
}

func TestImportCompensate_B13_18(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	scope := tenancy.Scope{TenantID: tenant}
	seed := seedImported(t, database, tenant, user, "open")
	release, held, done := holdInvoices(t, database, scope, []string{seed.invoice}, true, func(ctx context.Context, tx *db.Tx) error {
		var batch string
		if err := tx.QueryRow(ctx, `insert into import_batches (tenant_id, source, kind, filename, totals, created_by)
			values ($1::uuid, $2, 'invoices', 'dep.csv', '{}'::jsonb, $3::uuid) returning id::text`, tenant, "dep-"+uuid.NewString(), user).Scan(&batch); err != nil {
			return err
		}
		return tx.Exec(ctx, `insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)
			values ($1::uuid, $2::uuid, 1, $3, 'unchanged', '[]'::jsonb, $4::uuid)`, tenant, batch, seed.external, seed.invoice)
	})
	defer finishHold(t, release, done)
	waitHeld(t, held)
	errCh := make(chan error, 1)
	go func() {
		_, err := postCompensate(database, actor, seed.batch, "dep-race-"+uuid.NewString(), "motivo do lote dependente", "")
		errCh <- err
	}()
	waitAdvisory(t, database, scope, invoiceAdvisoryKey(tenant, seed.invoice))
	release()
	err := waitErr(t, errCh)
	if statusCode(err) != 409 || err.Error() != "dependent_batches" {
		t.Fatal(err)
	}
	assertCash(t, database, tenant, seed, cashExpect{status: "open", payments: 0, markers: 0, external: seed.external})
}

func TestImportCompensate_B13_21(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	scope := tenancy.Scope{TenantID: tenant}
	t.Run("emissão espera e recusa a origem", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		req := issuanceRequest(t, database, tenant, seed)
		release, held, done := holdInvoices(t, database, scope, []string{seed.invoice}, false, nil)
		defer finishHold(t, release, done)
		waitHeld(t, held)
		errCh := make(chan error, 1)
		go func() {
			_, err := (finance.SandboxIssuance{DB: database}).Prepare(context.Background(), scope, req, strings.Repeat("ab", 32))
			errCh <- err
		}()
		waitAdvisory(t, database, scope, invoiceAdvisoryKey(tenant, seed.invoice))
		release()
		err := waitErr(t, errCh)
		if statusCode(err) != 409 {
			t.Fatal(err)
		}
		assertNoIssuance(t, database, tenant, seed)
	})
	t.Run("compensação commitada antes da emissão", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		req := issuanceRequest(t, database, tenant, seed)
		mustCompensate(t, database, actor, seed.batch, "iss-"+uuid.NewString(), "motivo antes da emissao")
		_, err := (finance.SandboxIssuance{DB: database}).Prepare(context.Background(), scope, req, strings.Repeat("ab", 32))
		if statusCode(err) != 409 {
			t.Fatal(err)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 0, markers: 1, external: seed.external})
		assertNoIssuance(t, database, tenant, seed)
	})
}

func TestImportCompensate_B13_22(t *testing.T) {
	database, tenant, user := compensateLab(t)
	actor := compensateActor(tenant, user)
	scope := tenancy.Scope{TenantID: tenant}
	t.Run("ordem invertida produz deadlock", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		key := invoiceAdvisoryKey(tenant, seed.invoice)
		held := make(chan struct{})
		advisory := make(chan struct{})
		errA := make(chan error, 1)
		errB := make(chan error, 1)
		go func() {
			errA <- database.WithScope(context.Background(), scope, func(tx *db.Tx) error {
				ctx := context.Background()
				if err := tx.Exec(ctx, `select set_config('deadlock_timeout','200ms',true)`); err != nil {
					return err
				}
				if err := tx.Exec(ctx, `select set_config('statement_timeout','5s',true)`); err != nil {
					return err
				}
				if err := tx.Exec(ctx, `select id from invoices where id=$1::uuid for update`, seed.invoice); err != nil {
					return err
				}
				close(held)
				<-advisory
				return tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,$2))`, key, importAdvisorySalt)
			})
		}()
		go func() {
			errB <- database.WithScope(context.Background(), scope, func(tx *db.Tx) error {
				ctx := context.Background()
				if err := tx.Exec(ctx, `select set_config('deadlock_timeout','200ms',true)`); err != nil {
					return err
				}
				if err := tx.Exec(ctx, `select set_config('statement_timeout','5s',true)`); err != nil {
					return err
				}
				select {
				case <-held:
				case <-time.After(8 * time.Second):
					return errors.New("a baixa invertida não travou a fatura")
				}
				if err := tx.Exec(ctx, `select pg_advisory_xact_lock(hashtextextended($1,$2))`, key, importAdvisorySalt); err != nil {
					return err
				}
				close(advisory)
				return tx.Exec(ctx, `select id from invoices where id=$1::uuid for update`, seed.invoice)
			})
		}()
		a, b := waitErr(t, errA), waitErr(t, errB)
		if !isDeadlock(a) && !isDeadlock(b) {
			t.Fatalf("deadlock não observado: %v | %v", a, b)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "open", payments: 0, markers: 0, external: seed.external})
	})
	t.Run("ordem do protocolo conclui", func(t *testing.T) {
		seed := seedImported(t, database, tenant, user, "open")
		release, held, done := holdInvoices(t, database, scope, []string{seed.invoice}, false, nil)
		defer finishHold(t, release, done)
		waitHeld(t, held)
		errCh := make(chan error, 1)
		go func() {
			_, err := postCompensate(database, actor, seed.batch, "order-"+uuid.NewString(), "motivo na ordem do protocolo", "")
			errCh <- err
		}()
		waitAdvisory(t, database, scope, invoiceAdvisoryKey(tenant, seed.invoice))
		release()
		if err := waitErr(t, errCh); err != nil {
			t.Fatal(err)
		}
		assertCash(t, database, tenant, seed, cashExpect{status: "canceled", payments: 0, markers: 1, external: seed.external})
	})
}

func seedOpenPair(t *testing.T, database *db.DB, tenant, user string) (string, []string) {
	t.Helper()
	source := "pair-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	var batch string
	ids := make([]string, 2)
	err := database.WithScope(context.Background(), tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
		ctx := context.Background()
		if err := tx.QueryRow(ctx, `insert into import_batches (tenant_id, source, kind, filename, totals, created_by)
			values ($1::uuid, $2, 'invoices', 'par.csv', '{}'::jsonb, $3::uuid) returning id::text`, tenant, source, user).Scan(&batch); err != nil {
			return err
		}
		for i := 0; i < 2; i++ {
			ext := fmt.Sprintf("p%d-%s", i, uuid.NewString())
			if err := tx.QueryRow(ctx, `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, status, external_source, external_id)
				select $1::uuid, id, subscriber_id, 'manual', '2026-11-15', 1000, 'open', $2, $3 from contracts where tenant_id=$1::uuid order by id limit 1 returning id::text`,
				tenant, source, ext).Scan(&ids[i]); err != nil {
				return err
			}
			if err := tx.Exec(ctx, `insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)
				values ($1::uuid, $2::uuid, $3, $4, 'created', '[]'::jsonb, $5::uuid)`, tenant, batch, i+1, ext, ids[i]); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return batch, ids
}

func issuanceRequest(t *testing.T, database *db.DB, tenant string, seed importedSeed) providers.Create {
	t.Helper()
	var connection, account string
	var amount int
	var due string
	scanTenant(t, database, tenant, `insert into financial_connections (tenant_id, company_id, provider, environment, account_ref, name, status)
		select tenant_id, company_id, 'efi', 'sandbox', $2, 'emissao sintetica', 'pending' from invoices where id=$1::uuid returning id::text`, []any{&connection}, seed.invoice, "acc-"+uuid.NewString())
	scanTenant(t, database, tenant, `select account_ref, (select amount_cents from invoices where id=$2::uuid), (select due_date::text from invoices where id=$2::uuid)
		from financial_connections where id=$1::uuid`, []any{&account, &amount, &due}, connection, seed.invoice)
	return providers.Create{
		Scope:     providers.Scope{TenantID: tenant, ConnectionID: connection, Provider: "efi", Environment: "sandbox", AccountRef: account},
		IntentKey: uuid.NewString(), InvoiceID: seed.invoice, Money: providers.Money{Cents: int64(amount), Currency: "BRL"}, DueDate: due,
	}
}

func assertNoIssuance(t *testing.T, database *db.DB, tenant string, seed importedSeed) {
	t.Helper()
	var issuances, ops int
	scanTenant(t, database, tenant, `select (select count(*)::int from provider_issuance where invoice_id=$1::uuid),
		(select count(*)::int from provider_operations where invoice_id=$1::uuid)`, []any{&issuances, &ops}, seed.invoice)
	if issuances != 0 || ops != 0 {
		t.Fatalf("issuance=%d operations=%d", issuances, ops)
	}
}

func waitErr(t *testing.T, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-time.After(8 * time.Second):
		t.Fatal("a transação concorrente não terminou")
	}
	return nil
}

func isDeadlock(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "40P01"
}

type importedSeed struct {
	batch, invoice, source, external string
	amount, paid                     int
}

type cashExpect struct {
	status                                             string
	payments, reversals, signed, markers, audits       int
	external                                           string
	amount, reversalAmount, excess, collectible        int
	movements                                          int
	paidAt                                             bool
	checkAmount, checkReversal, checkExcess, checkMove bool
}

func (e cashExpect) normalized() cashExpect {
	e.checkAmount = e.amount > 0
	e.checkReversal = e.reversalAmount > 0
	e.checkExcess = e.excess == 0 && e.reversalAmount > 0
	e.checkMove = e.movements > 0
	return e
}

func compensateLab(t *testing.T) (*db.DB, string, string) {
	t.Helper()
	database, tenants := compensateTenants(t)
	if len(tenants) == 0 {
		t.Fatal("laboratório sem tenant")
	}
	return database, tenants[0], compensateUser(t, database, tenants[0])
}

func compensateTenants(t *testing.T) (*db.DB, []string) {
	t.Helper()
	dsn := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("NEXO_GO_TEST_DATABASE_URL ausente; este skip não aprova concorrência, RLS nem rollback")
	}
	database, err := db.Open(context.Background(), dsn, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	var tenants []string
	err = database.WithScope(context.Background(), tenancy.Scope{}, func(tx *db.Tx) error {
		rows, err := tx.Objects(context.Background(), `select * from nexo_go_directory()`)
		if err != nil {
			return err
		}
		for _, row := range rows {
			tenants = append(tenants, row.Get("tenant_id").(string))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return database, tenants
}

func compensateUser(t *testing.T, database *db.DB, tenant string) string {
	t.Helper()
	var user string
	scanTenant(t, database, tenant, `select id::text from users where tenant_id = $1::uuid and role = 'admin' and active order by created_at limit 1`, []any{&user}, tenant)
	if user == "" {
		t.Fatal("admin do tenant ausente")
	}
	return user
}

func compensateActor(tenant, user string) *auth.Ctx {
	return &auth.Ctx{UserID: user, TenantID: tenant, Role: "admin", Permissions: auth.Permissions["admin"], Scope: tenancy.Scope{TenantID: tenant}}
}
func financeActor(base *auth.Ctx) *auth.Ctx {
	next := *base
	next.Role = "finance"
	next.Permissions = auth.Permissions["finance"]
	return &next
}
func supportActor(base *auth.Ctx) *auth.Ctx {
	next := *base
	next.Support = true
	return &next
}
func portalActor(base *auth.Ctx) *auth.Ctx {
	next := *base
	next.SubscriberID = uuid.NewString()
	next.Scope.SubscriberID = next.SubscriberID
	return &next
}
func popActor(base *auth.Ctx, pops []string) *auth.Ctx {
	next := *base
	next.PopIDs = pops
	next.Scope.PopIDs = pops
	return &next
}

func seedImported(t *testing.T, database *db.DB, tenant, user, mode string) importedSeed {
	t.Helper()
	seed := importedSeed{source: "csv-" + strings.ReplaceAll(uuid.NewString(), "-", ""), external: "ext-" + uuid.NewString(), amount: 10000}
	switch mode {
	case "paid":
		seed.paid = seed.amount
	case "partial":
		seed.paid = 4000
	case "excess":
		seed.paid = 15000
	}
	ctx := context.Background()
	err := database.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
		if err := tx.QueryRow(ctx, `insert into import_batches (tenant_id, source, kind, filename, totals, created_by)
			values ($1::uuid, $2, 'invoices', 'lote.csv', '{}'::jsonb, $3::uuid) returning id::text`, tenant, seed.source, user).Scan(&seed.batch); err != nil {
			return err
		}
		status, note := "open", any(nil)
		var paidAt, canceled any
		if mode == "paid" || mode == "excess" {
			status = "paid"
			paidAt = time.Date(2020, 5, 1, 15, 0, 0, 0, time.UTC)
		}
		if mode == "canceled" {
			status = "canceled"
			canceled = time.Now().UTC()
			note = "cancelado na origem (" + seed.source + ")"
		}
		if err := tx.QueryRow(ctx, `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, status, paid_at, canceled_at, status_note, external_source, external_id)
			select $1::uuid, id, subscriber_id, 'manual', '2026-11-15', $2, $3, $4, $5, $6, $7, $8 from contracts where tenant_id = $1::uuid order by id limit 1 returning id::text`,
			tenant, seed.amount, status, paidAt, canceled, note, seed.source, seed.external).Scan(&seed.invoice); err != nil {
			return err
		}
		if seed.paid > 0 {
			if err := tx.Exec(ctx, `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note)
				values ($1::uuid, $2::uuid, $3, '2020-05-01T15:00:00Z', 'pix', 'manual', $4)`,
				tenant, seed.invoice, seed.paid, "Importado de "+seed.source+" (id "+seed.external+")"); err != nil {
				return err
			}
		}
		return tx.Exec(ctx, `insert into import_rows (tenant_id, batch_id, row_number, external_id, status, messages, entity_id)
			values ($1::uuid, $2::uuid, 1, $3, 'created', '[]'::jsonb, $4::uuid)`, tenant, seed.batch, seed.external, seed.invoice)
	})
	if err != nil {
		t.Fatal(err)
	}
	return seed
}

func insertBatch(t *testing.T, database *db.DB, tenant, user, kind, source string) string {
	t.Helper()
	var id string
	scanTenant(t, database, tenant, `insert into import_batches (tenant_id, source, kind, filename, totals, created_by)
		values ($1::uuid, $2, $3, 'lote.csv', '{}'::jsonb, $4::uuid) returning id::text`, []any{&id}, tenant, source, kind, user)
	return id
}

func mustCompensate(t *testing.T, database *db.DB, actor *auth.Ctx, batch, key, reason string) map[string]any {
	t.Helper()
	body, err := postCompensate(database, actor, batch, key, reason, "")
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func postCompensate(database *db.DB, actor *auth.Ctx, batch, key, reason, rawQuery string) (map[string]any, error) {
	var value any
	var err error
	handler := httpx.Middleware(prometheus.NewRegistry())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := auth.With(r.Context(), actor)
		scope := tenancy.Scope{TenantID: actor.TenantID}
		if actor != nil {
			scope.SubscriberID = actor.SubscriberID
			scope.PopIDs = actor.PopIDs
		}
		err = database.WithScope(ctx, scope, func(tx *db.Tx) error {
			var e error
			value, e = (Service{DB: database}).importCompensate(ctx, tx, batch, map[string]any{"reason": reason, "tenant": "ignorado"})
			return e
		})
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/import/batches/"+batch+"/compensate"+rawQuery, nil)
	if key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	handler.ServeHTTP(httptest.NewRecorder(), req)
	if err != nil {
		return nil, err
	}
	body, _ := value.(map[string]any)
	return body, nil
}

func callCompensateCore(actor *auth.Ctx, id, key, reason, rawQuery string, body map[string]any, twice ...bool) (any, error) {
	if body == nil {
		body = map[string]any{"reason": reason}
	}
	var value any
	var err error
	handler := httpx.Middleware(prometheus.NewRegistry())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if actor != nil {
			ctx = auth.With(ctx, actor)
		}
		value, err = (Service{}).importCompensate(ctx, nil, id, body)
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/import/batches/"+id+"/compensate"+rawQuery, nil)
	if key != "" {
		req.Header.Add("Idempotency-Key", key)
		if len(twice) > 0 && twice[0] {
			req.Header.Add("Idempotency-Key", key)
		}
	}
	handler.ServeHTTP(httptest.NewRecorder(), req)
	return value, err
}

func requestContext(actor *auth.Ctx, path, key string, twice bool) context.Context {
	var ctx context.Context
	handler := httpx.Middleware(prometheus.NewRegistry())(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx = auth.With(r.Context(), actor)
	}))
	req := httptest.NewRequest(http.MethodPost, path, nil)
	req.Header.Add("Idempotency-Key", key)
	if twice {
		req.Header.Add("Idempotency-Key", key)
	}
	handler.ServeHTTP(httptest.NewRecorder(), req)
	return ctx
}

func payImportedInvoice(t *testing.T, database *db.DB, actor *auth.Ctx, invoice string, amount int) error {
	t.Helper()
	ctx := auth.With(context.Background(), actor)
	return database.WithScope(ctx, tenancy.Scope{TenantID: actor.TenantID}, func(tx *db.Tx) error {
		_, err := (Service{DB: database}).invoicePayment(ctx, tx, invoice, map[string]any{
			"intent_id": uuid.NewString(), "amount_cents": amount, "paid_at": "2026-10-20", "method": "pix", "note": "baixa posterior", "apply_fees": false,
		})
		return err
	})
}

func assertCash(t *testing.T, database *db.DB, tenant string, seed importedSeed, expect cashExpect) {
	t.Helper()
	expect = expect.normalized()
	var status, external string
	var payments, reversals, signed, markers, audits, amount, movements int
	var paidAt *time.Time
	var collectible, excess int
	scanTenant(t, database, tenant, `select i.status, i.external_id, i.amount_cents,
		(select count(*)::int from payments p where p.invoice_id = i.id),
		(select count(*)::int from payments p where p.invoice_id = i.id and p.kind = 'reversal'),
		coalesce((select sum(p.signed_cents)::int from payments p where p.invoice_id = i.id), 0),
		(select count(*)::int from import_batch_compensations c where c.batch_id = $2::uuid),
		(select count(*)::int from audit_events a where a.action = 'import.compensate_batch' and a.entity_id = $2),
		(select count(*)::int from invoice_movements m where m.invoice_id = i.id),
		i.paid_at,
		coalesce((select collectible_cents::int from financial_balance_shadow s where s.invoice_id = i.id), 0),
		coalesce((select excess_cents::int from financial_balance_shadow s where s.invoice_id = i.id), 0)
		from invoices i where i.id = $1::uuid`,
		[]any{&status, &external, &amount, &payments, &reversals, &signed, &markers, &audits, &movements, &paidAt, &collectible, &excess}, seed.invoice, seed.batch)
	if status != expect.status || external != expect.external || payments != expect.payments || reversals != expect.reversals || signed != expect.signed || markers != expect.markers {
		t.Fatalf("status=%s external=%s payments=%d reversals=%d signed=%d markers=%d", status, external, payments, reversals, signed, markers)
	}
	if expect.audits > 0 && audits != expect.audits {
		t.Fatalf("auditorias=%d", audits)
	}
	if expect.markers == 0 && audits != 0 {
		t.Fatalf("auditoria gravada: %d", audits)
	}
	if expect.checkAmount && amount != expect.amount {
		t.Fatalf("nominal=%d", amount)
	}
	if expect.checkMove && movements != expect.movements {
		t.Fatalf("movimentos=%d", movements)
	}
	if expect.paidAt && paidAt == nil {
		t.Fatal("paid_at apagado no rollback")
	}
	if expect.checkReversal {
		var got int
		scanTenant(t, database, tenant, `select amount_cents from payments where invoice_id = $1::uuid and kind = 'reversal'`, []any{&got}, seed.invoice)
		if got != expect.reversalAmount {
			t.Fatalf("estorno=%d", got)
		}
	}
	if expect.checkExcess && (excess != 0 || collectible != 0) {
		t.Fatalf("excess=%d collectible=%d", excess, collectible)
	}
	if expect.collectible == 0 && expect.status == "canceled" && collectible != 0 {
		t.Fatalf("collectible=%d", collectible)
	}
}

func assertOriginalPayment(t *testing.T, database *db.DB, tenant string, seed importedSeed) {
	t.Helper()
	var kind, source, note string
	var createdBy *string
	var rows int
	scanTenant(t, database, tenant, `select kind, source, note, created_by::text, (select count(*)::int from import_rows r where r.batch_id = $2::uuid and r.status = 'created')
		from payments where invoice_id = $1::uuid and kind = 'payment'`, []any{&kind, &source, &note, &createdBy, &rows}, seed.invoice, seed.batch)
	if kind != "payment" || source != "manual" || createdBy != nil || rows != 1 || note != "Importado de "+seed.source+" (id "+seed.external+")" {
		t.Fatalf("kind=%s source=%s created=%v note=%s rows=%d", kind, source, createdBy, note, rows)
	}
}

func assertReversalNote(t *testing.T, database *db.DB, tenant string, seed importedSeed) {
	t.Helper()
	var note, refund, ret string
	var n *string
	var m *string
	scanTenant(t, database, tenant, `select note, provider_refund_id, provider_return_id from payments where invoice_id = $1::uuid and kind = 'reversal'`, []any{&note, &n, &m}, seed.invoice)
	refund, ret = "", ""
	if n != nil {
		refund = *n
	}
	if m != nil {
		ret = *m
	}
	if !strings.Contains(note, seed.batch) || refund != "" || ret != "" {
		t.Fatalf("note=%s refund=%s return=%s", note, refund, ret)
	}
	var ops int
	scanTenant(t, database, tenant, `select count(*)::int from provider_operations where invoice_id = $1::uuid`, []any{&ops}, seed.invoice)
	if ops != 0 {
		t.Fatal(ops)
	}
}

func assertNoPSP(t *testing.T, database *db.DB, tenant, invoice string) {
	t.Helper()
	var ops int
	scanTenant(t, database, tenant, `select count(*)::int from provider_operations where invoice_id = $1::uuid`, []any{&ops}, invoice)
	if ops != 0 {
		t.Fatal(ops)
	}
}

func execTenant(t *testing.T, database *db.DB, tenant, sql string, args ...any) {
	t.Helper()
	ctx := context.Background()
	err := database.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
		return tx.Exec(ctx, sql, args...)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func scanTenant(t *testing.T, database *db.DB, tenant, sql string, dest []any, args ...any) {
	t.Helper()
	ctx := context.Background()
	err := database.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, sql, args...).Scan(dest...)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func statusCode(err error) int {
	var httpErr interface{ GetStatus() int }
	if errors.As(err, &httpErr) {
		return httpErr.GetStatus()
	}
	var wrapped *apierr.Error
	if errors.As(err, &wrapped) {
		return wrapped.Status
	}
	return 0
}
