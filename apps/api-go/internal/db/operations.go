package db

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"nexoisp/api-go/internal/cryptox"
)

func provisionNetworkRoles(ctx context.Context, c *sql.DB) error {
	for _, role := range []struct{ name, env, options string }{{"nexo_radius", "NEXO_RADIUS_DB_PASSWORD", ""}, {"nexo_replica", "NEXO_REPLICA_PASSWORD", " replication"}} {
		pw := os.Getenv(role.env)
		if pw == "" {
			continue
		}
		var exists bool
		if e := c.QueryRowContext(ctx, "select exists(select 1 from pg_roles where rolname=$1)", role.name).Scan(&exists); e != nil {
			return e
		}
		verb := "create"
		if exists {
			verb = "alter"
		}
		if _, e := c.ExecContext(ctx, verb+" role "+role.name+" login nosuperuser nobypassrls nocreatedb nocreaterole"+role.options+" password "+quote(pw)); e != nil {
			return e
		}
	}
	return nil
}

// Operate runs administrative commands in a separate process with owner credentials.
func Operate(ctx context.Context, args []string, out io.Writer) error {
	url := os.Getenv("DATABASE_URL_OWNER")
	if url == "" {
		return fmt.Errorf("DATABASE_URL_OWNER obrigatória")
	}
	cfg, e := pgx.ParseConfig(url)
	if e != nil {
		return fmt.Errorf("DATABASE_URL_OWNER inválida")
	}
	if args[0] == "verify-restore" {
		database := os.Getenv("NEXO_RESTORE_DATABASE")
		if !regexp.MustCompile(`^nexo_restore_check_[0-9]+_[0-9]+$`).MatchString(database) {
			return fmt.Errorf("verify-restore exige banco temporário de restore-check")
		}
		cfg.Database = database
	}
	c := stdlib.OpenDB(*cfg)
	defer c.Close()
	if e = c.PingContext(ctx); e != nil {
		return e
	}
	switch args[0] {
	case "verify-restore":
		return verifyRestore(ctx, c, out)
	case "seed-demo":
		return seedDemo(ctx, c, out)
	case "create-operator":
		pw := os.Getenv("NEXO_NEW_PASSWORD")
		if len(args) != 3 || !strings.Contains(args[1], "@") || len(utf16.Encode([]rune(pw))) < 12 {
			return fmt.Errorf("uso: NEXO_NEW_PASSWORD=<12+ caracteres> nexo-db create-operator <email> <nome>")
		}
		hash, e := cryptox.HashPassword(pw)
		if e != nil {
			return e
		}
		tx, e := c.BeginTx(ctx, nil)
		if e != nil {
			return e
		}
		defer tx.Rollback()
		if _, e = tx.ExecContext(ctx, "select set_config('app.is_operator','on',true)"); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `insert into users(email,name,password_hash,role) values($1,$2,$3,'saas_operator') on conflict(lower(email)) do update set password_hash=excluded.password_hash,active=true`, args[1], args[2], hash); e != nil {
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
		fmt.Fprintln(out, "operador criado/atualizado")
		return nil
	case "rotate-secrets":
		return rotate(ctx, c, out)
	case "preflight":
		return preflight(ctx, c, out)
	}
	return fmt.Errorf("comando administrativo desconhecido")
}
func rotate(ctx context.Context, c *sql.DB, out io.Writer) error {
	if os.Getenv("NEXO_SECRET_KEY") == "" {
		return fmt.Errorf("NEXO_SECRET_KEY obrigatória")
	}
	tx, e := c.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, "select pg_advisory_xact_lock(7411003)"); e != nil {
		return e
	}
	done := 0
	for _, field := range [][2]string{{"service_resources", "secret_enc"}, {"users", "mfa_secret_enc"}, {"webhook_endpoints", "secret_enc"}, {"notice_channels", "headers_enc"}, {"financial_connections", "webhook_secret_enc"}, {"financial_credential_versions", "secret_enc"}, {"acs_task_intents", "payload_enc"}} {
		if field[0] == "acs_task_intents" {
			var exists bool
			if e := tx.QueryRowContext(ctx, "select to_regclass('public.acs_task_intents') is not null").Scan(&exists); e != nil {
				return e
			}
			if !exists {
				continue
			}
		}

		rows, e := tx.QueryContext(ctx, "select id,"+field[1]+" from "+field[0]+" where "+field[1]+" is not null for update")
		if e != nil {
			return e
		}
		values := [][2]string{}
		for rows.Next() {
			var id, v string
			if e = rows.Scan(&id, &v); e != nil {
				rows.Close()
				return e
			}
			values = append(values, [2]string{id, v})
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, row := range values {
			current, e := cryptox.UsesCurrentKey(row[1])
			if e != nil {
				return fmt.Errorf("segredo inválido em %s; rotação desfeita", field[0])
			}
			if current {
				continue
			}
			plain, e := cryptox.DecryptSecret(row[1])
			if e != nil {
				return fmt.Errorf("segredo indecifrável em %s; rotação desfeita", field[0])
			}
			encoded, e := cryptox.EncryptSecret(plain)
			if e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, "update "+field[0]+" set "+field[1]+"=$2 where id=$1", row[0], encoded); e != nil {
				return e
			}
			done++
		}
	}
	detail, _ := json.Marshal(map[string]int{"reencrypted": done})
	if _, e = tx.ExecContext(ctx, `insert into audit_events(actor_type,actor_id,action,detail) values('system','cli','secrets.rotate',$1)`, detail); e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	fmt.Fprintf(out, "segredos recifrados: %d; 0 pendente(s)\n", done)
	return nil
}

