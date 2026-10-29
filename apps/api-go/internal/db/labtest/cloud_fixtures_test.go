package labtest

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestCloudFixtureRecusaDestinoAntesDeConectar(t *testing.T) {
	secret := "fixture-secret-9f3a"
	tenant := uuid.NewString()
	account := uuid.NewString()
	maintenance := uuid.NewString()
	exclusiveID, slug := exclusiveFixtureID(t)
	valid := "postgres://nexo_owner:" + secret + "@127.0.0.1:1/nexo_test"
	cases := []struct {
		name string
		run  func(func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error
		want string
	}{
		{
			name: "gate url vazia",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				return deleteOwnCloudFixture(context.Background(), "  ", valid, FamilyCloudGate, tenant, account, "", dial)
			},
			want: "NEXO_GO_TEST_DATABASE_OWNER_URL ausente",
		},
		{
			name: "gate igual ao runtime",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				return deleteOwnCloudFixture(context.Background(), valid, valid, FamilyCloudGate, tenant, account, "", dial)
			},
			want: "sessão de runtime",
		},
		{
			name: "gate papel de runtime",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				raw := "postgres://nexo_go:" + secret + "@127.0.0.1:1/nexo_test"
				return deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, account, "", dial)
			},
			want: "nexo_owner em nexo_test",
		},
		{
			name: "gate banco errado",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				raw := "postgres://nexo_owner:" + secret + "@127.0.0.1:1/nexo"
				return deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, account, "", dial)
			},
			want: "nexo_owner em nexo_test",
		},
		{
			name: "gate host remoto",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				raw := "postgres://nexo_owner:" + secret + "@192.0.2.1:1/nexo_test"
				return deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, account, "", dial)
			},
			want: "nexo_owner em nexo_test",
		},
		{
			name: "gate socket nao é loopback",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				raw := "host=/var/run/postgresql user=nexo_owner password=" + secret + " dbname=nexo_test"
				return deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, account, "", dial)
			},
			want: "nexo_owner em nexo_test",
		},
		{
			name: "journal igual ao runtime",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				return insertExclusiveJournalTenant(context.Background(), valid, valid, exclusiveID, slug, dial)
			},
			want: "sessão de produto",
		},
		{
			name: "journal host remoto",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				raw := "postgres://nexo_app:" + secret + "@192.0.2.1:1/nexo_test"
				return detachExclusiveJournalTenant(context.Background(), raw, "", exclusiveID, slug, dial)
			},
			want: "papel nexo_owner",
		},
		{
			name: "família desconhecida",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				return deleteOwnCloudFixture(context.Background(), valid, "", FixtureFamily("drop table"), tenant, account, maintenance, dial)
			},
			want: "família de fixture recusada",
		},
		{
			name: "ids vazios nao conectam",
			run: func(dial func(context.Context, *pgx.ConnConfig) (ownerConn, error)) error {
				return deleteOwnCloudFixture(context.Background(), valid, "", FamilyCloudGate, tenant, "", "", dial)
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			spy := &dialSpy{}
			err := tc.run(spy.dial)
			if spy.called {
				t.Fatal("destino indevido abriu conexão")
			}
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatal(err)
			}
			assertSecretHidden(t, err, valid, secret)
		})
	}
}

