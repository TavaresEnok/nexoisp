package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

type cellContextKey struct{}

// WithCell is set only after server-side lookup of a credential, never from an HTTP header.
func WithCell(ctx context.Context, cell string) context.Context {
	return context.WithValue(ctx, cellContextKey{}, cell)
}
func (d *DB) CellID() string {
	if d.cellID == "" {
		return "c1"
	}
	return d.cellID
}
func (d *DB) Cells() []*DB {
	if len(d.cells) == 0 {
		return []*DB{d}
	}
	ids := make([]string, 0, len(d.cells))
	for id := range d.cells {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]*DB, 0, len(ids))
	for _, id := range ids {
		out = append(out, d.cells[id])
	}
	return out
}
func (d *DB) cell(id string) (*DB, error) {
	if id == d.CellID() {
		return d, nil
	}
	if other := d.cells[id]; other != nil {
		return other, nil
	}
	return nil, fmt.Errorf("pool da célula %s não configurado", id)
}
func Open(ctx context.Context, url, mode string, maxConns int, reg prometheus.Registerer) (*DB, error) {
	urls := map[string]string{"c1": url}
	if raw := os.Getenv("NEXO_CELL_DATABASE_URLS"); raw != "" {
		var extra map[string]string
		if json.Unmarshal([]byte(raw), &extra) != nil {
			return nil, errors.New("NEXO_CELL_DATABASE_URLS deve ser um objeto JSON de célula para DSN")
		}
		for id, dsn := range extra {
			if id == "c1" || !regexp.MustCompile(`^c[1-9][0-9]*$`).MatchString(id) || dsn == "" {
				return nil, errors.New("identificador ou conexão de célula inválido")
			}
			urls[id] = dsn
		}
	}
	cells := map[string]*DB{}
	cleanup := func() {
		for _, c := range cells {
			c.pool.Close()
		}
	}
	ids := make([]string, 0, len(urls))
	for id := range urls {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	directory := &tenancy.Directory{}
	for _, id := range ids {
		c, err := openSingle(ctx, urls[id], mode, maxConns, prometheus.WrapRegistererWith(prometheus.Labels{"db_cell": id}, reg))
		if err != nil {
			cleanup()
			return nil, fmt.Errorf("abertura da célula %s recusada: %w", id, err)
		}
		c.cellID = id
		c.Directory = directory
		cells[id] = c
		if len(urls) > 1 {
			var actual string
			if err = c.pool.QueryRow(ctx, "select id from nexo_cell_identity").Scan(&actual); err != nil || actual != id {
				cleanup()
				return nil, fmt.Errorf("identidade da célula %s divergente ou não inicializada", id)
			}
		}
	}
	for _, c := range cells {
		c.cells = cells
	}
	d := cells["c1"]
	if err := d.RefreshDirectory(ctx); err != nil {
		cleanup()
		return nil, err
	}
	return d, nil
}

// Lookup reads credential locator functions in every configured cell, refusing ambiguity.
// An unavailable cell fails closed; another cell is never used as a fallback for tenant data.
func (d *DB) Lookup(ctx context.Context, sql string, args ...any) ([]jsonx.Object, string, error) {
	var found []jsonx.Object
	cell := ""
	for _, candidate := range d.Cells() {
		var rows []jsonx.Object
		err := candidate.WithScope(WithCell(ctx, candidate.CellID()), tenancy.Scope{}, func(tx *Tx) error {
			if e := tx.Exec(ctx, "set transaction read only"); e != nil {
				return e
			}
			var e error
			rows, e = tx.Objects(ctx, sql, args...)
			return e
		})
		if err != nil {
			return nil, "", err
		}
		if len(rows) > 0 {
			if cell != "" {
				return nil, "", errors.New("identificador ambíguo entre células")
			}
			cell = candidate.CellID()
			found = rows
		}
	}
	return found, cell, nil
}

func (d *DB) Listen(ctx context.Context, event func(Notification), state func(bool)) {
	var wg sync.WaitGroup
	var mu sync.Mutex
	connected := map[string]bool{}
	cells := d.Cells()
	for _, c := range cells {
		wg.Add(1)
		go func(c *DB) {
			defer wg.Done()
			c.listenOne(ctx, event, func(ready bool) {
				mu.Lock()
				defer mu.Unlock()
				connected[c.CellID()] = ready
				all := len(connected) == len(cells)
				for _, up := range connected {
					all = all && up
				}
				state(all)
			})
		}(c)
	}
	wg.Wait()
}
