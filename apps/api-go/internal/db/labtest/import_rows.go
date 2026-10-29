// Package labtest altera uma fixture sintética de import_rows no laboratório.
// O servidor HTTP não importa este pacote. Não há executor SQL administrativo genérico.
package labtest

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const (
	labDatabase = "nexo_test"
	labOwner    = "nexo_owner"

	identitySQL = `select current_database(), session_user::text, current_user::text`
	batchSQL    = `select count(*) from import_batches where id = $1::uuid and tenant_id = $2::uuid`
	rowsSQL     = `select count(*) from import_rows where tenant_id = $1::uuid and batch_id = $2::uuid`
	updateSQL   = `update import_rows set status = 'updated' where tenant_id = $1::uuid and batch_id = $2::uuid and status = 'created'`
)

// MarkSyntheticImportRowUpdated grava status updated em exatamente uma linha
// de import_rows do tenant e do lote. ownerURL é a URL explícita do papel
// nexo_owner no banco nexo_test. Destino indevido é recusado antes do update.
func MarkSyntheticImportRowUpdated(ctx context.Context, ownerURL, tenantID, batchID string) error {
	return markSyntheticImportRowUpdated(ctx, ownerURL, tenantID, batchID, dialOwner)
}

type ownerConn interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Begin(ctx context.Context) (ownerTx, error)
	Close(ctx context.Context) error
}

type ownerTx interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error
}

type pgxOwner struct{ conn *pgx.Conn }

func (p pgxOwner) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return p.conn.QueryRow(ctx, sql, args...)
}

func (p pgxOwner) Begin(ctx context.Context) (ownerTx, error) {
	return p.conn.Begin(ctx)
}

func (p pgxOwner) Close(ctx context.Context) error { return p.conn.Close(ctx) }

func dialOwner(ctx context.Context, cfg *pgx.ConnConfig) (ownerConn, error) {
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return pgxOwner{conn: conn}, nil
}

func markSyntheticImportRowUpdated(ctx context.Context, ownerURL, tenantID, batchID string, dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
	if strings.TrimSpace(ownerURL) == "" {
		return errors.New("url de owner do laboratório ausente")
	}
	if _, err := uuid.Parse(tenantID); err != nil {
		return errors.New("tenant da fixture inválido")
	}
	if _, err := uuid.Parse(batchID); err != nil {
		return errors.New("lote da fixture inválido")
	}
	cfg, err := pgx.ParseConfig(ownerURL)
	if err != nil {
		return errors.New("url de owner do laboratório inválida")
	}
	if cfg.Database != labDatabase || cfg.User != labOwner {
		return errors.New("destino recusado: a fixture de import_rows exige o banco nexo_test e o papel nexo_owner")
	}
	if cfg.ConnectTimeout <= 0 {
		cfg.ConnectTimeout = 15 * time.Second
	}
	conn, err := dial(ctx, cfg)
	if err != nil {
		return scrub(err, ownerURL, cfg.Password)
	}
	defer conn.Close(ctx)
	var database, sessionUser, currentUser string
	if err = conn.QueryRow(ctx, identitySQL).Scan(&database, &sessionUser, &currentUser); err != nil {
		return scrub(err, ownerURL, cfg.Password)
	}
	if database != labDatabase || sessionUser != labOwner || currentUser != labOwner {
		return errors.New("destino efetivo recusado")
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return scrub(err, ownerURL, cfg.Password)
	}
	defer tx.Rollback(ctx)
	var batches int
	if err = tx.QueryRow(ctx, batchSQL, batchID, tenantID).Scan(&batches); err != nil {
		return scrub(err, ownerURL, cfg.Password)
	}
	if batches != 1 {
		return errors.New("lote não pertence ao tenant da fixture")
	}
	var rows int
	if err = tx.QueryRow(ctx, rowsSQL, tenantID, batchID).Scan(&rows); err != nil {
		return scrub(err, ownerURL, cfg.Password)
	}
	if rows != 1 {
		return errors.New("a fixture exige exatamente uma linha de import_rows")
	}
	tag, err := tx.Exec(ctx, updateSQL, tenantID, batchID)
	if err != nil {
		return scrub(err, ownerURL, cfg.Password)
	}
	if tag.RowsAffected() != 1 {
		return errors.New("import_rows sintético alterou quantidade inesperada")
	}
	if err = tx.Commit(ctx); err != nil {
		return scrub(err, ownerURL, cfg.Password)
	}
	return nil
}

func scrub(err error, secrets ...string) error {
	if err == nil {
		return nil
	}
	msg := chain(err)
	for _, secret := range secrets {
		if secret != "" && strings.Contains(msg, secret) {
			return errors.New("conexão do laboratório recusada")
		}
	}
	if strings.Contains(msg, "://") {
		return errors.New("conexão do laboratório recusada")
	}
	return fmt.Errorf("conexão do laboratório recusada: %w", err)
}

func chain(err error) string {
	var b strings.Builder
	for err != nil {
		b.WriteString(err.Error())
		b.WriteByte('\n')
		err = errors.Unwrap(err)
	}
	return b.String()
}
