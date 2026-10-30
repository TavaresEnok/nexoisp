package escrita

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"net/http"
	"net/http/httptest"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/httpx"
	"nexoisp/api-go/internal/modules/leitura/gen"
	"nexoisp/api-go/internal/tenancy"
	"os"
	"sync"
	"testing"
	"time"
)

func TestWorkOrderAttachmentContent(t *testing.T) {
	cases := []struct {
		input, mime string
		valid       bool
	}{
		{base64.StdEncoding.EncodeToString([]byte("%PDF-test")), "application/pdf", true},
		{base64.StdEncoding.EncodeToString([]byte{0xff, 0xd8, 0xff, 1}), "image/jpeg", true},
		{"JVBERi0=\n", "", false}, {"JVBERi1", "", false}, {base64.StdEncoding.EncodeToString([]byte("text")), "", false},
	}
	for _, tc := range cases {
		data, mime, err := attachmentContent(tc.input)
		if (err == nil) != tc.valid || mime != tc.mime {
			t.Fatalf("input %q: mime=%q err=%v", tc.input, mime, err)
		}
		if tc.valid && base64.StdEncoding.EncodeToString(data) != tc.input {
			t.Fatal("bytes changed")
		}
	}
}

func TestWorkOrderAttachmentPG(t *testing.T) {
	url := os.Getenv("NEXO_GO_TEST_DATABASE_URL")
	if url == "" {
		if os.Getenv("NEXO_WORK_ATTACHMENTS_PG_REQUIRED") == "1" {
			t.Fatal("NEXO_GO_TEST_DATABASE_URL ausente com NEXO_WORK_ATTACHMENTS_PG_REQUIRED=1")
		}
		t.Skip("PostgreSQL ausente: contrato de anexos não comprovado")
	}
	ctx := context.Background()
	d, err := db.Open(ctx, url, "force_custom_plan", 8, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	var database, session, current string
	var tenants []string
	err = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `select current_database(), session_user::text, current_user::text`).Scan(&database, &session, &current); e != nil {
			return e
		}
		rows, e := tx.Objects(ctx, `select tenant_id::text from nexo_go_directory() order by tenant_id`)
		if e != nil {
			return e
		}
		for _, r := range rows {
			tenants = append(tenants, r.Get("tenant_id").(string))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if database != "nexo_test" || session != "nexo_go" || current != "nexo_go" || len(tenants) < 2 {
		t.Fatal("requer nexo_test/nexo_go descartável com dois tenants")
	}
	var users, subscribers, orders [2]string
	for i, tenant := range tenants[:2] {
		err = d.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
			if e := tx.QueryRow(ctx, `insert into users (tenant_id,email,name,password_hash,role) values ($1,$2,'teste','!','admin') returning id::text`, tenant, uuid.NewString()+"@example.invalid").Scan(&users[i]); e != nil {
				return e
			}
			if e := tx.QueryRow(ctx, `insert into subscribers (tenant_id,name) values ($1,'teste anexo') returning id::text`, tenant).Scan(&subscribers[i]); e != nil {
				return e
			}
			return tx.QueryRow(ctx, `insert into work_orders (tenant_id,number,kind,subscriber_id,description) values ($1,(select coalesce(max(number),0)+1 from work_orders),'other',$2,'teste anexo') returning id::text`, tenant, subscribers[i]).Scan(&orders[i])
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	// Sem contrato o assinante permanece visível; este outro possui contrato
	// exclusivamente em POP diferente daquele atribuído ao ator restrito.
	var restrictedOrder string
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var pop, plan, version, subscriber string
		if e := tx.QueryRow(ctx, `insert into pops (tenant_id,name) values ($1,$2) returning id::text`, tenants[0], "anexo-"+uuid.NewString()).Scan(&pop); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `insert into plans (tenant_id,name) values ($1,$2) returning id::text`, tenants[0], "anexo-"+uuid.NewString()).Scan(&plan); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `insert into plan_versions (tenant_id,plan_id,version,price_cents,down_kbps,up_kbps,profile_name) values ($1,$2,1,0,1,1,'teste') returning id::text`, tenants[0], plan).Scan(&version); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `insert into subscribers (tenant_id,name) values ($1,'teste POP anexo') returning id::text`, tenants[0]).Scan(&subscriber); e != nil {
			return e
		}
		if e := tx.Exec(ctx, `insert into contracts (tenant_id,subscriber_id,plan_version_id,due_day,pop_id) values ($1,$2,$3,10,$4)`, tenants[0], subscriber, version, pop); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `insert into work_orders (tenant_id,number,kind,subscriber_id,description) values ($1,(select coalesce(max(number),0)+1 from work_orders),'other',$2,'teste POP') returning id::text`, tenants[0], subscriber).Scan(&restrictedOrder)
	})
	if err != nil {
		t.Fatal(err)
	}
	actors := map[string]*auth.Ctx{}
	for i, tenant := range tenants[:2] {
		token := fmt.Sprintf("attachment-%d", i)
		actors[ftthHash(token)] = &auth.Ctx{UserID: users[i], TenantID: tenant, Role: "admin", Permissions: auth.Permissions["admin"], Modules: []string{"field"}, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant}}
	}
	actors[ftthHash("no-module")] = &auth.Ctx{UserID: users[0], TenantID: tenants[0], Role: "admin", Permissions: auth.Permissions["admin"], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenants[0]}}
	actors[ftthHash("read-only")] = &auth.Ctx{UserID: users[0], TenantID: tenants[0], Role: "attendant", Permissions: []string{"os:read"}, Modules: []string{"field"}, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenants[0]}}
	actors[ftthHash("portal")] = &auth.Ctx{UserID: users[0], TenantID: tenants[0], Role: "subscriber", Permissions: []string{"os:read", "os:write"}, Modules: []string{"field"}, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenants[0], SubscriberID: subscribers[0]}}
	actors[ftthHash("pop")] = &auth.Ctx{UserID: users[0], TenantID: tenants[0], Role: "admin", Permissions: auth.Permissions["admin"], Modules: []string{"field"}, ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenants[0], PopIDs: []string{uuid.NewString()}}}
	a, err := auth.New(ftthLoader{actors}, 0, false, 1000, prometheus.NewRegistry())
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	old := huma.NewError
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if len(errs) > 0 {
			return apierr.Map(errs[0])
		}
		return apierr.New(status, msg)
	}
	defer func() { huma.NewError = old }()
	router := chi.NewRouter()
	router.Use(httpx.Middleware(prometheus.NewRegistry()))
	registry := endpoint.New(a)
	router.Use(registry.Middleware)
	config := huma.DefaultConfig("anexos", "1")
	config.CreateHooks = nil
	config.OpenAPIPath = ""
	config.DocsPath = ""
	config.SchemasPath = ""
	registerWorkOrderAttachments(humachi.New(router, config), registry, Service{DB: d})
	call := func(token, method, path string, body any, csrf bool) *httptest.ResponseRecorder {
		t.Helper()
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.AddCookie(&http.Cookie{Name: "nexo_session", Value: token})
			if csrf {
				req.Header.Set("X-Nexo-CSRF", auth.SessionCSRF(token))
			}
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	path := "/api/work-orders/" + orders[0] + "/attachments"
	content := []byte("%PDF-anexo teste")
	body := map[string]any{"name": "foto.pdf", "content_base64": base64.StdEncoding.EncodeToString(content)}
	check := func(w *httptest.ResponseRecorder, code int) {
		t.Helper()
		if w.Code != code {
			t.Fatalf("HTTP %d esperado %d: %s", w.Code, code, w.Body.String())
		}
	}
	check(call("", "GET", path, nil, false), 401)
	check(call("attachment-0", "POST", path, body, false), 403)
	check(call("no-module", "GET", path, nil, true), 403)
	check(call("read-only", "POST", path, body, true), 403)
	check(call("portal", "GET", path, nil, true), 404)
	check(call("pop", "GET", path, nil, true), 200)
	check(call("pop", "GET", "/api/work-orders/"+restrictedOrder+"/attachments", nil, true), 404)
	check(call("attachment-1", "GET", path, nil, true), 404)
	w := call("attachment-0", "POST", path, body, true)
	check(w, 200)
	var item map[string]any
	if err = json.Unmarshal(w.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	id, ok := item["id"].(string)
	if !ok {
		t.Fatalf("resposta: %s", w.Body.String())
	}
	sum := sha256.Sum256(content)
	if item["sha256"] != hex.EncodeToString(sum[:]) || item["kind"] != "other" {
		t.Fatalf("metadados: %v", item)
	}
	w = call("attachment-0", "GET", path, nil, true)
	check(w, 200)
	if bytes.Contains(w.Body.Bytes(), []byte(body["content_base64"].(string))) {
		t.Fatal("conteúdo na lista")
	}
	w = call("attachment-0", "GET", path+"/"+id+"/download", nil, true)
	check(w, 200)
	if !bytes.Equal(w.Body.Bytes(), content) || w.Header().Get("Cache-Control") != "private, no-store" || w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
		t.Fatalf("download: headers=%v body=%q", w.Header(), w.Body.Bytes())
	}
	check(call("attachment-1", "GET", "/api/work-orders/"+orders[1]+"/attachments/"+id+"/download", nil, true), 404)
	check(call("attachment-0", "DELETE", path+"/"+id, nil, true), 200)
	check(call("attachment-0", "GET", path+"/"+id+"/download", nil, true), 404)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		var deleted, empty bool
		if e := tx.QueryRow(ctx, `select deleted_at is not null, content is null from documents where id=$1`, id).Scan(&deleted, &empty); e != nil {
			return e
		}
		if !deleted || !empty {
			return fmt.Errorf("soft delete não apagou bytes")
		}
		var leaks int
		if e := tx.QueryRow(ctx, `select count(*) from audit_events where entity_id=$1 and detail::text like $2`, id, "%"+body["content_base64"].(string)+"%").Scan(&leaks); e != nil {
			return e
		}
		if leaks != 0 {
			return fmt.Errorf("conteúdo na auditoria")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Os endpoints genéricos preservam documentos legados, mas não veem anexos de OS.
	w = call("attachment-0", "POST", path, body, true)
	check(w, 200)
	if err = json.Unmarshal(w.Body.Bytes(), &item); err != nil {
		t.Fatal(err)
	}
	attachmentID := item["id"].(string)
	actorCtx := auth.With(ctx, actors[ftthHash("attachment-0")])
	var legacyID string
	err = d.WithScope(actorCtx, actors[ftthHash("attachment-0")].Scope, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `insert into documents (tenant_id,subscriber_id,kind,name,mime,size_bytes,sha256,content,created_by) values ($1,$2,'other','legado.pdf','application/pdf',1,$3,$4,$5) returning id::text`, tenants[0], subscribers[0], fmt.Sprintf("%064d", 0), []byte("x"), users[0]).Scan(&legacyID); e != nil {
			return e
		}
		rows, e := tx.Objects(ctx, gen.Read7b655443, subscribers[0])
		if e != nil {
			return e
		}
		if len(rows) != 1 || fmt.Sprint(rows[0].Get("id")) != legacyID {
			return fmt.Errorf("listagem genérica: %v", rows)
		}
		if _, e = (Service{}).documentDownload(actorCtx, tx, attachmentID, nil); e == nil {
			return fmt.Errorf("download genérico expôs anexo")
		}
		if _, e = (Service{}).deleteDocument(actorCtx, tx, attachmentID, nil); e == nil {
			return fmt.Errorf("delete genérico expôs anexo")
		}
		if _, e = (Service{}).documentDownload(actorCtx, tx, legacyID, nil); e != nil {
			return e
		}
		_, e = (Service{}).deleteDocument(actorCtx, tx, legacyID, nil)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	check(call("attachment-0", "DELETE", path+"/"+attachmentID, nil, true), 200)
	// Concorrência: só vinte anexos vivos podem ser criados na mesma OS.
	var wg sync.WaitGroup
	codes := make(chan int, 22)
	for i := 0; i < 22; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); codes <- call("attachment-0", "POST", path, body, true).Code }()
	}
	wg.Wait()
	close(codes)
	success, conflict := 0, 0
	for code := range codes {
		if code == 200 {
			success++
		} else if code == 409 {
			conflict++
		} else {
			t.Fatalf("HTTP concorrente %d", code)
		}
	}
	if success != 20 || conflict != 2 {
		t.Fatalf("concorrência: %d sucesso, %d conflito", success, conflict)
	}
	// A cota de assinante inclui documentos legados e anexos de outras OS.
	var otherOrder string
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		if e := tx.QueryRow(ctx, `insert into work_orders (tenant_id,number,kind,subscriber_id,description) values ($1,(select coalesce(max(number),0)+1 from work_orders),'other',$2,'cota') returning id::text`, tenants[0], subscribers[0]).Scan(&otherOrder); e != nil {
			return e
		}
		return tx.Exec(ctx, `insert into documents (tenant_id,subscriber_id,kind,name,mime,size_bytes,sha256,content,created_by) select $1,$2,'other','legado','application/pdf',1,$3,$4,$5 from generate_series(1,30)`, tenants[0], subscribers[0], fmt.Sprintf("%064d", 0), []byte("x"), users[0])
	})
	if err != nil {
		t.Fatal(err)
	}
	check(call("attachment-0", "POST", "/api/work-orders/"+otherOrder+"/attachments", body, true), 409)
	// Reproduz a ordem real de conclusão: OS bloqueada, upload aguardando a OS
	// com o lock do assinante, e workStatus inserindo a pesquisa com FK ao assinante.
	doneCtx, cancelDone := context.WithTimeout(auth.With(ctx, actors[ftthHash("attachment-1")]), 10*time.Second)
	defer cancelDone()
	err = d.WithScope(doneCtx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
		return tx.Exec(doneCtx, `update work_orders set status='in_progress' where id=$1`, orders[1])
	})
	if err != nil {
		t.Fatal(err)
	}
	locked := make(chan struct{})
	proceed := make(chan struct{})
	doneResult := make(chan error, 1)
	go func() {
		doneResult <- d.WithScope(doneCtx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
			if e := tx.Exec(doneCtx, `select id from work_orders where id=$1 for update`, orders[1]); e != nil {
				return e
			}
			close(locked)
			select {
			case <-proceed:
			case <-doneCtx.Done():
				return doneCtx.Err()
			}
			_, e := (Service{DB: d}).workStatus(doneCtx, tx, orders[1], map[string]any{"status": "done", "resolution": "concluída"})
			return e
		})
	}()
	<-locked
	uploadResult := make(chan int, 1)
	go func() {
		uploadResult <- call("attachment-1", "POST", "/api/work-orders/"+orders[1]+"/attachments", body, true).Code
	}()
	waiting := false
	for !waiting && doneCtx.Err() == nil {
		err = d.WithScope(doneCtx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
			return tx.QueryRow(doneCtx, `select exists (select 1 from pg_stat_activity where pid <> pg_backend_pid() and usename=current_user and wait_event_type='Lock' and query like 'select subscriber_id, contract_id, status from work_orders%')`).Scan(&waiting)
		})
		if err != nil {
			break
		}
		if !waiting {
			time.Sleep(10 * time.Millisecond)
		}
	}
	close(proceed)
	if err != nil || !waiting {
		t.Fatalf("upload não aguardou o lock da OS: %v", err)
	}
	if err = <-doneResult; err != nil {
		t.Fatalf("conclusão concorrente: %v", err)
	}
	if code := <-uploadResult; code != 409 {
		t.Fatalf("upload após conclusão: HTTP %d", code)
	}
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update work_orders set status='open',finished_at=null where id=$1`, orders[1])
	})
	if err != nil {
		t.Fatal(err)
	}
	// Exportação privilegiada inclui o anexo; anonimização concorrente apaga os bytes
	// mesmo se o upload ganhar a corrida pelo lock do assinante.
	path2 := "/api/work-orders/" + orders[1] + "/attachments"
	// O fechamento e o upload disputam o lock da OS: após o fechamento nenhum upload pode prosseguir.
	var closeRace sync.WaitGroup
	closeRace.Add(2)
	var closeCode int
	var closeErr error
	go func() { defer closeRace.Done(); closeCode = call("attachment-1", "POST", path2, body, true).Code }()
	go func() {
		defer closeRace.Done()
		closeErr = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
			return tx.Exec(ctx, `update work_orders set status='canceled',finished_at=now() where id=$1`, orders[1])
		})
	}()
	closeRace.Wait()
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if closeCode != 200 && closeCode != 409 {
		t.Fatalf("upload e fechamento: %d", closeCode)
	}
	check(call("attachment-1", "POST", path2, body, true), 409)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update work_orders set status='open',finished_at=null where id=$1`, orders[1])
	})
	if err != nil {
		t.Fatal(err)
	}
	check(call("attachment-1", "POST", path2, body, true), 200)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
		rows, e := tx.Objects(ctx, query("GET /api/subscribers/:id/lgpd-export", 7), subscribers[1])
		if e != nil {
			return e
		}
		if len(rows) < 1 {
			return fmt.Errorf("exportação LGPD não incluiu anexo: %v", rows)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var race sync.WaitGroup
	race.Add(2)
	var uploadCode int
	var anonymizeErr error
	go func() { defer race.Done(); uploadCode = call("attachment-1", "POST", path2, body, true).Code }()
	go func() {
		defer race.Done()
		anonymizeErr = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
			return tx.QueryRow(ctx, `select lgpd_anonymize_subscriber($1,$2,$3)`, subscribers[1], "pedido titular", users[1]).Scan(new(any))
		})
	}()
	race.Wait()
	if anonymizeErr != nil {
		t.Fatal(anonymizeErr)
	}
	if uploadCode != 200 && uploadCode != 409 {
		t.Fatalf("upload concorrente: %d", uploadCode)
	}
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[1]}, func(tx *db.Tx) error {
		var n int
		if e := tx.QueryRow(ctx, `select count(*) from documents where subscriber_id=$1 and (content is not null or deleted_at is null)`, subscribers[1]).Scan(&n); e != nil {
			return e
		}
		if n != 0 {
			return fmt.Errorf("anonimização deixou %d documentos vivos", n)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	check(call("attachment-1", "POST", path2, body, true), 409)
	err = d.WithScope(ctx, tenancy.Scope{TenantID: tenants[0]}, func(tx *db.Tx) error {
		return tx.Exec(ctx, `update work_orders set status='canceled',finished_at=now() where id=$1`, orders[0])
	})
	if err != nil {
		t.Fatal(err)
	}
	check(call("attachment-0", "POST", path, body, true), 409)
	w = call("attachment-0", "GET", path, nil, true)
	check(w, 200)
	var listing struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &listing); err != nil || len(listing.Items) == 0 {
		t.Fatalf("lista após fechamento: %s, %v", w.Body.String(), err)
	}
	check(call("attachment-0", "DELETE", path+"/"+listing.Items[0].ID, nil, true), 409)
}