func TestCloudFixtureRecusaIdentidadeAntesDaMutacao(t *testing.T) {
	secret := "nao-entra-na-url"
	raw := "postgres://nexo_owner:" + secret + "@127.0.0.1:1/nexo_test"
	tenant := uuid.NewString()
	account := uuid.NewString()
	exclusiveID, slug := exclusiveFixtureID(t)
	for _, tc := range []struct{ database, session, current string }{
		{database: "nexo", session: labOwner, current: labOwner},
		{database: labDatabase, session: "nexo_go", current: "nexo_go"},
		{database: labDatabase, session: "nexo_app", current: "nexo_app"},
		{database: labDatabase, session: labOwner, current: "nexo_app"},
	} {
		fake := &cloudConn{database: tc.database, session: tc.session, current: tc.current}
		err := deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, account, "", fake.dial)
		if err == nil || !strings.Contains(err.Error(), "destino efetivo recusado") {
			t.Fatal(err)
		}
		if fake.began {
			t.Fatal("destino efetivo indevido abriu transação")
		}
		assertSecretHidden(t, err, raw, secret)

		fake = &cloudConn{database: tc.database, session: tc.session, current: tc.current}
		err = insertExclusiveJournalTenant(context.Background(), raw, "", exclusiveID, slug, fake.dial)
		if err == nil || !strings.Contains(err.Error(), "papel de preparação recusado") {
			t.Fatal(err)
		}
		if fake.began {
			t.Fatal("preparação indevida abriu transação")
		}
		assertSecretHidden(t, err, raw, secret)
	}
}

