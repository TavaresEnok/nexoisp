package db

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"nexoisp/api-go/internal/cryptox"
)

// Exercise the actual verifier, SQL and AES using only disposable fixtures.
func TestR06RestoreCloud(t *testing.T) {
	dsn := os.Getenv("NEXO_GO_TEST_DATABASE_OWNER_URL")
	if dsn == "" {
		if os.Getenv("PG_REQUIRED") == "1" {
			t.Fatal("PG_REQUIRED=1 exige NEXO_GO_TEST_DATABASE_OWNER_URL para nexo_test")
		}
		t.Skip("SKIP: PostgreSQL descartável ausente; não comprova restore Cloud")
	}
	cfg, err := pgx.ParseConfig(dsn)
	if err != nil || cfg.Database != "nexo_test" {
		t.Fatal("fixture exige URL válida exclusivamente para nexo_test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	c := stdlib.OpenDB(*cfg)
	defer c.Close()
	c.SetMaxOpenConns(1)
	var database, cryptoSchema string
	if err = c.QueryRowContext(ctx, "select current_database()").Scan(&database); err != nil || database != "nexo_test" {
		t.Fatal("conexão deve usar nexo_test")
	}
	// Use installed pgcrypto; never install extensions or touch restored tables.
	if err = c.QueryRowContext(ctx, `select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto'`).Scan(&cryptoSchema); err != nil {
		t.Fatal("fixture requer pgcrypto existente")
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, e := c.ExecContext(ctx, q, args...); e != nil {
			t.Fatal("SQL da fixture falhou")
		}
	}
	schema := pgx.Identifier{"r06_" + strings.ReplaceAll(uuid.NewString(), "-", "")}.Sanitize()
	exec("create schema " + schema)
	defer func() {
		if _, e := c.ExecContext(context.Background(), "drop schema "+schema+" cascade"); e != nil {
			t.Error("limpeza da fixture falhou")
		}
	}()
	exec("set search_path to " + schema + ", pg_catalog")
	// An isolated search_path makes absence independent of the real public schema.
	// Delegate RADIUS decryption to the existing pgcrypto implementation.
	cryptoNS := pgx.Identifier{cryptoSchema}.Sanitize()
	exec("create function " + schema + ".pgp_sym_decrypt(bytea,text) returns text language sql as 'select " + cryptoNS + ".pgp_sym_decrypt($1,$2)'")
	t.Setenv("NEXO_SECRET_KEY", base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{61}, 32)))
	t.Setenv("NEXO_SECRET_KEY_PREVIOUS", "")
	t.Setenv("NEXO_RADIUS_KEY", "r06-synthetic-radius-key")
	const plain = "r06-synthetic-token"
	const hookPlain = "r06-synthetic-webhook"
	token, err := cryptox.EncryptSecret(plain)
	if err != nil {
		t.Fatal("AES fixture falhou")
	}
	hook, err := cryptox.EncryptSecret(hookPlain)
	if err != nil {
		t.Fatal("AES fixture falhou")
	}
	fields := [][2]string{{"service_resources", "secret_enc"}, {"users", "mfa_secret_enc"}, {"webhook_endpoints", "secret_enc"}, {"notice_channels", "headers_enc"}, {"financial_connections", "webhook_secret_enc"}, {"financial_credential_versions", "secret_enc"}, {"acs_task_intents", "payload_enc"}}
	for _, field := range fields {
		exec("create table " + field[0] + " (" + field[1] + " text)")
		exec("insert into "+field[0]+" values ($1)", token)
	}
	var acsExists bool
	if err = c.QueryRowContext(ctx, "select to_regclass('public.acs_task_intents') is not null").Scan(&acsExists); err != nil {
		t.Fatal("consulta de compatibilidade ACS falhou")
	}
	legacyCount := 6
	if acsExists {
		legacyCount++
	}
	for _, table := range []string{"radius_account", "l2tp_peers"} {
		exec("create table " + table + " (secret_enc bytea)")
		exec("insert into "+table+" values ("+cryptoNS+".pgp_sym_encrypt($1,$2))", "r06-synthetic-radius", os.Getenv("NEXO_RADIUS_KEY"))
	}
	foreign := r06ForeignCipher(t, plain)
	for _, tc := range []struct {
		name, token, hook, column string
		absent, wantErr           bool
	}{
		{name: "both_valid", token: token, hook: hook},
		{name: "corrupt_token", token: "v1.corrupt", hook: hook, wantErr: true},
		{name: "corrupt_webhook", token: token, hook: "v1.corrupt", wantErr: true},
		{name: "wrong_key_token", token: foreign, hook: hook, wantErr: true},
		{name: "wrong_key_webhook", token: token, hook: foreign, wantErr: true},
		{name: "pre79_absent", absent: true},
		{name: "missing_token_column", column: "token_enc", wantErr: true},
		{name: "missing_webhook_column", column: "webhook_secret_enc", wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exec := func(q string, args ...any) {
				t.Helper()
				if _, e := c.ExecContext(ctx, q, args...); e != nil {
					t.Fatal("SQL da fixture falhou")
				}
			}
			exec("drop table if exists cloud_accounts")
			var before, after string
			if !tc.absent {
				exec("create table cloud_accounts (token_enc text, webhook_secret_enc text)")
				exec("insert into cloud_accounts values ($1,$2)", tc.token, tc.hook)
				if tc.column != "" {
					exec("alter table cloud_accounts drop column " + tc.column)
				}
				if e := c.QueryRowContext(ctx, "select row_to_json(c)::text from cloud_accounts c").Scan(&before); e != nil {
					t.Fatal("snapshot anterior falhou")
				}
			}
			var receipt bytes.Buffer
			e := verifyRestore(ctx, c, &receipt)
			if (e != nil) != tc.wantErr {
				t.Fatalf("erro esperado=%t, ocorreu=%t", tc.wantErr, e != nil)
			}
			output := receipt.String()
			if e != nil {
				output += e.Error()
				if receipt.Len() != 0 {
					t.Error("falha emitiu recibo de sucesso")
				}
			} else {
				wantCount := legacyCount
				if !tc.absent {
					wantCount += 2
				}
				if receipt.String() != fmt.Sprintf("verify-restore: %d segredos AES e 2 segredos RADIUS conferidos sem alteração\n", wantCount) {
					t.Error("contagem/recibo sanitizado incorreto")
				}
			}
			for _, secret := range []string{plain, hookPlain, token, hook, foreign, "r06-synthetic-radius", os.Getenv("NEXO_RADIUS_KEY")} {
				if strings.Contains(output, secret) {
					t.Error("saída expôs segredo sintético")
				}
			}
			if !tc.absent {
				if e := c.QueryRowContext(ctx, "select row_to_json(c)::text from cloud_accounts c").Scan(&after); e != nil || before != after {
					t.Error("verificação alterou dados Cloud")
				}
			}
		})
	}
}

// Produce the persisted AES-GCM format with an independent synthetic key,
// without resetting cryptox's process-wide key cache or rotating any secret.
func r06ForeignCipher(t *testing.T, plain string) string {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal("chave sintética falhou")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal("AES sintético falhou")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal("GCM sintético falhou")
	}
	iv := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(iv); err != nil {
		t.Fatal("nonce sintético falhou")
	}
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	cut := len(sealed) - gcm.Overhead()
	encode := base64.StdEncoding.EncodeToString
	return "v1." + encode(iv) + "." + encode(sealed[cut:]) + "." + encode(sealed[:cut])
}
