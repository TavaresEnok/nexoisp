package escrita

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
)

func TestMonitoringOverviewPG(t *testing.T) {
	d := templateTestDB(t, "NEXO_MONITORING_PG_REQUIRED")
	ctx := context.Background()
	mark := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	a := newTemplateTenant(t, d, mark, "MON-A-"+mark)
	b := newTemplateTenant(t, d, mark, "MON-B-"+mark)
	actors := map[string]*auth.Ctx{}
	add := func(token, tenant, role, user, sub string) {
		actors[ftthHash(token)] = &auth.Ctx{UserID: user, TenantID: tenant, Role: role, SubscriberID: sub, Permissions: auth.Permissions[role], ExpiresAt: time.Now().Add(time.Hour), Scope: tenancy.Scope{TenantID: tenant, SubscriberID: sub}}
	}
	add("a", a.id, "noc", a.admin, "")
	add("b", b.id, "admin", b.admin, "")
	add("finance", a.id, "finance", a.admin, "")
	add("portal", a.id, "subscriber", a.admin, a.subscriber)
	h := templateHarness{t, templateRouter(t, d, actors, registerMonitoring)}
	var job int64
	err := d.WithScope(ctx, tenancy.Scope{TenantID: a.id}, func(tx *db.Tx) error {
		var readable bool
		if e := tx.QueryRow(ctx, `select to_regclass('nexo_jobs.river_job') is not null`).Scan(&readable); e != nil || !readable {
			t.Fatal("fila de rotinas ausente no banco de teste", e)
		}
		args, _ := json.Marshal(map[string]string{"task": "SLA", "tenant_id": a.id})
		return tx.QueryRow(ctx, `insert into nexo_jobs.river_job(args,kind,max_attempts,queue,state,attempt,attempted_at,finalized_at) values($1::jsonb,'nexo_task',3,'tenant','completed',1,now(),now()) returning id`, string(args)).Scan(&job)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = d.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { return tx.Exec(ctx, `delete from nexo_jobs.river_job where id=$1`, job) })
	})
	h.call("finance", "GET", "/api/monitoring/overview", nil, 403)
	h.call("portal", "GET", "/api/monitoring/overview", nil, 403)
	h.call("a", "GET", "/api/monitoring/overview?x=1", nil, 400)
	mine := h.call("a", "GET", "/api/monitoring/overview", nil, 200)
	theirs := h.call("b", "GET", "/api/monitoring/overview", nil, 200)
	if mine["database"].(map[string]any)["ok"] != true || mine["backup"].(map[string]any)["recorded"] != false {
		t.Fatal(mine["_raw"])
	}
	if !strings.Contains(mine["_raw"].(string), "Agente "+mark) || len(theirs["agents"].([]any)) != 1 || strings.Contains(theirs["_raw"].(string), a.device) {
		t.Fatal("agentes por provedor", theirs["_raw"])
	}
	lastSuccess := func(res map[string]any) any {
		for _, task := range res["jobs"].(map[string]any)["tasks"].([]any) {
			if task.(map[string]any)["task"] == "SLA" {
				return task.(map[string]any)["last_success"]
			}
		}
		t.Fatal("rotina SLA ausente", res["_raw"])
		return nil
	}
	if lastSuccess(mine) == nil || lastSuccess(theirs) != nil {
		t.Fatal("rotinas devem ser isoladas por provedor", mine["_raw"], theirs["_raw"])
	}
	for _, forbidden := range []string{"secret_enc", "contact_value", "payload", "token_hash"} {
		if strings.Contains(mine["_raw"].(string), forbidden) {
			t.Fatal("dado sensível no acompanhamento", forbidden)
		}
	}
}
