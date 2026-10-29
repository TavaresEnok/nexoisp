package labtest

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestMarkSyntheticImportRowUpdatedRecusaDestinoAntesDeConectar(t *testing.T) {
	secret := "fixture-secret-9f3a"
	tenant := uuid.NewString()
	batch := uuid.NewString()
	ln := listenLocal(t)
	defer ln.Close()
	accepted := acceptSignal(ln)
	host := ln.Addr().String()
	cases := []string{
		"",
		"postgres://nexo_owner:" + secret + "@" + host + "/nexo",
		"postgres://nexo_app:" + secret + "@" + host + "/nexo_test",
		"postgres://nexo_go:" + secret + "@" + host + "/nexo_test",
		"postgres://nexo_owner:" + secret + "@" + host + "/nexo_test?dbname=outro",
		"host=" + host + " user=nexo_app password=" + secret + " dbname=nexo_test",
		"host=" + host + " user=nexo_owner password=" + secret + " dbname=nexo",
	}
	for _, raw := range cases {
		err := MarkSyntheticImportRowUpdated(context.Background(), raw, tenant, batch)
		if err == nil {
			t.Fatalf("aceitou destino %q", redact(raw, secret))
		}
		assertSecretHidden(t, err, raw, secret)
	}
	select {
	case <-accepted:
		t.Fatal("destino indevido abriu conexão antes da recusa")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestMarkSyntheticImportRowUpdatedNaoRevelaSegredoQuandoAConexaoFalha(t *testing.T) {
	secret := "fixture-secret-9f3a"
	ln := listenLocal(t)
	defer ln.Close()
	raw := "postgres://nexo_owner:" + secret + "@" + ln.Addr().String() + "/nexo_test"
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			conn.Close()
		}
	}()
	err := MarkSyntheticImportRowUpdated(context.Background(), raw, uuid.NewString(), uuid.NewString())
	if err == nil {
		t.Fatal("conexão interrompida foi aceita")
	}
	assertSecretHidden(t, err, raw, secret)
}

func TestMarkSyntheticImportRowUpdatedRecusaDestinoEfetivoAntesDaMutacao(t *testing.T) {
	secret := "nao-entra-na-url"
	raw := "postgres://nexo_owner:" + secret + "@127.0.0.1:1/nexo_test"
	for _, tc := range []struct{ database, session, current string }{
		{database: "nexo", session: labOwner, current: labOwner},
		{database: labDatabase, session: "nexo_app", current: "nexo_app"},
		{database: labDatabase, session: "nexo_go", current: "nexo_go"},
		{database: labDatabase, session: labOwner, current: "nexo_app"},
	} {
		fake := &fakeConn{database: tc.database, session: tc.session, current: tc.current}
		err := markSyntheticImportRowUpdated(context.Background(), raw, uuid.NewString(), uuid.NewString(), fake.dial)
		if err == nil {
			t.Fatalf("aceitou destino efetivo %s/%s", tc.database, tc.current)
		}
		if fake.began || fake.tx != nil {
			t.Fatal("destino efetivo indevido abriu transação")
		}
		assertSecretHidden(t, err, raw, secret)
	}
}

func TestMarkSyntheticImportRowUpdatedExigeUmaLinhaNaTransacao(t *testing.T) {
	raw := "postgres://nexo_owner:fixture-secret-9f3a@127.0.0.1:1/nexo_test"
	tenant := uuid.NewString()
	batch := uuid.NewString()
	cases := []struct {
		name     string
		batches  int
		rows     int
		affected int64
		wantErr  string
		commit   bool
		update   bool
	}{
		{name: "lote alheio", batches: 0, rows: 1, affected: 1, wantErr: "lote não pertence"},
		{name: "lote duplicado", batches: 2, rows: 1, affected: 1, wantErr: "lote não pertence"},
		{name: "sem linha", batches: 1, rows: 0, affected: 1, wantErr: "exatamente uma linha"},
		{name: "duas linhas", batches: 1, rows: 2, affected: 1, wantErr: "exatamente uma linha"},
		{name: "update largo", batches: 1, rows: 1, affected: 2, wantErr: "quantidade inesperada", update: true},
		{name: "uma linha", batches: 1, rows: 1, affected: 1, commit: true, update: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeConn{database: labDatabase, session: labOwner, current: labOwner, batches: tc.batches, rows: tc.rows, affected: tc.affected}
			err := markSyntheticImportRowUpdated(context.Background(), raw, tenant, batch, fake.dial)
			if tc.commit {
				if err != nil {
					t.Fatal(err)
				}
				if !fake.tx.committed || !fake.tx.rolled {
					t.Fatalf("commit=%v rollback=%v", fake.tx.committed, fake.tx.rolled)
				}
				assertOneRowUpdate(t, fake.tx, tenant, batch)
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatal(err)
			}
			if fake.tx == nil || fake.tx.committed {
				t.Fatal("transação confirmou destino recusado")
			}
			if tc.update {
				if len(fake.tx.execs) != 1 {
					t.Fatal(fake.tx.execs)
				}
				return
			}
			if len(fake.tx.execs) != 0 {
				t.Fatal("mutação ocorreu antes da recusa")
			}
		})
	}
}

