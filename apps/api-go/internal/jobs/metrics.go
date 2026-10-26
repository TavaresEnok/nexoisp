package jobs

import (
	"context"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type metrics struct {
	failures *prometheus.CounterVec
	success  *prometheus.GaugeVec
	duration *prometheus.HistogramVec
}

func newMetrics(database *db.DB, reg prometheus.Registerer) *metrics {
	m := &metrics{
		failures: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "nexo_tenant_job_failures_total", Help: "Failed tenant task attempts."}, []string{"tenant", "task"}),
		success:  prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "nexo_tenant_job_last_success_timestamp_seconds", Help: "Last successful tenant task."}, []string{"tenant", "task"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "nexo_tenant_job_seconds", Help: "Tenant task duration.", Buckets: []float64{.1, 1, 5, 15, 60, 300}}, []string{"task"}),
	}
	reg.MustRegister(m.failures, m.success, m.duration, &queueCollector{db: database,
		count:   prometheus.NewDesc("nexo_jobs_count", "Durable jobs by queue and state.", []string{"queue", "state"}, nil),
		age:     prometheus.NewDesc("nexo_jobs_oldest_due_seconds", "Age of oldest due unfinished job.", []string{"queue", "state"}, nil),
		healthy: prometheus.NewDesc("nexo_jobs_scrape_success", "Whether queue collection succeeded.", nil, nil),
	})
	return m
}

type queueCollector struct {
	db                  *db.DB
	count, age, healthy *prometheus.Desc
}

func (c *queueCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.count
	ch <- c.age
	ch <- c.healthy
}
func (c *queueCollector) Collect(ch chan<- prometheus.Metric) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := c.db.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		rows, err := tx.Objects(ctx, `select queue,state::text,count(*)::float8 as n,
   greatest(0,extract(epoch from now()-min(scheduled_at)))::float8 as age
   from nexo_jobs.river_job where state<>'completed' group by queue,state`)
		if err != nil {
			return err
		}
		for _, row := range rows {
			queue, state := row.Get("queue").(string), row.Get("state").(string)
			ch <- prometheus.MustNewConstMetric(c.count, prometheus.GaugeValue, row.Get("n").(float64), queue, state)
			ch <- prometheus.MustNewConstMetric(c.age, prometheus.GaugeValue, row.Get("age").(float64), queue, state)
		}
		return nil
	})
	healthy := 1.0
	if err != nil {
		healthy = 0
	}
	ch <- prometheus.MustNewConstMetric(c.healthy, prometheus.GaugeValue, healthy)
}
