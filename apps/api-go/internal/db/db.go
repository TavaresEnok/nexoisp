package db

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"nexoisp/api-go/internal/fault"
	"nexoisp/api-go/internal/jsonx"
	gen "nexoisp/api-go/internal/modules/cadastro/gen"
	"nexoisp/api-go/internal/tenancy"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

type DB struct {
	pool         *pgxpool.Pool
	config       *pgx.ConnConfig
	Directory    *tenancy.Directory
	Wait         prometheus.Histogram
	Transactions prometheus.Counter
	Queries      prometheus.Histogram
}
type Tx struct {
	raw     pgx.Tx
	Queries *gen.Queries
}

func Open(ctx context.Context, url, mode string, maxConns int, reg prometheus.Registerer) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	if mode != "force_custom_plan" && mode != "auto" {
		return nil, fmt.Errorf("política de plano inválida")
	}
	cfg.MaxConns = int32(maxConns)
	cfg.MinConns = 0
	cfg.ConnConfig.RuntimeParams["plan_cache_mode"] = mode
	cfg.ConnConfig.RuntimeParams["application_name"] = "nexo-go"
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheStatement
	cfg.ConnConfig.Tracer = otelpgx.NewTracer()
	p, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	d := &DB{pool: p, config: cfg.ConnConfig.Copy(), Directory: &tenancy.Directory{}, Wait: prometheus.NewHistogram(prometheus.HistogramOpts{Name: "nexo_pool_acquire_seconds", Buckets: prometheus.ExponentialBuckets(.0001, 2, 16)}), Transactions: prometheus.NewCounter(prometheus.CounterOpts{Name: "nexo_db_transactions_total"}), Queries: prometheus.NewHistogram(prometheus.HistogramOpts{Name: "nexo_db_scope_seconds", Buckets: prometheus.DefBuckets})}
	reg.MustRegister(d.Wait, d.Transactions, d.Queries, prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "nexo_pool_in_use"}, func() float64 { return float64(p.Stat().AcquiredConns()) }))
	if err = d.Verify(ctx); err != nil {
		p.Close()
		return nil, err
	}
	if err = d.RefreshDirectory(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return d, nil
}
func (d *DB) Close() { d.pool.Close() }
func (d *DB) Verify(ctx context.Context) error {
	var unsafe bool
	err := d.pool.QueryRow(ctx, `select exists(select 1 from pg_roles where pg_has_role(current_user,oid,'MEMBER') and (rolsuper or rolbypassrls)) or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and pg_has_role(current_user,c.relowner,'MEMBER'))`).Scan(&unsafe)
	if err != nil {
		return err
	}
	if unsafe {
		return fmt.Errorf("papel privilegiado ou dono de tabela: API recusada")
	}
	var tables *string
	if err = d.pool.QueryRow(ctx, rlsSQL).Scan(&tables); err != nil {
		return err
	}
	if tables != nil {
		return fmt.Errorf("RLS ausente: %s", *tables)
	}
	return nil
}
func (d *DB) WithScope(ctx context.Context, s tenancy.Scope, fn func(*Tx) error) error {
	if fault.Active("sem_pop") {
		s.PopIDs = nil
	}
	if fault.Active("sem_assinante") {
		s.SubscriberID = ""
	}
	if fault.Active("sem_set_config") {
		s.TenantID = ""
	}
	cell, err := d.Resolve(ctx, s.TenantID)
	if err != nil {
		return err
	}
	if s.Cell != "" && s.Cell != cell {
		return fmt.Errorf("célula divergente")
	}
	if cell != "c1" {
		return fmt.Errorf("pool da célula não configurado")
	}
	start := time.Now()
	// pg.Pool no produto aguarda até obter conexão ou cancelar a requisição.
	// Um timeout exclusivo do Go mudaria o contrato sob contenção.
	c, err := d.pool.Acquire(ctx)
	d.Wait.Observe(time.Since(start).Seconds())
	if err != nil {
		return err
	}
	defer c.Release()
	tx, err := c.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	operator := "off"
	if s.IsOperator() {
		operator = "on"
	}
	scopeSQL := `select set_config('app.tenant_id', $1, true), set_config('app.is_operator', $2, true), set_config('app.subscriber_id', $3, true), set_config('app.pop_ids', $4, true)`
	if fault.Active("set_config_de_sessao") {
		scopeSQL = strings.ReplaceAll(scopeSQL, ", true)", ", false)")
	}
	_, err = tx.Exec(ctx, scopeSQL, s.TenantID, operator, s.SubscriberID, strings.Join(s.PopIDs, ","))
	if err != nil {
		return err
	}
	d.Transactions.Inc()
	defer func() { d.Queries.Observe(time.Since(start).Seconds()) }()
	if err = fn(&Tx{raw: tx, Queries: gen.New(tx)}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (t *Tx) Exec(ctx context.Context, sql string, args ...any) error {
	_, e := t.raw.Exec(ctx, sql, args...)
	return e
}
func (t *Tx) Affected(ctx context.Context, sql string, args ...any) (int64, error) {
	tag, err := t.raw.Exec(ctx, sql, args...)
	return tag.RowsAffected(), err
}
func (t *Tx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return t.raw.QueryRow(ctx, sql, args...)
}
func (t *Tx) Objects(ctx context.Context, sql string, args ...any) ([]jsonx.Object, error) {
	rows, err := t.raw.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []jsonx.Object{}
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		o := jsonx.Object{}
		for i, f := range rows.FieldDescriptions() {
			if (f.DataTypeOID == 114 || f.DataTypeOID == 3802) && values[i] != nil {
				raw := append([]byte{}, rows.RawValues()[i]...)
				if f.DataTypeOID == 3802 && len(raw) > 0 && raw[0] == 1 {
					raw = raw[1:]
				}
				o.Set(f.Name, jsonx.JSON(raw))
			} else {
				o.Set(f.Name, jsonx.Normalize(values[i], f.DataTypeOID))
			}
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// AuthData changes scope inside the same transaction after resolving the signed session.
func (t *Tx) AuthData(ctx context.Context, tenant, user string) ([]string, []string, error) {
	if tenant == "" {
		return []string{}, nil, nil
	}
	if err := t.Exec(ctx, `select set_config('app.tenant_id', $1, true), set_config('app.is_operator', 'off', true), set_config('app.subscriber_id', '', true), set_config('app.pop_ids', '', true)`, tenant); err != nil {
		return nil, nil, err
	}
	var modules, pops []string
	err := t.QueryRow(ctx, `select (select modules from tenants where id = $1) as modules, (select coalesce(array_agg(pop_id::text), '{}') from user_pops where user_id = $2) as pop_ids`, tenant, user).Scan(&modules, &pops)
	return modules, pops, err
}
func (d *DB) RefreshDirectory(ctx context.Context) error {
	return d.WithScope(ctx, tenancy.Scope{}, func(t *Tx) error {
		objects, err := t.Objects(ctx, "select * from nexo_go_directory()")
		if err != nil {
			return err
		}
		entries := map[string]string{}
		for _, o := range objects {
			entries[o.Get("tenant_id").(string)] = o.Get("cell_id").(string)
		}
		d.Directory.Replace(entries)
		return nil
	})
}

type Notification struct {
	Kind   string    `json:"k"`
	Hash   string    `json:"h"`
	User   string    `json:"u"`
	Tenant string    `json:"t"`
	At     time.Time `json:"at"`
}

// Dedicated connection: LISTEN never occupies or leaks session state into the request pool.
func (d *DB) Listen(ctx context.Context, event func(Notification), state func(bool)) {
	for ctx.Err() == nil {
		state(false)
		d.Directory.Disable()
		c, err := pgx.ConnectConfig(ctx, d.config.Copy())
		if err == nil {
			_, err = c.Exec(ctx, "listen nexo_auth")
		}
		if err == nil {
			err = d.RefreshDirectory(ctx)
		}
		if err == nil {
			state(true)
			for ctx.Err() == nil {
				var n *pgconn.Notification
				n, err = c.WaitForNotification(ctx)
				if err != nil {
					break
				}
				var msg Notification
				if e := json.Unmarshal([]byte(n.Payload), &msg); e != nil {
					state(false)
					continue
				}
				if msg.Kind == "cell" {
					if e := d.RefreshDirectory(ctx); e != nil {
						d.Directory.Disable()
						state(false)
					}
				}
				event(msg)
			}
		}
		state(false)
		if c != nil {
			closeCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			_ = c.Close(closeCtx)
			cancel()
		}
		if ctx.Err() != nil {
			return
		}
		slog.Warn("escuta de autenticação desconectada; cache desligado")
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (d *DB) Resolve(ctx context.Context, tenant string) (string, error) {
	cell, err := d.Directory.Resolve(tenant)
	if err != nil {
		if err = d.RefreshDirectory(ctx); err != nil {
			return "", err
		}
		return d.Directory.Resolve(tenant)
	}
	return cell, nil
}