func assertOneRowUpdate(t *testing.T, tx *fakeTx, tenant, batch string) {
	t.Helper()
	if len(tx.execs) != 1 || tx.execs[0] != updateSQL {
		t.Fatalf("exec=%q", tx.execs)
	}
	if len(tx.args) != 1 || tx.args[0][0] != tenant || tx.args[0][1] != batch {
		t.Fatalf("args=%v", tx.args)
	}
	if tx.queries[0] != batchSQL || tx.queryArgs[0][0] != batch || tx.queryArgs[0][1] != tenant {
		t.Fatalf("lote=%v %v", tx.queries, tx.queryArgs)
	}
	if tx.queries[1] != rowsSQL || tx.queryArgs[1][0] != tenant || tx.queryArgs[1][1] != batch {
		t.Fatalf("linhas=%v %v", tx.queries, tx.queryArgs)
	}
}

func listenLocal(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return ln
}

func acceptSignal(ln net.Listener) <-chan struct{} {
	ch := make(chan struct{}, 1)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			conn.Close()
			ch <- struct{}{}
		}
	}()
	return ch
}

func assertSecretHidden(t *testing.T, err error, raw, secret string) {
	t.Helper()
	msg := chain(err)
	if strings.Contains(msg, secret) || (raw != "" && strings.Contains(msg, raw)) || strings.Contains(msg, "postgres://") {
		t.Fatalf("erro revela url ou senha: %s", redact(msg, secret))
	}
}

func redact(value, secret string) string {
	return strings.ReplaceAll(value, secret, "[segredo]")
}

type fakeConn struct {
	database, session, current string
	batches, rows              int
	affected                   int64
	began                      bool
	tx                         *fakeTx
}

func (f *fakeConn) dial(context.Context, *pgx.ConnConfig) (ownerConn, error) { return f, nil }

func (f *fakeConn) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if sql != identitySQL {
		return errRow(errors.New("consulta fora da transação"))
	}
	return stringsRow(f.database, f.session, f.current)
}

func (f *fakeConn) Begin(context.Context) (ownerTx, error) {
	f.began = true
	f.tx = &fakeTx{batches: f.batches, rows: f.rows, affected: f.affected}
	return f.tx, nil
}

func (f *fakeConn) Close(context.Context) error { return nil }

type fakeTx struct {
	batches, rows int
	affected      int64
	execs         []string
	args          [][]any
	queries       []string
	queryArgs     [][]any
	committed     bool
	rolled        bool
}

func (f *fakeTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	f.queries = append(f.queries, sql)
	f.queryArgs = append(f.queryArgs, append([]any(nil), args...))
	switch sql {
	case batchSQL:
		if len(args) != 2 {
			return errRow(errors.New("lote sem tenant"))
		}
		return intRow(f.batches)
	case rowsSQL:
		if len(args) != 2 {
			return errRow(errors.New("linhas sem tenant"))
		}
		return intRow(f.rows)
	default:
		return errRow(errors.New("consulta inesperada na transação"))
	}
}

func (f *fakeTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	f.execs = append(f.execs, sql)
	f.args = append(f.args, append([]any(nil), args...))
	if sql != updateSQL {
		return pgconn.CommandTag{}, errors.New("executor genérico recusado")
	}
	return pgconn.NewCommandTag("UPDATE " + itoa(f.affected)), nil
}

func (f *fakeTx) Commit(context.Context) error {
	f.committed = true
	return nil
}

func (f *fakeTx) Rollback(context.Context) error {
	f.rolled = true
	return nil
}

type staticRow struct {
	vals []any
	err  error
}

func (r staticRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.vals) {
		return errors.New("colunas divergentes")
	}
	for i := range dest {
		switch d := dest[i].(type) {
		case *string:
			s, ok := r.vals[i].(string)
			if !ok {
				return errors.New("coluna texto divergente")
			}
			*d = s
		case *int:
			n, ok := r.vals[i].(int)
			if !ok {
				return errors.New("coluna inteira divergente")
			}
			*d = n
		default:
			return errors.New("destino de scan inesperado")
		}
	}
	return nil
}

func stringsRow(values ...string) pgx.Row {
	vals := make([]any, len(values))
	for i := range values {
		vals[i] = values[i]
	}
	return staticRow{vals: vals}
}

func intRow(n int) pgx.Row { return staticRow{vals: []any{n}} }

func errRow(err error) pgx.Row { return staticRow{err: err} }

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
