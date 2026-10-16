// Package jobs executes periodic tasks through River in a private schema.
package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/escrita"
	"nexoisp/api-go/internal/outbound"
	"nexoisp/api-go/internal/radius"
	"nexoisp/api-go/internal/tenancy"
	"os"
	"sync"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

type Args struct {
	Task string `json:"task"`
}

func (Args) Kind() string { return "nexo_periodic" }

type worker struct {
	river.WorkerDefaults[Args]
	db        *db.DB
	radius    *radius.Executor
	mu        sync.Mutex
	lastAlert string
}

func (w *worker) Work(ctx context.Context, j *river.Job[Args]) error {
	task := j.Args.Task
	if os.Getenv("NEXO_GO_JOB_"+task) != "1" {
		return nil
	}
	if task == "RADIUS" {
		return w.radius.Run(ctx, false)
	}
	if task == "RADIUS_SYNC" {
		return w.radius.Run(ctx, true)
	}
	return w.db.WithWorkerLock(ctx, 7411002, func() error {
		if task == "CLEANUP" {
			return w.db.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { return tx.Exec(ctx, "select login_throttle_purge()") })
		}
		if task == "NOTIFICATIONS" {
			_, e := outbound.Notifications(ctx, w.db, "")
			return e
		}
		if task == "WEBHOOKS" {
			_, e := outbound.Webhooks(ctx, w.db, "")
			return e
		}
		if task == "ALERTS" {
			return w.alerts(ctx)
		}
		var tenants []jsonx.Object
		e := w.db.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
			var e error
			tenants, e = tx.Objects(ctx, "select * from worker_tenants()")
			return e
		})
		if e != nil {
			return e
		}
		for _, t := range tenants {
			tenant := t.Get("tenant_id").(string)
			switch task {
			case "NOTICES":
				_, e = outbound.Notices(ctx, w.db, tenant, false)
			case "SCHEDULED":
				_, e = (escrita.Service{DB: w.db}).Scheduled(ctx, tenant)
			default:
				e = w.db.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
					switch task {
					case "BILLING":
						if t.Get("billing_auto") != true {
							return nil
						}
						comp, e := finance.Competence(ctx, tx, t.Get("timezone"))
						if e != nil {
							return e
						}
						created, e := finance.Generate(ctx, tx, tenant, comp.(string))
						if e != nil {
							return e
						}
						if _, e = finance.Charges(ctx, tx, tenant); e != nil {
							return e
						}
						if fmt.Sprint(created) != "0" {
							return finance.SysAudit(ctx, tx, tenant, "finance.generate_monthly", "invoice", nil, map[string]any{"created": created}, "ok")
						}
					case "RECONCILE":
						if t.Get("gateway") != "none" {
							_, e := finance.Reconcile(ctx, tx, tenant)
							return e
						}
					case "SUSPEND":
						if t.Get("auto_suspend") == true {
							_, e := finance.AutoSuspend(ctx, tx, tenant, nil)
							return e
						}
					case "TRUST":
						return tx.Exec(ctx, "update trust_releases set status='expired',closed_at=now() where status='active' and expires_at<=now()")
					case "SLA":
						return outbound.SLA(ctx, tx, tenant)
					case "PURGE":
						return radius.Purge(ctx, tx, tenant)
					}
					return nil
				})
			}
			if e != nil {
				slog.Error("rotina do provedor falhou", "task", task, "tenant", tenant, "error", e)
				return e
			}
		}
		return nil
	})
}
func (w *worker) alerts(ctx context.Context) error {
	scope, e := tenancy.OperatorScope("alertas_operacionais")
	if e != nil {
		return e
	}
	var alerts []jsonx.Object
	e = w.db.WithScope(ctx, scope, func(tx *db.Tx) error {
		var e error
		alerts, e = tx.Objects(ctx, "select tenant_id,agents_offline,uncertain from platform_health() where agents_offline>0 or uncertain>0 order by tenant_id")
		return e
	})
	if e != nil {
		return e
	}
	encoded, e := jsonx.Encode(alerts)
	if e != nil {
		return e
	}
	key := string(encoded)
	w.mu.Lock()
	defer w.mu.Unlock()
	if key == w.lastAlert {
		return nil
	}
	url := os.Getenv("NEXO_ALERT_WEBHOOK_URL")
	if url == "" {
		w.lastAlert = key
		return nil
	}
	text := "NexoISP: alertas de rede normalizados"
	if len(alerts) > 0 {
		text = "NexoISP: "
		for i, a := range alerts {
			if i > 0 {
				text += "; "
			}
			text += fmt.Sprintf("provedor %v: %v agente(s) offline, %v operação(ões) incerta(s)", a.Get("tenant_id"), a.Get("agents_offline"), a.Get("uncertain"))
		}
	}
	status, e := outbound.Post(ctx, url, map[string]any{"text": text, "alerts": alerts}, nil, 5*time.Second)
	if e != nil {
		return e
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("o destino respondeu %d", status)
	}
	w.lastAlert = key
	return nil
}
func Start(ctx context.Context, database *db.DB) (func(context.Context) error, error) {
	if os.Getenv("NEXO_GO_JOBS") != "1" {
		return func(context.Context) error { return nil }, nil
	}
	workers := river.NewWorkers()
	w := &worker{db: database, radius: &radius.Executor{DB: database}}
	river.AddWorker(workers, w)
	periodic := []*river.PeriodicJob{}
	for _, task := range []string{"BILLING", "RECONCILE", "NOTICES", "SCHEDULED", "SLA", "PURGE", "TRUST", "SUSPEND", "NOTIFICATIONS", "WEBHOOKS", "ALERTS", "CLEANUP", "RADIUS", "RADIUS_SYNC"} {
		if os.Getenv("NEXO_GO_JOB_"+task) != "1" {
			continue
		}
		interval := time.Minute
		switch task {
		case "RECONCILE":
			interval = 10 * time.Minute
		case "RADIUS":
			interval = 2 * time.Second
		case "RADIUS_SYNC":
			interval = 15 * time.Second
		}
		periodic = append(periodic, river.NewPeriodicJob(river.PeriodicInterval(interval), func() (river.JobArgs, *river.InsertOpts) {
			queue := river.QueueDefault
			if task == "RADIUS" || task == "RADIUS_SYNC" {
				queue = "network"
			}
			return Args{Task: task}, &river.InsertOpts{Queue: queue, MaxAttempts: 3, UniqueOpts: river.UniqueOpts{ByArgs: true, ByState: []rivertype.JobState{rivertype.JobStateAvailable, rivertype.JobStatePending, rivertype.JobStateRunning, rivertype.JobStateRetryable, rivertype.JobStateScheduled}}}
		}, &river.PeriodicJobOpts{ID: task, RunOnStart: true}))
	}
	client, e := river.NewClient(database.JobsDriver(), &river.Config{Schema: "nexo_jobs", Workers: workers, JobTimeout: 30 * time.Minute, Queues: map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 1}, "network": {MaxWorkers: 2}}, PeriodicJobs: periodic})
	if e != nil {
		return nil, e
	}
	if e = client.Start(ctx); e != nil {
		return nil, e
	}
	return client.Stop, nil
}
