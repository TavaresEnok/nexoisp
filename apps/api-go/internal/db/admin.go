package db

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

func Root() (string, error) {
	p, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err = os.Stat(filepath.Join(p, "db/legado.sha256.json")); err == nil {
			return p, nil
		}
		parent := filepath.Dir(p)
		if parent == p {
			return "", fmt.Errorf("execute dentro do clone NexoISP")
		}
		p = parent
	}
}

func VerifyCopies(root string) error {
	raw, err := os.ReadFile(filepath.Join(root, "db/legado.sha256.json"))
	if err != nil {
		return err
	}
	var hashes map[string]string
	if err = json.Unmarshal(raw, &hashes); err != nil {
		return err
	}
	if len(hashes) != 53 {
		return fmt.Errorf("esperadas 53 migrations legadas")
	}
	names := make([]string, 0, len(hashes))
	for name := range hashes {
		names = append(names, name)
	}
	sort.Strings(names)
	for i, file := range names {
		name := fmt.Sprintf("%05d_%s", i+1, strings.SplitN(file, "_", 2)[1])
		copySQL, err := os.ReadFile(filepath.Join(root, "db/migrations", name))
		if err != nil {
			return err
		}
		prefix, suffix := []byte("-- +goose Up\n-- +goose StatementBegin\n"), []byte("-- +goose StatementEnd\n")
		if !bytes.HasPrefix(copySQL, prefix) || !bytes.HasSuffix(copySQL, suffix) {
			return fmt.Errorf("anotações goose inválidas: %s", name)
		}
		original := copySQL[len(prefix) : len(copySQL)-len(suffix)]
		sum := sha256.Sum256(original)
		if hex.EncodeToString(sum[:]) != hashes[file] {
			return fmt.Errorf("SQL divergente: %s", name)
		}
		if legacy, e := os.ReadFile(filepath.Join(root, "legacy/fastify/migrations", file)); e == nil && !bytes.Equal(legacy, original) {
			return fmt.Errorf("legado divergente: %s", file)
		} else if e != nil && !os.IsNotExist(e) {
			return e
		}
	}
	return nil
}

// Credencial dona existe apenas no executável administrativo, nunca no servidor HTTP.
func Admin(ctx context.Context, command, root string, initApp bool) error {
	if err := VerifyCopies(root); err != nil {
		return err
	}
	url := os.Getenv("DATABASE_URL_OWNER")
	if url == "" {
		return fmt.Errorf("DATABASE_URL_OWNER obrigatória")
	}
	cfg, err := pgx.ParseConfig(url)
	if err != nil {
		return err
	}
	conn := stdlib.OpenDB(*cfg)
	defer conn.Close()
	lock, err := conn.Conn(ctx)
	if err != nil {
		return err
	}
	defer lock.Close()
	if _, err = lock.ExecContext(ctx, "select pg_advisory_lock(7411001)"); err != nil {
		return err
	}
	defer func() { _, _ = lock.ExecContext(context.Background(), "select pg_advisory_unlock(7411001)") }()
	switch command {
	case "bootstrap":
		var exists bool
		if err = conn.QueryRowContext(ctx, "select exists(select 1 from pg_roles where rolname='nexo_app')").Scan(&exists); err != nil {
			return err
		}
		if !exists {
			if !initApp {
				return fmt.Errorf("nexo_app ausente: para cluster NOVO use bootstrap --init-app-role")
			}
			pw := os.Getenv("NEXO_APP_DB_PASSWORD")
			if pw == "" {
				return fmt.Errorf("NEXO_APP_DB_PASSWORD obrigatória para criar nexo_app")
			}
			if _, err = conn.ExecContext(ctx, "create role nexo_app login inherit nosuperuser nobypassrls nocreatedb nocreaterole password "+quote(pw)); err != nil {
				return err
			}
		}
		var unsafe bool
		if err = conn.QueryRowContext(ctx, "select rolsuper or rolbypassrls from pg_roles where rolname='nexo_app'").Scan(&unsafe); err != nil {
			return err
		}
		if unsafe {
			return fmt.Errorf("nexo_app privilegiado; recusado")
		}
		pw := os.Getenv("NEXO_GO_DB_PASSWORD")
		if pw == "" {
			return fmt.Errorf("NEXO_GO_DB_PASSWORD obrigatória")
		}
		if err = conn.QueryRowContext(ctx, "select exists(select 1 from pg_roles where rolname='nexo_go')").Scan(&exists); err != nil {
			return err
		}
		verb := "create"
		if exists {
			verb = "alter"
		}
		if _, err = conn.ExecContext(ctx, verb+" role nexo_go login inherit nosuperuser nobypassrls nocreatedb nocreaterole password "+quote(pw)); err != nil {
			return err
		}
		if _, err = conn.ExecContext(ctx, "grant nexo_app to nexo_go"); err != nil {
			return err
		}
		return provisionNetworkRoles(ctx, conn)
	case "baseline":
		return baseline(ctx, conn, root)
	case "up":
		if err = goose.SetDialect("postgres"); err != nil {
			return err
		}
		return goose.UpContext(ctx, conn, filepath.Join(root, "db/migrations"))
	case "verificar":
		rows, err := conn.QueryContext(ctx, "select rolname from pg_roles where rolname in ('nexo_app','nexo_go') and not rolsuper and not rolbypassrls")
		if err != nil {
			return err
		}
		defer rows.Close()
		n := 0
		for rows.Next() {
			n++
		}
		if err = rows.Err(); err != nil {
			return err
		}
		if n != 2 {
			return fmt.Errorf("papéis ausentes ou privilegiados")
		}
		return checkRLS(ctx, conn)
	default:
		return fmt.Errorf("comando desconhecido: %s", command)
	}
}
func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
func baseline(ctx context.Context, conn *sql.DB, root string) error {
	var exists bool
	if err := conn.QueryRowContext(ctx, "select to_regclass('public.goose_db_version') is not null").Scan(&exists); err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("baseline recusado: goose_db_version já existe")
	}
	rows, err := conn.QueryContext(ctx, "select name from schema_migrations order by name")
	if err != nil {
		return err
	}
	names := []string{}
	for rows.Next() {
		var s string
		if err = rows.Scan(&s); err != nil {
			rows.Close()
			return err
		}
		names = append(names, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(filepath.Join(root, "db/legado.sha256.json"))
	if err != nil {
		return err
	}
	var hashes map[string]string
	if err = json.Unmarshal(raw, &hashes); err != nil {
		return err
	}
	expected := []string{}
	for name := range hashes {
		expected = append(expected, name)
	}
	sort.Strings(expected)
	if strings.Join(names, "\n") != strings.Join(expected, "\n") {
		return fmt.Errorf("baseline recusado: conjunto legado incompleto ou desconhecido")
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `create table goose_db_version (id integer primary key generated by default as identity, version_id bigint not null, is_applied boolean not null, tstamp timestamp not null default now()); insert into goose_db_version(version_id,is_applied) select generate_series(0,53),true`); err != nil {
		return err
	}
	return tx.Commit()
}

const rlsSQL = `select string_agg(c.relname,', ' order by c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='tenant_id' and not a.attisdropped)`

func checkRLS(ctx context.Context, conn *sql.DB) error {
	var s sql.NullString
	if err := conn.QueryRowContext(ctx, rlsSQL).Scan(&s); err != nil {
		return err
	}
	if s.Valid {
		return fmt.Errorf("RLS ausente: %s", s.String)
	}
	return nil
}
