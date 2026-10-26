package auth

import (
	"context"
	"errors"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"
	"time"

	"github.com/jackc/pgx/v5"
)

type Ctx struct {
	UserID, Name, Email, Role, TenantID, SubscriberID, TokenHash string
	Support, MFAEnabled                                          bool
	PopIDs, Modules, Permissions                                 []string
	ExpiresAt                                                    time.Time
	SessionCell                                                  string
	Scope                                                        tenancy.Scope
}
type key struct{}

func From(ctx context.Context) *Ctx                    { c, _ := ctx.Value(key{}).(*Ctx); return c }
func With(ctx context.Context, c *Ctx) context.Context { return context.WithValue(ctx, key{}, c) }

type Loader interface {
	Load(context.Context, string) (*Ctx, error)
}
type DBLoader struct{ DB *db.DB }

// Rate shares the same atomic counter across all API replicas, without exposing
// session counters or credentials to application roles.
func (l DBLoader) Rate(ctx context.Context, hash string, limit int) (int, int, error) {
	var calls, retry int
	rows, cell, lookupErr := l.DB.Lookup(ctx, "select * from nexo_go_session_get($1)", hash)
	if lookupErr != nil {
		return 0, 0, lookupErr
	}
	if len(rows) == 0 {
		return 0, 0, apierr.New(401, "sessão inválida ou expirada")
	}
	ctx = db.WithCell(ctx, cell)
	err := l.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		return tx.QueryRow(ctx, "select calls,retry_after from nexo_panel_rate_take($1,$2)", hash, limit).Scan(&calls, &retry)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		err = apierr.New(401, "sessão inválida ou expirada")
	}
	return calls, retry, err
}

func (l DBLoader) Load(ctx context.Context, hash string) (*Ctx, error) {
	rows, sessionCell, lookupErr := l.DB.Lookup(ctx, "select * from nexo_go_session_get($1)", hash)
	if lookupErr != nil {
		return nil, lookupErr
	}
	if len(rows) == 0 {
		return nil, apierr.New(401, "sessão inválida ou expirada")
	}
	ctx = db.WithCell(ctx, sessionCell)
	c := &Ctx{TokenHash: hash, SessionCell: sessionCell}
	var tenant, subscriber, support *string
	err := l.DB.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error {
		err := tx.QueryRow(ctx, "select * from nexo_go_session_get($1)", hash).Scan(&c.UserID, &tenant, &c.Role, &c.Name, &c.Email, &subscriber, &support, &c.MFAEnabled, &c.ExpiresAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return apierr.New(401, "sessão inválida ou expirada")
		}
		if err != nil {
			return err
		}
		if tenant != nil {
			c.TenantID = *tenant
		}
		if subscriber != nil {
			c.SubscriberID = *subscriber
		}
		if c.Role == "saas_operator" {
			c.TenantID = ""
			if support != nil {
				c.TenantID = *support
				c.Support = true
			}
		}
		return nil
	})
	if err != nil {
		return c, err
	}
	err = l.DB.WithScope(ctx, tenancy.Scope{TenantID: c.TenantID}, func(tx *db.Tx) error {
		cell, err := l.DB.Resolve(ctx, c.TenantID)
		if err != nil {
			return err
		}
		modules, pops, err := tx.AuthData(ctx, c.TenantID, c.UserID)
		if err != nil {
			return err
		}
		c.Modules = modules
		if !c.Support && c.Role != "admin" && c.Role != "subscriber" && c.Role != "saas_operator" {
			c.PopIDs = pops
		}
		c.Permissions = append([]string{}, Permissions[c.Role]...)
		if c.Support {
			c.Permissions = append(append([]string{}, Permissions["admin"]...), "tenants:manage")
		}
		c.Scope = tenancy.Scope{Cell: cell, TenantID: c.TenantID, PopIDs: c.PopIDs}
		if c.Role == "subscriber" {
			c.Scope.SubscriberID = c.SubscriberID
		}
		// As rotas desta fase recusam operador global; o escopo global só é necessário para auditar sua negativa.
		if c.Role == "saas_operator" && !c.Support {
			c.Scope, err = tenancy.OperatorScope("auditoria_negativa")
			if err != nil {
				return err
			}
		}
		return nil
	})
	return c, err
}
