package escrita

import (
	"context"
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
	"testing"

	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/tenancy"

	"github.com/google/uuid"
)

func TestImportFixedIPAddress(t *testing.T) {
	for in, want := range map[string]string{"200.0.113.10": "200.0.113.10", " 200.0.113.10/32 ": "200.0.113.10"} {
		if got, ok := importFixedIPAddress(in); !ok || got != want {
			t.Fatalf("%q => %q %v", in, got, ok)
		}
	}
	for _, in := range []string{"", "300.1.1.1", "200.0.113.0/24", "2001:db8::1", "::ffff:200.0.113.10", "fe80::1%eth0", "abc"} {
		if got, ok := importFixedIPAddress(in); ok {
			t.Fatalf("%q aceito como %q", in, got)
		}
	}
}

type fixedIPFix struct {
	source, plan, base string
	pool               string
}

func (f fixedIPFix) ip(host int) string { return fmt.Sprintf("%s.%d", f.base, host) }

func (f fixedIPFix) row(ext, ip string) string {
	return fmt.Sprintf("%s,Assinante %s,%s,10,%s", ext, ext, f.plan, ip)
}

func TestImportFixedIP(t *testing.T) {
	d, scope := openImportLockDB(t)
	fix := newFixedIPFix(t, d, scope)
	allocations := func(ip string) int {
		return countWhere(t, d, scope, `select count(*) from ip_allocations where address = $1::inet`, ip)
	}
	audits := func(ip string) int {
		return countWhere(t, d, scope, `select count(*) from audit_events where action = 'ipam.allocate' and detail->>'address' = $1 and detail->>'import_source' = $2`, ip, fix.source)
	}

	t.Run("allocates inside an existing pool without network operations", func(t *testing.T) {
		out := runFixedIPImport(t, d, scope, fix, true, nil, fix.row("a1", fix.ip(2)+"/32"))
		row := onlyRow(t, out)
		if row["status"] != "created" || importTotals(t, out)["fixed_ips_allocated"] != float64(1) {
			t.Fatalf("linha %#v totais %#v", row, importTotals(t, out))
		}
		n := countWhere(t, d, scope, `select count(*) from ip_allocations a join contracts k on k.id = a.contract_id
where a.address = $1::inet and k.external_source = $2 and k.external_id = 'a1' and a.description = $3`, fix.ip(2), fix.source, "importação "+fix.source+"/a1")
		if n != 1 || audits(fix.ip(2)) != 1 {
			t.Fatalf("alocação %d auditoria %d", n, audits(fix.ip(2)))
		}
		if ops := countWhere(t, d, scope, `select count(*) from operations o join service_resources r on r.id = o.resource_id join contracts k on k.id = r.contract_id where k.external_source = $1`, fix.source); ops != 0 {
			t.Fatalf("importação gerou %d operações de rede", ops)
		}
	})

	t.Run("identical reimport is idempotent", func(t *testing.T) {
		out := runFixedIPImport(t, d, scope, fix, true, nil, fix.row("a1", fix.ip(2)))
		if importTotals(t, out)["fixed_ips_allocated"] != float64(0) || onlyRow(t, out)["status"] == "error" {
			t.Fatalf("reimportação %#v", out["sample"])
		}
		if allocations(fix.ip(2)) != 1 || audits(fix.ip(2)) != 1 {
			t.Fatal("reimportação duplicou alocação ou auditoria")
		}
	})

	t.Run("rejections keep the row out", func(t *testing.T) {
		if e := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
			return tx.Exec(context.Background(), `insert into ip_allocations (tenant_id, pool_id, address, description) values ($1, $2, $3::inet, 'reserva do teste')`, scope.TenantID, fix.pool, fix.ip(9))
		}); e != nil {
			t.Fatal(e)
		}
		cases := []struct{ ext, ip, want string }{
			{"r1", "300.1.1.1", "ip_fixo inválido"},
			{"r2", "2001:db8::10", "ip_fixo inválido"},
			{"r3", "198.51.100.77", "não pertence a nenhum bloco"},
			{"r4", fix.ip(2), "já está alocado a outro contrato"},
			{"r5", fix.ip(9), "reservado no IPAM sem contrato"},
			{"a1", fix.ip(3), "já tem o IPv4 fixo " + fix.ip(2)},
		}
		for _, c := range cases {
			out := runFixedIPImport(t, d, scope, fix, true, nil, fix.row(c.ext, c.ip))
			row := onlyRow(t, out)
			if row["status"] != "error" || !strings.Contains(messageText(t, row), c.want) {
				t.Fatalf("%s/%s: %#v", c.ext, c.ip, row)
			}
		}
		if n := countWhere(t, d, scope, `select count(*) from subscribers where external_source = $1 and external_id like 'r%'`, fix.source); n != 0 {
			t.Fatalf("%d assinantes de linhas rejeitadas persistiram", n)
		}
		if allocations(fix.ip(3)) != 0 || allocations(fix.ip(2)) != 1 {
			t.Fatal("rejeição alterou alocações")
		}
	})

	t.Run("preview reports without writing", func(t *testing.T) {
		out := runFixedIPImport(t, d, scope, fix, false, nil, fix.row("p1", fix.ip(4)))
		if onlyRow(t, out)["status"] != "created" || importTotals(t, out)["fixed_ips_allocated"] != float64(1) {
			t.Fatalf("prévia %#v", out["sample"])
		}
		if allocations(fix.ip(4)) != 0 || audits(fix.ip(4)) != 0 {
			t.Fatal("prévia gravou alocação")
		}
	})

	t.Run("requires the IPAM permission", func(t *testing.T) {
		out := runFixedIPImport(t, d, scope, fix, true, []string{}, fix.row("n1", fix.ip(5)))
		row := onlyRow(t, out)
		if row["status"] != "error" || !strings.Contains(messageText(t, row), "permissão insuficiente") || allocations(fix.ip(5)) != 0 {
			t.Fatalf("sem permissão %#v", row)
		}
	})

	t.Run("another tenant pool is invisible", func(t *testing.T) {
		other := otherTenant(t, d, scope)
		if other == "" {
			t.Skip("laboratório com um único provedor: isolamento entre provedores não exercitado aqui")
		}
		otherScope := tenancy.Scope{TenantID: other}
		base := fmt.Sprintf("198.19.%d", rand.IntN(250)+1)
		if e := d.WithScope(context.Background(), otherScope, func(tx *db.Tx) error {
			return tx.Exec(context.Background(), `insert into ip_pools (tenant_id, name, cidr, kind) values ($1, $2, $3::cidr, 'public')`, other, "fixo-"+fix.source, base+".0/28")
		}); e != nil {
			t.Fatal(e)
		}
		out := runFixedIPImport(t, d, scope, fix, true, nil, fix.row("t1", base+".2"))
		row := onlyRow(t, out)
		if row["status"] != "error" || !strings.Contains(messageText(t, row), "não pertence a nenhum bloco") {
			t.Fatalf("pool de outro provedor usado: %#v", row)
		}
	})

	t.Run("concurrent imports allocate an address once", func(t *testing.T) {
		var wg sync.WaitGroup
		outs := make([]map[string]any, 2)
		errs := make([]error, 2)
		for i := range outs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				v, err := fixedIPImport(d, scope, fix, true, nil, fix.row(fmt.Sprintf("c%d", i), fix.ip(6)))
				errs[i] = err
				outs[i], _ = v.(map[string]any)
			}()
		}
		wg.Wait()
		created := 0
		for i := range outs {
			if errs[i] != nil {
				t.Fatal(errs[i])
			}
			if onlyRow(t, outs[i])["status"] == "created" {
				created++
			}
		}
		if created != 1 || allocations(fix.ip(6)) != 1 {
			t.Fatalf("criadas %d alocações %d", created, allocations(fix.ip(6)))
		}
	})
}

