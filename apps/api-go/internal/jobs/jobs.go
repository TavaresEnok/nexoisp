// Package jobs executes periodic tasks through River in a private schema.
package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/finance"
	"nexoisp/api-go/internal/jobargs"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/escrita"
	"nexoisp/api-go/internal/outbound"
	"nexoisp/api-go/internal/radius"
	"nexoisp/api-go/internal/tenancy"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

type Args = jobargs.Periodic

type worker struct {
	river.WorkerDefaults[Args]
	db        *db.DB
	radius    *radius.Executor
	mu        sync.Mutex
	lastAlert string
	metrics   *metrics
}
type operationWorker struct {
	river.WorkerDefaults[jobargs.Operation]
	radius *radius.Executor
}

func (w *operationWorker) Work(ctx context.Context, j *river.Job[jobargs.Operation]) error {
	if _, e := uuid.Parse(j.Args.TenantID); e != nil {
		return e
	}
	if _, e := uuid.Parse(j.Args.OperationID); e != nil {
		return e
	}
	if os.Getenv("NEXO_GO_JOB_RADIUS") != "1" {
		return river.JobSnooze(time.Minute)
	}
	done, e := w.radius.RunOperation(ctx, j.Args.TenantID, j.Args.OperationID)
	if e != nil {
		return e
	}
	if !done {
		return river.JobSnooze(2 * time.Second)
	}
	return nil
}

func tenantTask(task string) bool {
	switch task {
	case "PSP_OPERATIONS", "PSP_RECEIPTS", "PSP_ISSUANCE", "PAYMENT_EFFECTS", "BILLING", "RECONCILE", "NOTICES", "SCHEDULED", "SLA", "PURGE", "TRUST", "SUSPEND", "NOTIFICATIONS", "WEBHOOKS":
		return true
	}
	return false
}

func (w *worker) Work(ctx context.Context, j *river.Job[Args]) error {
	task := j.Args.Task
	if os.Getenv("NEXO_GO_JOB_"+task) != "1" {
		return nil
	}
	if tenantTask(task) {
		if j.Args.TenantID == "" {
			// Commit all dispatches together; a failed tenant never retries its peers.
			return w.db.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
				tenants, err := tx.Objects(ctx, "select tenant_id from worker_tenants()")
				if err != nil {
					return err
				}
				for _, tenant := range tenants {
					if err = tx.EnqueuePeriodic(ctx, task, tenant.Get("tenant_id").(string)); err != nil {
						return err
					}
				}
				return nil
			})
		}
		if _, err := uuid.Parse(j.Args.TenantID); err != nil {
			return err
		}
		acquired, err := w.db.TryTenantWorkerLock(ctx, j.Args.TenantID, func() error {
			return w.runTenant(ctx, task, j.Args.TenantID)
		})
		if err != nil {
			slog.Error("rotina do provedor falhou", "task", task, "tenant", j.Args.TenantID, "error", err)
			return err
		}
		if !acquired {
			return river.JobSnooze(2 * time.Second)
		}
		return nil
	}
	if j.Args.TenantID != "" {
		return fmt.Errorf("rotina global não aceita provedor")
	}
	switch task {
	case "RADIUS":
		return w.radius.Run(ctx, false)
	case "RADIUS_SYNC":
		return w.radius.Run(ctx, true)
	case "CLEANUP", "ALERTS":
		return w.db.WithWorkerLock(ctx, 7411002, func() error {
			if task == "ALERTS" {
				return w.alerts(ctx)
			}
			return w.db.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
				if err := tx.Exec(ctx, "select login_throttle_purge()"); err != nil {
					return err
				}
				return tx.Exec(ctx, "select nexo_panel_rate_purge()")
			})
		})
	}
	return fmt.Errorf("rotina desconhecida: %s", task)
}