func preflight(ctx context.Context, c *sql.DB, out io.Writer) error {
	failures, warnings := 0, 0
	check := func(ok, warn bool, name string) {
		status := "ok"
		if !ok {
			if warn {
				status = "AVISO"
				warnings++
			} else {
				status = "FALHA"
				failures++
			}
		}
		fmt.Fprintf(out, "%s  %s\n", status, name)
	}
	check(os.Getenv("NEXO_DEMO_MODE") != "1", false, "modo demonstração desligado")
	check(os.Getenv("NEXO_REQUIRE_ADMIN_MFA") == "1", false, "MFA administrativo obrigatório")
	check(os.Getenv("NEXO_COOKIE_SECURE") == "1", false, "cookie seguro")
	key, e := base64.StdEncoding.DecodeString(os.Getenv("NEXO_SECRET_KEY"))
	check(e == nil && len(key) == 32, false, "chave AES de 32 bytes")
	_, e = cryptox.SigningPublicKey()
	check(os.Getenv("NEXO_OP_SIGNING_KEY") != "" && e == nil, false, "chave Ed25519")
	check(regexp.MustCompile(`^[A-Za-z0-9_-]{24,}$`).MatchString(os.Getenv("NEXO_RADIUS_KEY")), false, "chave RADIUS configurada")
	check(len(os.Getenv("NEXO_RADIUS_DB_PASSWORD")) >= 16, false, "senha do banco RADIUS configurada")
	check(os.Getenv("NEXO_VPN_PUBLIC_HOST") != "" || os.Getenv("NEXO_RADIUS_PUBLIC_HOST") != "", false, "endereço público de VPN/RADIUS")
	check(os.Getenv("NEXO_BACKUP_COPY") != "", true, "backup fora deste host")
	check(os.Getenv("NEXO_SECRET_KEY_PREVIOUS") == "", true, "nenhuma rotação pendente")
	check(os.Getenv("NEXO_ALERT_WEBHOOK_URL") != "", true, "webhook de alerta configurado")
	check(os.Getenv("NEXO_REPLICA_PASSWORD") != "", true, "réplica configurada")
	if acsRaw := strings.TrimSpace(os.Getenv("NEXO_ACS_URL")); acsRaw != "" {
		acsURL, acsErr := url.Parse(acsRaw)
		check(acsErr == nil && acsURL != nil && (acsURL.Scheme == "http" || acsURL.Scheme == "https") && acsURL.Host != "" && acsURL.User == nil, false, "URL interna do ACS válida")

		publicRaw := strings.TrimSpace(os.Getenv("NEXO_ACS_PUBLIC_URL"))
		publicURL, publicErr := url.Parse(publicRaw)
		publicValid := publicErr == nil && publicURL != nil && publicURL.Scheme == "https" && publicURL.Host != "" && publicURL.User == nil
		check(publicValid, false, "URL pública do ACS usa HTTPS")
		check(os.Getenv("NEXO_ACS_CWMP_AUTH_CONFIRMED") == "1", false, "autenticação CWMP por dispositivo confirmada pelo operador")
		uiSecret := os.Getenv("NEXO_ACS_UI_SECRET")
		check(len(uiSecret) >= 32 && uiSecret != "nao-usado-a-interface-nao-e-publicada", false, "segredo próprio da interface GenieACS")

		certPath := os.Getenv("NEXO_ACS_TLS_CERT")
		if certPath == "" {
			certPath = "/certs/acs.crt"
		}
		keyPath := os.Getenv("NEXO_ACS_TLS_KEY")
		if keyPath == "" {
			keyPath = "/certs/acs.key"
		}
		certPEM, certErr := os.ReadFile(certPath)
		keyPEM, keyErr := os.ReadFile(keyPath)
		pair, pairErr := tls.X509KeyPair(certPEM, keyPEM)
		certValid := certErr == nil && keyErr == nil && pairErr == nil && len(pair.Certificate) > 0
		if certValid {
			cert, parseErr := x509.ParseCertificate(pair.Certificate[0])
			certValid = parseErr == nil && time.Now().After(cert.NotBefore) && time.Now().Before(cert.NotAfter)
			if certValid && publicValid {
				certValid = cert.VerifyHostname(publicURL.Hostname()) == nil
			}
		}
		check(certValid, false, "certificado TLS do ACS válido, vigente e correspondente à URL pública")
	}
	root, e := Root()
	if e != nil {
		return e
	}
	if e = VerifyCopies(root); e != nil {
		return e
	}
	files, e := filepath.Glob(filepath.Join(root, "db/migrations/*.sql"))
	if e != nil {
		return e
	}
	for _, q := range []struct {
		sql, name string
		warn      bool
	}{
		{`select count(*) from users where email ilike '%.demo'`, "sem contas demo", false},
		{`select count(*) from devices where driver in ('demo','olt_demo')`, "sem equipamentos simulados", false},
		{`select count(*) from tenant_settings where gateway='demo'`, "sem gateway demo", false},
		{`select count(*) from operations where status='UNCERTAIN'`, "sem operações incertas", false},
		{`select count(*) from users where role in ('saas_operator','admin') and active and not mfa_enabled`, "MFA ativado para todos os administradores", true},
		{`select count(*) from agents where status='active' and (last_seen_at is null or last_seen_at<now()-interval '2 minutes')`, "agentes conectados", true},
		{`select count(*) from agents where status='active' and cert_fingerprint is null`, "certificados de agentes fixados", true},
		{`select count(*) from tenant_settings where auto_suspend`, "suspensão automática desligada", true},
		{`select count(*) from tenants where 'olt'=any(modules)`, "módulo OLT ainda bloqueado até homologação", true},
		{`select count(*) from tenants t where t.status='active' and not exists(select 1 from tenant_settings s where s.tenant_id=t.id and s.gateway<>'none')`, "provedores com gateway configurado", true},
		{`select count(*) from api_tokens where active and revoked_at is null and expires_at is null`, "tokens de API com validade", true},
		{`select count(*) from radius_nas r join devices d on d.id=r.device_id where d.vendor<>'mikrotik'`, "fabricantes de NAS homologados", true},
		{`select count(*) from radius_nas where last_packet_at is null or last_packet_at<now()-interval '1 day'`, "NAS enviando pacotes", true},
		{`select count(*) from vpn_peers where last_handshake_at is null or last_handshake_at<now()-interval '1 day'`, "túneis estabelecidos", true},
	} {
		var n int64
		if e = c.QueryRowContext(ctx, q.sql).Scan(&n); e != nil {
			return e
		}
		check(n == 0, q.warn, q.name)
	}
	var n int64
	for _, q := range []struct {
		sql, name string
		expected  int64
	}{
		{`select count(*) from users where role='saas_operator' and active`, "operador SaaS existente", 1},
		{`select count(*) from goose_db_version where is_applied and version_id>0`, "migrations Go aplicadas", int64(len(files))},
		{`select count(*) from pg_roles where rolname='nexo_radius' and rolcanlogin and not rolsuper and not rolbypassrls`, "papel RADIUS habilitado", 1},
		{`select count(*) from pg_roles where rolname in ('nexo_go','nexo_app') and not rolsuper and not rolbypassrls`, "papéis da aplicação sem privilégios", 2},
	} {
		if e = c.QueryRowContext(ctx, q.sql).Scan(&n); e != nil {
			return e
		}
		ok := n == q.expected
		if q.name == "operador SaaS existente" {
			ok = n > 0
		}
		check(ok, false, q.name)
	}
	if e = checkRLS(ctx, c); e != nil {
		check(false, false, "RLS ativo")
	} else {
		check(true, false, "RLS ativo")
	}
	if os.Getenv("NEXO_REPLICA_PASSWORD") != "" {
		if e = c.QueryRowContext(ctx, `select count(*) from pg_stat_replication where usename='nexo_replica' and state='streaming' and coalesce(replay_lag,interval '0')<=interval '1 minute'`).Scan(&n); e != nil {
			return e
		}
		check(n > 0, true, "réplica recebendo e sem atraso excessivo")
	}
	dir := os.Getenv("NEXO_AGENT_TLS_DIR")
	for _, name := range []string{"ca.crt", "server.crt", "server.key"} {
		b, e := os.ReadFile(filepath.Join(dir, name))
		valid := dir != "" && e == nil
		if valid && name != "server.key" {
			block, _ := pem.Decode(b)
			valid = block != nil
			if valid {
				cert, e := x509.ParseCertificate(block.Bytes)
				valid = e == nil
				if valid {
					valid = time.Now().After(cert.NotBefore) && time.Now().Before(cert.NotAfter)
				}
			}
		}
		check(valid, false, "certificado "+name)
	}
	if e = c.QueryRowContext(ctx, `select count(*) from information_schema.tables where table_schema='nexo_jobs' and table_name='river_job'`).Scan(&n); e != nil {
		return e
	}
	check(n == 1, false, "schema River instalado")
	fmt.Fprintf(out, "%d falha(s), %d aviso(s)\n", failures, warnings)
	if failures > 0 {
		return fmt.Errorf("preflight reprovado")
	}
	return nil
}