func newFixedIPFix(t *testing.T, d *db.DB, scope tenancy.Scope) fixedIPFix {
	t.Helper()
	fix := fixedIPFix{source: "ip" + strings.ReplaceAll(uuid.NewString(), "-", ""), base: fmt.Sprintf("198.18.%d", rand.IntN(250)+1)}
	err := d.WithScope(context.Background(), scope, func(tx *db.Tx) error {
		ctx := context.Background()
		if err := tx.QueryRow(ctx, `select name from plans where active order by name limit 1`).Scan(&fix.plan); err != nil {
			return fmt.Errorf("provedor sem plano ativo para a pré-condição: %w", err)
		}
		return tx.QueryRow(ctx, `insert into ip_pools (tenant_id, name, cidr, kind) values ($1, $2, $3::cidr, 'public') returning id::text`, scope.TenantID, "fixo-"+fix.source, fix.base+".0/28").Scan(&fix.pool)
	})
	if err != nil {
		t.Fatal(err)
	}
	return fix
}

func otherTenant(t *testing.T, d *db.DB, scope tenancy.Scope) string {
	t.Helper()
	var other string
	err := d.WithScope(context.Background(), tenancy.Scope{}, func(tx *db.Tx) error {
		rows, err := tx.Objects(context.Background(), `select tenant_id::text as id from nexo_go_directory() where tenant_id <> $1::uuid order by tenant_id limit 1`, scope.TenantID)
		if err == nil && len(rows) > 0 {
			other = uuid.MustParse(fmt.Sprint(rows[0].Get("id"))).String()
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return other
}

func fixedIPImport(d *db.DB, scope tenancy.Scope, fix fixedIPFix, apply bool, permissions []string, lines ...string) (any, error) {
	if permissions == nil {
		permissions = []string{"network:write"}
	}
	modules := auth.Modules("/api/ipam/pools/:id/allocations")
	ctx := auth.With(context.Background(), &auth.Ctx{UserID: uuid.NewString(), TenantID: scope.TenantID, Role: "admin", Scope: scope, Permissions: permissions, Modules: modules})
	csv := "id_externo,nome,plano,vencimento_dia,ip_fixo\n" + strings.Join(lines, "\n") + "\n"
	return Service{DB: d}.importCSV(ctx, map[string]any{"kind": "subscribers", "source": fix.source, "filename": "assinantes.csv", "csv": csv}, apply)
}

func runFixedIPImport(t *testing.T, d *db.DB, scope tenancy.Scope, fix fixedIPFix, apply bool, permissions []string, lines ...string) map[string]any {
	t.Helper()
	v, err := fixedIPImport(d, scope, fix, apply, permissions, lines...)
	if err != nil {
		t.Fatal(err)
	}
	return importMap(t, v)
}

func onlyRow(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	sample := importSample(t, out)
	if len(sample) != 1 {
		t.Fatalf("amostra %#v", sample)
	}
	return sample[0]
}
