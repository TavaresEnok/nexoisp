import { hashPassword, sha256 } from './auth.js';
import { withScope } from './db.js';

/** DADOS SINTÉTICOS DE DEMONSTRAÇÃO. Só roda com NEXO_DEMO_MODE=1. Senha de todos: demo1234 */
export const DEMO_PASSWORD = 'demo1234';

export function fakeCpf(seed: number): string {
  const base = String(100000000 + (seed * 7919) % 899999999).slice(0, 9);
  const dv = (s: string) => {
    let t = 0;
    for (let i = 0; i < s.length; i++) t += Number(s[i]) * (s.length + 1 - i);
    const r = (t * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  return base + d1 + dv(base + d1);
}

const NAMES = ['Ana Souza', 'Bruno Lima', 'Carla Mendes', 'Diego Rocha', 'Elaine Castro', 'Fábio Nunes', 'Gabriela Reis', 'Heitor Alves'];

export const DEMO_AGENT_ID = '00000000-0000-4000-8000-0000000000a1';

/** Agente e NAS SIMULADOS do Provedor Alfa, para a demonstração de rede. */
async function seedDemoNetwork() {
  const token = process.env.NEXO_DEMO_AGENT_TOKEN;
  if (!token) return;
  const t = await withScope({ tenantId: null, operator: true }, async (c) => (await c.query(`select id from tenants where slug = 'alfa'`)).rows[0]);
  if (!t) return;
  await withScope({ tenantId: t.id, operator: false }, async (c) => {
    await c.query(`insert into agents (id, tenant_id, name, token_hash) values ($1,$2,'Agente Demo (simulado)',$3)
                   on conflict (id) do update set token_hash = excluded.token_hash`, [DEMO_AGENT_ID, t.id, sha256(token)]);
    await c.query(`insert into devices (tenant_id, name, driver, host, agent_id) values ($1,'NAS Demo (simulado)','demo','simulado',$2)
                   on conflict (tenant_id, name) do nothing`, [t.id, DEMO_AGENT_ID]);
    await c.query(`insert into devices (tenant_id, name, driver, host, agent_id) values ($1,'OLT Demo (simulada)','olt_demo','simulado',$2)
                   on conflict (tenant_id, name) do nothing`, [t.id, DEMO_AGENT_ID]);
    // driver Huawei real falando por SSH com o EMULADOR do ambiente de desenvolvimento (não é uma OLT)
    await c.query(`insert into devices (tenant_id, name, driver, host, api_port, credential_ref, agent_id)
                   values ($1,'OLT Huawei (EMULADOR de CLI)','olt_huawei','olt-huawei-emu',2222,'huawei-emulador',$2)
                   on conflict (tenant_id, name) do nothing`, [t.id, DEMO_AGENT_ID]);
  });
}

/** Exemplos SINTÉTICOS das expansões (IPAM, estoque, FTTH, CRM) no Provedor Alfa. Blocos IP de documentação (RFC 5737/6598). */
async function seedDemoExpansions() {
  const t = await withScope({ tenantId: null, operator: true }, async (c) => (await c.query(`select id from tenants where slug = 'alfa'`)).rows[0]);
  if (!t) return;
  await withScope({ tenantId: t.id, operator: false }, async (c) => {
    if ((await c.query('select 1 from stock_items limit 1')).rowCount) return;
    await c.query(`insert into ip_pools (tenant_id, name, cidr, kind, notes) values
      ($1,'Assinantes CGNAT (demo)','100.127.0.0/24','cgnat','bloco de exemplo'), ($1,'Saída pública (demo)','203.0.113.0/30','public','faixa de documentação, não roteável')`, [t.id]);
    for (const [name, unit, min, qty] of [['ONU GPON (demo)', 'un', 5, 12], ['Cabo drop (demo)', 'm', 500, 300], ['Conector SC/APC (demo)', 'un', 50, 200]] as const) {
      const i = (await c.query('insert into stock_items (tenant_id, name, unit, min_qty) values ($1,$2,$3,$4) returning id', [t.id, name, unit, min])).rows[0];
      await c.query(`insert into stock_movements (tenant_id, item_id, qty, kind, note) values ($1,$2,$3,'in','saldo inicial (demo)')`, [t.id, i.id, qty]);
    }
    const ceo = (await c.query(`insert into ftth_boxes (tenant_id, name, kind, ports, address) values ($1,'CEO-01 (demo)','ceo',8,'Rua das Acácias, poste 12') returning id`, [t.id])).rows[0];
    await c.query(`insert into ftth_boxes (tenant_id, name, kind, ports, parent_id, address) values ($1,'CTO-01 (demo)','cto',16,$2,'Rua das Acácias, poste 15')`, [t.id, ceo.id]);
    await c.query(`insert into leads (tenant_id, name, phone, address_city, address_state, source) values ($1,'Prospecto Exemplo (demo)','11955550000','Cidade Demo','SP','indicação')`, [t.id]);
  });
}

export async function seedDemo(log: (m: string) => void = console.log) {
  await seedDemoBase(log);
  await seedDemoNetwork();
  await seedDemoExpansions();
}

async function seedDemoBase(log: (m: string) => void) {
  const exists = await withScope({ tenantId: null, operator: true }, async (c) =>
    (await c.query(`select 1 from users where email = 'operador@nexoisp.demo'`)).rowCount);
  if (exists) return;
  log('seed: criando dados sintéticos de demonstração');
  const pw = hashPassword(DEMO_PASSWORD);
  const tenants = await withScope({ tenantId: null, operator: true }, async (c) => {
    await c.query(`insert into users (email, name, password_hash, role) values ('operador@nexoisp.demo','Operador SaaS (demo)',$1,'saas_operator')`, [pw]);
    const out: { id: string; slug: string }[] = [];
    for (const [name, slug] of [['Provedor Alfa (demo)', 'alfa'], ['Provedor Beta (demo)', 'beta']]) {
      const t = (await c.query(`insert into tenants (name, slug, modules) values ($1,$2,'{olt,ipam,field,ftth,crm,noc,notices}') returning id, slug`, [name, slug])).rows[0];   // demonstração mostra tudo
      for (const [role, label] of [['admin', 'Admin'], ['attendant', 'Atendimento'], ['finance', 'Financeiro'], ['noc', 'Técnico NOC']])
        await c.query('insert into users (tenant_id, email, name, password_hash, role) values ($1,$2,$3,$4,$5)',
          [t.id, `${role === 'attendant' ? 'atendimento' : role === 'finance' ? 'financeiro' : role}@${slug}.demo`, `${label} ${slug}`, pw, role]);
      out.push(t);
    }
    return out;
  });
  let n = 1;
  for (const t of tenants) {
    await withScope({ tenantId: t.id, operator: false }, async (c) => {
      const versions: string[] = [];
      for (const [name, price, down, up] of [['Fibra 200', 7990, 200_000, 100_000], ['Fibra 500', 9990, 500_000, 250_000], ['Fibra 1 Giga', 14990, 1_000_000, 500_000]] as const) {
        const p = (await c.query('insert into plans (tenant_id, name) values ($1,$2) returning id', [t.id, name])).rows[0];
        const v = (await c.query(
          `insert into plan_versions (tenant_id, plan_id, version, price_cents, down_kbps, up_kbps, profile_name) values ($1,$2,1,$3,$4,$5,$6) returning id`,
          [t.id, p.id, price, down, up, `plano-${down / 1000}m`])).rows[0];
        versions.push(v.id);
      }
      for (let i = 0; i < NAMES.length; i++, n++) {
        const s = (await c.query(
          `insert into subscribers (tenant_id, name, document, email, phone, address_street, address_number, address_city, address_state)
           values ($1,$2,$3,$4,$5,'Rua das Acácias',$6,'Cidade Demo','SP') returning id`,
          [t.id, `${NAMES[i]} (${t.slug})`, fakeCpf(n), `cliente${n}@exemplo.demo`, `1199000${String(1000 + n)}`, String(10 * n)])).rows[0];
        if (i < 6) {
          const k = (await c.query(`insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day) values ($1,$2,$3,$4) returning id`,
            [t.id, s.id, versions[i % versions.length], [5, 10, 15, 20][i % 4]])).rows[0];
          await c.query(`insert into contract_history (tenant_id, contract_id, event, detail) values ($1,$2,'created','{"seed":true}')`, [t.id, k.id]);
        }
      }
    });
  }
}