func TestCloudFixtureRestringeIDsMarcadoresERedigeSegredo(t *testing.T) {
	raw := "postgres://nexo_owner:fixture-secret-9f3a@127.0.0.1:1/nexo_test"
	tenant := uuid.NewString()
	account := uuid.NewString()
	maintenance := uuid.NewString()
	exclusiveID, slug := exclusiveFixtureID(t)

	t.Run("id alheio", func(t *testing.T) {
		spy := &dialSpy{}
		err := deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, "nao-e-uuid", "", spy.dial)
		if err == nil || !strings.Contains(err.Error(), "conta da fixture inválida") || spy.called {
			t.Fatal(err)
		}
		err = deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudJournal, "nao-e-uuid", "", maintenance, spy.dial)
		if err == nil || !strings.Contains(err.Error(), "tenant da limpeza inválido") || spy.called {
			t.Fatal(err)
		}
		err = detachExclusiveJournalTenant(context.Background(), raw, "", uuid.NewString(), "cj123456789012", spy.dial)
		if err == nil || !strings.Contains(err.Error(), "escopo exclusivo inválido") || spy.called {
			t.Fatal(err)
		}
	})

	t.Run("uma conta e um aviso", func(t *testing.T) {
		fake := readyCloud()
		err := deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, account, maintenance, fake.dial)
		if err != nil {
			t.Fatal(err)
		}
		if !fake.tx.committed || !fake.tx.rolled {
			t.Fatalf("commit=%v rollback=%v", fake.tx.committed, fake.tx.rolled)
		}
		assertCloudExec(t, fake.tx, []string{tenantConfigSQL, gateAccountSQL, gateMaintenanceSQL})
		if fake.tx.args[0][0] != tenant || fake.tx.args[1][0] != account || fake.tx.args[1][1] != tenant || fake.tx.args[2][0] != maintenance {
			t.Fatalf("args=%v", fake.tx.args)
		}
		assertFixtureSQL(t, fake.tx.execs)
	})

	t.Run("rowcount da conta", func(t *testing.T) {
		fake := readyCloud()
		fake.accountN = 2
		err := deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudJournal, tenant, account, maintenance, fake.dial)
		if err == nil || !strings.Contains(err.Error(), "limpeza removeu 2 cloud_accounts") {
			t.Fatal(err)
		}
		if fake.tx.committed || len(fake.tx.execs) != 2 {
			t.Fatalf("execs=%v commit=%v", fake.tx.execs, fake.tx.committed)
		}
		assertFixtureSQL(t, fake.tx.execs)
	})

	t.Run("rowcount do aviso", func(t *testing.T) {
		fake := readyCloud()
		fake.maintenanceN = 0
		err := deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, "", maintenance, fake.dial)
		if err == nil || !strings.Contains(err.Error(), "exatamente o aviso") {
			t.Fatal(err)
		}
		if fake.tx.committed {
			t.Fatal("rowcount inesperado confirmou")
		}
	})

	t.Run("tenant exclusivo", func(t *testing.T) {
		fake := readyCloud()
		err := insertExclusiveJournalTenant(context.Background(), raw, "", exclusiveID, slug, fake.dial)
		if err != nil {
			t.Fatal(err)
		}
		assertCloudExec(t, fake.tx, []string{exclusiveInsertSQL})
		if fake.tx.args[0][0] != exclusiveID || fake.tx.args[0][1] != slug {
			t.Fatalf("args=%v", fake.tx.args)
		}
		if len(fake.tx.queries) != 1 || fake.tx.queries[0] != exclusiveCheckSQL || fake.tx.queryArgs[0][0] != exclusiveID {
			t.Fatalf("check=%v %v", fake.tx.queries, fake.tx.queryArgs)
		}
		assertFixtureSQL(t, append(fake.tx.execs, fake.tx.queries...))

		fake = readyCloud()
		fake.cells = 0
		err = insertExclusiveJournalTenant(context.Background(), raw, "", exclusiveID, slug, fake.dial)
		if err == nil || !strings.Contains(err.Error(), "escopo exclusivo inconsistente") || fake.tx.committed {
			t.Fatal(err)
		}

		fake = readyCloud()
		fake.detachN = 1
		err = detachExclusiveJournalTenant(context.Background(), raw, "", exclusiveID, slug, fake.dial)
		if err != nil {
			t.Fatal(err)
		}
		assertCloudExec(t, fake.tx, []string{exclusiveDetachSQL})
		if fake.tx.args[0][0] != exclusiveID || fake.tx.args[0][1] != slug {
			t.Fatalf("args=%v", fake.tx.args)
		}
		for _, sqlText := range fake.tx.execs {
			if strings.Contains(strings.ToLower(sqlText), "delete from tenants") {
				t.Fatal(sqlText)
			}
		}
	})

	t.Run("erro visivel sem segredo", func(t *testing.T) {
		spy := &dialSpy{err: errors.New("falha visivel do laboratorio")}
		err := deleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, account, "", spy.dial)
		if err == nil || !strings.Contains(err.Error(), "falha visivel do laboratorio") {
			t.Fatal(err)
		}
		spy = &dialSpy{err: errors.New("falha visivel do laboratorio")}
		err = insertExclusiveJournalTenant(context.Background(), raw, "", exclusiveID, slug, spy.dial)
		if err == nil || !strings.Contains(err.Error(), "conexão de preparação recusada") || !strings.Contains(err.Error(), "falha visivel do laboratorio") {
			t.Fatal(err)
		}
	})

	t.Run("conexao nao revela senha", func(t *testing.T) {
		secret := "fixture-secret-9f3a"
		ln := listenLocal(t)
		defer ln.Close()
		accepted := acceptSignal(ln)
		raw := "postgres://nexo_owner:" + secret + "@" + ln.Addr().String() + "/nexo_test"
		err := DeleteOwnCloudFixture(context.Background(), raw, "", FamilyCloudGate, tenant, account, "")
		if err == nil {
			t.Fatal("conexão interrompida foi aceita")
		}
		assertSecretHidden(t, err, raw, secret)
		select {
		case <-accepted:
		case <-time.After(2 * time.Second):
			t.Fatal("a URL válida não tentou conectar")
		}
		ln2 := listenLocal(t)
		defer ln2.Close()
		go func() {
			conn, err := ln2.Accept()
			if err == nil {
				conn.Close()
			}
		}()
		raw = "postgres://nexo_owner:" + secret + "@" + ln2.Addr().String() + "/nexo_test"
		err = InsertExclusiveJournalTenant(context.Background(), raw, "", exclusiveID, slug)
		if err == nil {
			t.Fatal("conexão interrompida foi aceita")
		}
		assertSecretHidden(t, err, raw, secret)
	})
}

func exclusiveFixtureID(t *testing.T) (string, string) {
	t.Helper()
	tail := strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	id := "ffffffff-ffff-4fff-bfff-" + tail
	if _, err := uuid.Parse(id); err != nil {
		t.Fatal(err)
	}
	return id, "cj" + tail
}