func (w *worker) runTenant(ctx context.Context, task, tenant string) (err error) {
	started := time.Now()
	defer func() {
		if w.metrics == nil {
			return
		}
		w.metrics.duration.WithLabelValues(task).Observe(time.Since(started).Seconds())
		if err != nil {
			w.metrics.failures.WithLabelValues(tenant, task).Inc()
		} else {
			w.metrics.success.WithLabelValues(tenant, task).SetToCurrentTime()
		}
	}()
	// Refresh active status/settings at execution time, including on retries.
	var settings jsonx.Object
	err = w.db.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		rows, err := tx.Objects(ctx, "select * from worker_tenants() where tenant_id=$1", tenant)
		if len(rows) > 0 {
			settings = rows[0]
		}
		return err
	})
	if err != nil || settings == nil {
		return err
	}
	switch task {
	case "PSP_OPERATIONS":
		return finance.ProcessProviderOperations(ctx, w.db, tenant)
	case "PSP_RECEIPTS":
		return finance.ProcessProviderReceipts(ctx, w.db, tenant)
	case "PSP_ISSUANCE":
		return finance.ProcessProviderIssuance(ctx, w.db, tenant)
	case "PAYMENT_EFFECTS":
		return finance.ProcessPaidEffects(ctx, w.db, tenant)
	case "NOTIFICATIONS":
		_, err = outbound.Notifications(ctx, w.db, tenant)
		return err
	case "WEBHOOKS":
		_, err = outbound.Webhooks(ctx, w.db, tenant)
		return err
	case "NOTICES":
		_, err = outbound.Notices(ctx, w.db, tenant, false)
		return err
	case "SCHEDULED":
		_, err = (escrita.Service{DB: w.db}).Scheduled(ctx, tenant)
		return err
	}
	return w.db.WithScope(ctx, tenancy.Scope{TenantID: tenant}, func(tx *db.Tx) error {
		switch task {
		case "BILLING":
			if settings.Get("billing_auto") != true {
				return nil
			}
			comp, err := finance.Competence(ctx, tx, settings.Get("timezone"))
			if err != nil {
				return err
			}
			created, err := finance.Generate(ctx, tx, tenant, comp.(string))
			if err != nil {
				return err
			}
			if _, err = finance.Charges(ctx, tx, tenant); err != nil {
				return err
			}
			if fmt.Sprint(created) != "0" {
				return finance.SysAudit(ctx, tx, tenant, "finance.generate_monthly", "invoice", nil, map[string]any{"created": created}, "ok")
			}
		case "RECONCILE":
			if settings.Get("gateway") != "none" {
				_, err := finance.Reconcile(ctx, tx, tenant)
				return err
			}
		case "SUSPEND":
			if settings.Get("auto_suspend") == true {
				_, err := finance.AutoSuspend(ctx, tx, tenant, nil)
				return err
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
func Start(ctx context.Context, database *db.DB, registerers ...prometheus.Registerer) (func(context.Context) error, error) {
	if os.Getenv("NEXO_GO_JOBS") != "1" {
		return func(context.Context) error { return nil }, nil
	}
	workers := river.NewWorkers()
	w := &worker{db: database, radius: &radius.Executor{DB: database}}
	if len(registerers) > 0 {
		w.metrics = newMetrics(database, registerers[0])
	}
	river.AddWorker(workers, w)
	river.AddWorker(workers, &operationWorker{radius: w.radius})
	periodic := []*river.PeriodicJob{}
	for _, task := range []string{"PSP_OPERATIONS", "PSP_RECEIPTS", "PSP_ISSUANCE", "PAYMENT_EFFECTS", "BILLING", "RECONCILE", "NOTICES", "SCHEDULED", "SLA", "PURGE", "TRUST", "SUSPEND", "NOTIFICATIONS", "WEBHOOKS", "ALERTS", "CLEANUP", "RADIUS", "RADIUS_SYNC"} {
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
	client, e := river.NewClient(database.JobsDriver(), &river.Config{Schema: "nexo_jobs", Workers: workers, JobTimeout: 30 * time.Minute, Queues: map[string]river.QueueConfig{river.QueueDefault: {MaxWorkers: 1}, "network": {MaxWorkers: 2}, "tenant": {MaxWorkers: 4}}, PeriodicJobs: periodic})
	if e != nil {
		return nil, e
	}
	database.SetOperationQueue(client)
	if e = client.Start(ctx); e != nil {
		database.SetOperationQueue(nil)
		return nil, e
	}
	return client.Stop, nil
}
