package db

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"nexoisp/api-go/internal/cryptox"
	"os"
)

// seedDemo is an explicit development command, never called by the HTTP process.
func seedDemo(ctx context.Context, c *sql.DB, out io.Writer) error {
	if os.Getenv("NEXO_DEMO_MODE") != "1" || os.Getenv("NODE_ENV") == "production" {
		return fmt.Errorf("seed-demo exige NEXO_DEMO_MODE=1 fora de produção")
	}
	tx, e := c.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, "select pg_advisory_xact_lock(7411004)"); e != nil {
		return e
	}
	var exists bool
	if e = tx.QueryRowContext(ctx, `select exists(select 1 from users where email='operador@nexoisp.demo')`).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		hash, e := cryptox.HashPassword("demo1234")
		if e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `insert into users(email,name,password_hash,role) values('operador@nexoisp.demo','Operador SaaS (demo)',$1,'saas_operator')`, hash); e != nil {
			return e
		}
		n := 1
		for _, slug := range []string{"alfa", "beta"} {
			var tenant string
			if e = tx.QueryRowContext(ctx, `insert into tenants(name,slug,modules) values($1,$2,'{olt,ipam,field,ftth,crm,noc,notices}') returning id`, "Provedor "+slug+" (demo)", slug).Scan(&tenant); e != nil {
				return e
			}
			for _, r := range [][2]string{{"admin", "admin"}, {"attendant", "atendimento"}, {"finance", "financeiro"}, {"noc", "noc"}} {
				if _, e = tx.ExecContext(ctx, `insert into users(tenant_id,email,name,password_hash,role) values($1,$2,$3,$4,$5)`, tenant, r[1]+"@"+slug+".demo", r[1]+" "+slug, hash, r[0]); e != nil {
					return e
				}
			}
			versions := []string{}
			for _, p := range []struct {
				name            string
				price, down, up int
			}{{"Fibra 200", 7990, 200000, 100000}, {"Fibra 500", 9990, 500000, 250000}, {"Fibra 1 Giga", 14990, 1000000, 500000}} {
				var plan, version string
				if e = tx.QueryRowContext(ctx, `insert into plans(tenant_id,name) values($1,$2) returning id`, tenant, p.name).Scan(&plan); e != nil {
					return e
				}
				if e = tx.QueryRowContext(ctx, `insert into plan_versions(tenant_id,plan_id,version,price_cents,down_kbps,up_kbps,profile_name) values($1,$2,1,$3,$4,$5,$6) returning id`, tenant, plan, p.price, p.down, p.up, fmt.Sprintf("plano-%dm", p.down/1000)).Scan(&version); e != nil {
					return e
				}
				versions = append(versions, version)
			}
			for i, name := range []string{"Ana Souza", "Bruno Lima", "Carla Mendes", "Diego Rocha", "Elaine Castro", "Fábio Nunes", "Gabriela Reis", "Heitor Alves"} {
				var sub string
				if e = tx.QueryRowContext(ctx, `insert into subscribers(tenant_id,name,document,email,phone,address_street,address_number,address_city,address_state) values($1,$2,$3,$4,$5,'Rua das Acácias',$6,'Cidade Demo','SP') returning id`, tenant, name+" ("+slug+")", fakeCPF(n), fmt.Sprintf("cliente%d@exemplo.demo", n), fmt.Sprintf("1199000%d", 1000+n), fmt.Sprint(n*10)).Scan(&sub); e != nil {
					return e
				}
				if i < 6 {
					var contract string
					if e = tx.QueryRowContext(ctx, `insert into contracts(tenant_id,subscriber_id,plan_version_id,due_day) values($1,$2,$3,$4) returning id`, tenant, sub, versions[i%3], []int{5, 10, 15, 20}[i%4]).Scan(&contract); e != nil {
						return e
					}
					if _, e = tx.ExecContext(ctx, `insert into contract_history(tenant_id,contract_id,event,detail) values($1,$2,'created','{"seed":true}')`, tenant, contract); e != nil {
						return e
					}
				}
				n++
			}
		}
	}
	var tenant string
	if e = tx.QueryRowContext(ctx, `select id from tenants where slug='alfa'`).Scan(&tenant); e != nil {
		return e
	}
	if token := os.Getenv("NEXO_DEMO_AGENT_TOKEN"); token != "" {
		const id = "00000000-0000-4000-8000-0000000000a1"
		if _, e = tx.ExecContext(ctx, `insert into agents(id,tenant_id,name,token_hash) values($1,$2,'Agente Demo (simulado)',$3) on conflict(id) do update set token_hash=excluded.token_hash`, id, tenant, cryptox.SHA256(token)); e != nil {
			return e
		}
		for _, d := range [][5]string{{"NAS Demo (simulado)", "demo", "simulado", "8728", ""}, {"OLT Demo (simulada)", "olt_demo", "simulado", "8728", ""}, {"OLT Huawei (EMULADOR de CLI)", "olt_huawei", "olt-huawei-emu", "2222", "huawei-emulador"}} {
			if _, e = tx.ExecContext(ctx, `insert into devices(tenant_id,name,driver,host,api_port,credential_ref,agent_id) values($1,$2,$3,$4,$5::int,$6,$7) on conflict(tenant_id,name) do nothing`, tenant, d[0], d[1], d[2], d[3], d[4], id); e != nil {
				return e
			}
		}
	}
	if e = tx.QueryRowContext(ctx, `select exists(select 1 from stock_items where tenant_id=$1)`, tenant).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		if _, e = tx.ExecContext(ctx, `insert into ip_pools(tenant_id,name,cidr,kind,notes) values($1,'Assinantes CGNAT (demo)','100.127.0.0/24','cgnat','bloco de exemplo'),($1,'Saída pública (demo)','203.0.113.0/30','public','faixa de documentação, não roteável')`, tenant); e != nil {
			return e
		}
		for _, item := range []struct {
			name, unit string
			min, qty   int
		}{{"ONU GPON (demo)", "un", 5, 12}, {"Cabo drop (demo)", "m", 500, 300}, {"Conector SC/APC (demo)", "un", 50, 200}} {
			var id string
			if e = tx.QueryRowContext(ctx, `insert into stock_items(tenant_id,name,unit,min_qty) values($1,$2,$3,$4) returning id`, tenant, item.name, item.unit, item.min).Scan(&id); e != nil {
				return e
			}
			if _, e = tx.ExecContext(ctx, `insert into stock_movements(tenant_id,item_id,qty,kind,note) values($1,$2,$3,'in','saldo inicial (demo)')`, tenant, id, item.qty); e != nil {
				return e
			}
		}
		var box string
		if e = tx.QueryRowContext(ctx, `insert into ftth_boxes(tenant_id,name,kind,ports,address) values($1,'CEO-01 (demo)','ceo',8,'Rua das Acácias, poste 12') returning id`, tenant).Scan(&box); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `insert into ftth_boxes(tenant_id,name,kind,ports,parent_id,address) values($1,'CTO-01 (demo)','cto',16,$2,'Rua das Acácias, poste 15')`, tenant, box); e != nil {
			return e
		}
		if _, e = tx.ExecContext(ctx, `insert into leads(tenant_id,name,phone,address_city,address_state,source) values($1,'Prospecto Exemplo (demo)','11955550000','Cidade Demo','SP','indicação')`, tenant); e != nil {
			return e
		}
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	fmt.Fprintln(out, "seed-demo: dados sintéticos disponíveis")
	return nil
}
func fakeCPF(seed int) string {
	base := fmt.Sprint(100000000 + seed*7919%899999999)
	digit := func(s string) byte {
		n := 0
		for i, c := range []byte(s) {
			n += int(c-'0') * (len(s) + 1 - i)
		}
		n = n * 10 % 11
		if n == 10 {
			n = 0
		}
		return byte(n) + '0'
	}
	base += string(digit(base))
	return base + string(digit(base))
}