func readyCloud() *cloudConn {
	return &cloudConn{
		database: labDatabase, session: labOwner, current: labOwner,
		accountN: 1, maintenanceN: 1, detachN: 1, cells: 1,
	}
}

func assertCloudExec(t *testing.T, tx *cloudTx, want []string) {
	t.Helper()
	if len(tx.execs) != len(want) {
		t.Fatalf("execs=%v", tx.execs)
	}
	for i := range want {
		if tx.execs[i] != want[i] {
			t.Fatalf("execs=%v", tx.execs)
		}
	}
}

func assertFixtureSQL(t *testing.T, sqls []string) {
	t.Helper()
	for _, sqlText := range sqls {
		lower := strings.ToLower(sqlText)
		for _, banned := range []string{"payments", "token_enc", "webhook_secret", "phone_number", "contact_value", "body_hash"} {
			if strings.Contains(lower, banned) {
				t.Fatalf("sql alcança dado fora da fixture: %s", sqlText)
			}
		}
	}
}

type dialSpy struct {
	called bool
	err    error
}

func (d *dialSpy) dial(context.Context, *pgx.ConnConfig) (ownerConn, error) {
	d.called = true
	if d.err != nil {
		return nil, d.err
	}
	return nil, errors.New("dial sem conexão")
}

type cloudConn struct {
	database, session, current string
	accountN, maintenanceN     int64
	detachN                    int64
	cells, queued              int
	began                      bool
	tx                         *cloudTx
}

func (f *cloudConn) dial(context.Context, *pgx.ConnConfig) (ownerConn, error) { return f, nil }

func (f *cloudConn) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if sql != identitySQL {
		return errRow(errors.New("consulta fora da transação"))
	}
	return stringsRow(f.database, f.session, f.current)
}

func (f *cloudConn) Begin(context.Context) (ownerTx, error) {
	f.began = true
	f.tx = &cloudTx{accountN: f.accountN, maintenanceN: f.maintenanceN, detachN: f.detachN, cells: f.cells, queued: f.queued}
	return f.tx, nil
}

func (f *cloudConn) Close(context.Context) error { return nil }

type cloudTx struct {
	accountN, maintenanceN, detachN int64
	cells, queued                   int
	execs                           []string
	args                            [][]any
	queries                         []string
	queryArgs                       [][]any
	committed, rolled               bool
}

func (f *cloudTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	f.queries = append(f.queries, sql)
	f.queryArgs = append(f.queryArgs, append([]any(nil), args...))
	if sql != exclusiveCheckSQL {
		return errRow(errors.New("consulta inesperada na transação"))
	}
	return staticRow{vals: []any{f.cells, f.queued}}
}

func (f *cloudTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execs = append(f.execs, sql)
	f.args = append(f.args, append([]any(nil), args...))
	lower := strings.ToLower(sql)
	if strings.Contains(lower, "payments") || strings.Contains(lower, "token_enc") || strings.Contains(lower, "delete from tenants") {
		return pgconn.CommandTag{}, errors.New("executor genérico recusado")
	}
	switch sql {
	case tenantConfigSQL:
		return pgconn.NewCommandTag("SELECT 1"), nil
	case gateAccountSQL, journalAccountSQL:
		return pgconn.NewCommandTag("DELETE " + itoa(f.accountN)), nil
	case gateMaintenanceSQL, journalMaintenanceSQL:
		return pgconn.NewCommandTag("DELETE " + itoa(f.maintenanceN)), nil
	case exclusiveInsertSQL:
		return pgconn.NewCommandTag("INSERT 1"), nil
	case exclusiveDetachSQL:
		return pgconn.NewCommandTag("DELETE " + itoa(f.detachN)), nil
	default:
		return pgconn.CommandTag{}, errors.New("executor genérico recusado")
	}
}

func (f *cloudTx) Commit(context.Context) error {
	f.committed = true
	return nil
}

func (f *cloudTx) Rollback(context.Context) error {
	f.rolled = true
	return nil
}
