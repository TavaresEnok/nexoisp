package escrita

import (
	"context"
	"net/http"
	"os"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/endpoint"
	"nexoisp/api-go/internal/jsonx"
)

// Acompanhamento operacional: leitura agregada para a equipe com network:read
// (administração, atendimento e NOC). Somente consultas: não executa varredura
// de expiração, não reprocessa filas e não devolve conteúdo de mensagens,
// destinatários ou payloads — apenas estados, contagens e horários.

var monitoringTasks = []string{"ACS_TASKS", "PSP_OPERATIONS", "PSP_RECEIPTS", "PSP_ISSUANCE", "PAYMENT_EFFECTS", "BILLING", "RECONCILE", "NOTICES", "SCHEDULED", "SLA", "PURGE", "TRUST", "SUSPEND", "NOTIFICATIONS", "WEBHOOKS"}

func registerMonitoring(api huma.API, registry *endpoint.Registry, s Service) {
	registry.Get(api, "/api/monitoring/overview", "network:read", false, func(ctx context.Context, r *http.Request) (endpoint.Result, error) {
		actor, err := siteActor(ctx)
		if err != nil {
			return endpoint.Result{}, err
		}
		if r.URL.RawQuery != "" {
			return endpoint.Result{}, apierr.New(400, "o acompanhamento não aceita filtros")
		}
		out := map[string]any{"checked_at": time.Now().UTC().Format(time.RFC3339Nano), "api": map[string]any{"ok": true}, "pop_restricted": len(actor.PopIDs) > 0}
		started := time.Now()
		err = s.DB.WithScope(ctx, actor.Scope, func(tx *db.Tx) error {
			var serverTime time.Time
			if e := tx.QueryRow(ctx, `select now()`).Scan(&serverTime); e != nil {
				return e
			}
			out["database"] = map[string]any{"ok": true, "latency_ms": float64(time.Since(started).Microseconds()) / 1000, "server_time": serverTime.UTC().Format(time.RFC3339Nano)}
			agents, e := tx.Objects(ctx, `select a.id,a.name,a.status,a.version,a.last_seen_at,
 (a.last_seen_at is not null and a.last_seen_at > now()-interval '30 seconds') as online,
 (select count(*)::int from operations o where o.agent_id=a.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN')) as open_operations
 from agents a order by (a.status='active') desc,a.name limit 100`)
			if e != nil {
				return e
			}
			out["agents"] = agents
			ops, e := tx.Objects(ctx, `select
 (select count(*)::int from operations where status in ('PENDING','RESERVED','EXECUTING','VERIFYING')) as in_progress,
 (select count(*)::int from operations where status='UNCERTAIN') as uncertain,
 (select count(*)::int from operations where status in ('FAILED','EXPIRED') and coalesce(finished_at,updated_at) > now()-interval '7 days') as failed_recent,
 (select extract(epoch from now()-min(created_at))::int from operations where status in ('PENDING','UNCERTAIN')) as oldest_pending_s,
 (select count(*)::int from acs_task_intents where state in ('prepared','uncertain','queued')) as acs_pending,
 (select count(*)::int from acs_task_intents where state='review') as acs_review`)
			if e != nil {
				return e
			}
			summary := ops[0]
			recent, e := tx.Objects(ctx, `select o.id,o.action,o.status,o.created_at,o.finished_at,o.attempts,d.name as device_name
 from operations o left join devices d on d.tenant_id=o.tenant_id and d.id=o.device_id
 where o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN') or (o.status in ('FAILED','EXPIRED') and coalesce(o.finished_at,o.updated_at) > now()-interval '7 days')
 order by case o.status when 'UNCERTAIN' then 0 when 'FAILED' then 1 when 'EXPIRED' then 2 else 3 end, o.created_at desc limit 15`)
			if e != nil {
				return e
			}
			out["operations"] = map[string]any{"summary": summary, "items": recent}
			queues, e := tx.Objects(ctx, `select
 (select count(*)::int from notice_log where status in ('queued','sending')) as notices_pending,
 (select count(*)::int from notice_log where status='uncertain') as notices_uncertain,
 (select count(*)::int from notice_log where status='failed' and created_at > now()-interval '7 days') as notices_failed,
 (select min(created_at) from notice_log where status in ('queued','sending','uncertain')) as notices_oldest,
 (select count(*)::int from notifications where status='pending') as team_pending,
 (select count(*)::int from notifications where status='failed' and created_at > now()-interval '7 days') as team_failed,
 (select count(*)::int from webhook_deliveries where status='pending') as webhooks_pending,
 (select count(*)::int from webhook_deliveries where status='failed' and created_at > now()-interval '7 days') as webhooks_failed,
 (select min(created_at) from webhook_deliveries where status='pending') as webhooks_oldest`)
			if e != nil {
				return e
			}
			out["queues"] = queues[0]
			jobs := map[string]any{"enabled": os.Getenv("NEXO_GO_JOBS") == "1", "available": false, "tasks": []jsonx.Object{}}
			var readable bool
			if e := tx.QueryRow(ctx, `select to_regclass('nexo_jobs.river_job') is not null and has_table_privilege('nexo_jobs.river_job','select')`).Scan(&readable); e != nil {
				return e
			}
			if readable {
				// O provedor vê somente as próprias rotinas; as globais da
				// plataforma ficam fora deste painel.
				tasks, e := tx.Objects(ctx, `with mine as (
 select args->>'task' as task,state::text as state,attempted_at,finalized_at,created_at
 from nexo_jobs.river_job where args->>'tenant_id'=app_tenant()::text and args->>'task'=any($1::text[]))
 select t.task,
  (select max(finalized_at) from mine m where m.task=t.task and m.state='completed') as last_success,
  (select max(coalesce(finalized_at,attempted_at,created_at)) from mine m where m.task=t.task) as last_activity,
  (select count(*)::int from mine m where m.task=t.task and m.state in ('available','scheduled','running','retryable','pending')) as pending,
  (select count(*)::int from mine m where m.task=t.task and m.state in ('discarded','cancelled')) as failed,
  (select count(*)::int from mine m where m.task=t.task and m.state='retryable') as retrying
 from unnest($1::text[]) as t(task) order by t.task`, monitoringTasks)
				if e != nil {
					return e
				}
				enabled := []jsonx.Object{}
				for _, task := range tasks {
					task.Set("enabled", os.Getenv("NEXO_GO_JOB_"+jsonx.String(task.Get("task"))) == "1")
					enabled = append(enabled, task)
				}
				jobs["available"] = true
				jobs["tasks"] = enabled
			}
			out["jobs"] = jobs
			return nil
		})
		if err != nil {
			return endpoint.Result{}, err
		}
		// O backup roda fora da API (./nexo prod backup); o banco não guarda
		// registro dele, então o painel informa a ausência de fonte.
		out["backup"] = map[string]any{"recorded": false, "source": nil}
		return endpoint.Result{Value: out}, nil
	})
}
