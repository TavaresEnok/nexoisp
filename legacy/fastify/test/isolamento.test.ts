import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { pool, withScope } from '../src/db.js';
import { call, login } from './helpers.js';

// Regressão essencial: tenant A não lê nem altera dados de B — pela API e com o papel real do banco.
describe('isolamento entre provedores', () => {
  it('papel da aplicação não é superusuário, não ignora RLS e não é dono das tabelas', async () => {
    const r = await pool().query(
      `select current_user, r.rolsuper, r.rolbypassrls,
              (select count(*) from pg_tables t where t.schemaname = 'public' and t.tableowner = current_user) as owned
       from pg_roles r where r.rolname = current_user`);
    expect(r.rows[0]).toMatchObject({ current_user: 'nexo_app', rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it('API: A não lista, lê, altera nem referencia registros de B', async () => {
    const a = await login('admin@alfa.demo');
    const b = await login('admin@beta.demo');
    const subsA = (await call(a, 'GET', '/api/subscribers')).body;
    const subsB = (await call(b, 'GET', '/api/subscribers')).body;
    expect(subsA.length).toBeGreaterThan(0);
    expect(subsB.length).toBeGreaterThan(0);
    const idsA = new Set(subsA.map((s: any) => s.id));
    expect(subsB.some((s: any) => idsA.has(s.id))).toBe(false);

    const alvo = subsB[0];
    expect((await call(a, 'GET', `/api/subscribers/${alvo.id}`)).status).toBe(404);
    expect((await call(a, 'PATCH', `/api/subscribers/${alvo.id}`, { name: 'invadido' })).status).toBe(404);
    expect((await call(b, 'GET', `/api/subscribers/${alvo.id}`)).body.name).toBe(alvo.name);

    const planA = (await call(a, 'GET', '/api/plans')).body[0];
    const planB = (await call(b, 'GET', '/api/plans')).body[0];
    expect((await call(a, 'POST', '/api/contracts', { subscriber_id: alvo.id, plan_id: planA.id, due_day: 10 })).status).toBe(400);
    expect((await call(a, 'POST', '/api/contracts', { subscriber_id: subsA[0].id, plan_id: planB.id, due_day: 10 })).status).toBe(400);
    const contratoB = (await call(b, 'GET', '/api/contracts')).body[0];
    expect((await call(a, 'GET', `/api/contracts/${contratoB.id}`)).status).toBe(404);
    expect((await call(a, 'PATCH', `/api/contracts/${contratoB.id}`, { end: true })).status).toBe(404);
  });

  it('banco: RLS bloqueia leitura/escrita cruzada mesmo com SQL direto e conexão reutilizada', async () => {
    const one = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP, max: 1 }); // força reuso da mesma conexão
    const scoped = async (tenantId: string | null, sql: string, params: unknown[] = []) => {
      const c = await one.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId ?? '']);
        const r = await c.query(sql, params);
        await c.query('commit');
        return r;
      } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    };
    const tenants = await withScope({ tenantId: null, operator: true }, async (c) => (await c.query(`select id, slug from tenants where slug in ('alfa','beta') order by slug`)).rows);
    const [A, B] = [tenants[0].id, tenants[1].id];

    const totalB = (await scoped(B, 'select count(*)::int n from subscribers')).rows[0].n;
    expect(totalB).toBeGreaterThan(0);
    // conexão reutilizada sem contexto: nada visível (set_config local não vaza)
    expect((await one.query('select count(*)::int n from subscribers')).rows[0].n).toBe(0);
    expect((await one.query('select count(*)::int n from tenants')).rows[0].n).toBe(0);
    // contexto A: não enxerga nem altera B
    expect((await scoped(A, 'select count(*)::int n from subscribers where tenant_id = $1', [B])).rows[0].n).toBe(0);
    expect((await scoped(A, `update subscribers set name = 'x' where tenant_id = $1`, [B])).rowCount).toBe(0);
    expect((await scoped(A, 'delete from contracts where tenant_id = $1', [B])).rowCount).toBe(0);
    await expect(scoped(A, `insert into subscribers (tenant_id, name) values ($1, 'intruso')`, [B])).rejects.toThrow(/row-level security/);
    // contrato de A apontando para assinante de B: barrado pela FK composta (tenant_id, id)
    const subB = (await scoped(B, 'select id from subscribers limit 1')).rows[0].id;
    const pvA = (await scoped(A, 'select id from plan_versions limit 1')).rows[0].id;
    await expect(scoped(A, `insert into contracts (tenant_id, subscriber_id, plan_version_id, due_day) values ($1,$2,$3,10)`, [A, subB, pvA])).rejects.toThrow(/foreign key/);
    // sessões só por função
    await expect(one.query('select * from sessions')).rejects.toThrow(/permission denied/);
    expect((await scoped(B, 'select count(*)::int n from subscribers')).rows[0].n).toBe(totalB);
    await one.end();
  });

  it('permissões no backend: papel sem permissão recebe 403; operador sem suporte não acessa dados do tenant', async () => {
    const fin = await login('financeiro@alfa.demo');
    expect((await call(fin, 'POST', '/api/subscribers', { name: 'Teste Sem Permissão' })).status).toBe(403);
    expect((await call(fin, 'GET', '/api/users')).status).toBe(403);
    expect((await call(fin, 'GET', '/api/tenants')).status).toBe(403);
    const op = await login('operador@nexoisp.demo');
    expect((await call(op, 'GET', '/api/subscribers')).status).toBe(403);
    expect((await call(null, 'GET', '/api/subscribers')).status).toBe(401);
  });

  it('operador do SaaS: cria e suspende provedor; acesso de suporte é explícito, restrito ao provedor e auditado', async () => {
    const op = await login('operador@nexoisp.demo');
    const slug = `novo-${Date.now()}`;
    const created = await call(op, 'POST', '/api/tenants', { name: 'Provedor Novo', slug, admin_name: 'Admin Novo', admin_email: `admin@${slug}.demo`, admin_password: 'demo1234' });
    expect(created.status).toBe(200);
    const novo = await login(`admin@${slug}.demo`);
    expect((await call(novo, 'GET', '/api/subscribers')).body).toEqual([]);           // provedor novo nasce vazio e isolado
    expect((await call(novo, 'POST', '/api/tenants', {})).status).toBe(403);

    // suporte: sem entrar, nada; ao entrar com motivo, só aquele provedor, e fica registrado na auditoria DELE
    expect((await call(op, 'POST', '/api/support/enter', { tenant_id: created.body.id, reason: 'x' })).status).toBe(400);
    expect((await call(op, 'POST', '/api/support/enter', { tenant_id: created.body.id, reason: 'chamado 123: conferir cadastro' })).status).toBe(200);
    expect((await call(op, 'GET', '/api/me')).body).toMatchObject({ support: true, tenant: { slug } });
    expect((await call(op, 'GET', '/api/subscribers')).body).toEqual([]);
    expect((await call(op, 'POST', '/api/subscribers', { name: 'Criado Pelo Suporte' })).status).toBe(200);
    const audit = (await call(novo, 'GET', '/api/audit')).body;
    expect(audit.some((a: any) => a.action === 'support.enter' && a.detail.reason.includes('chamado 123'))).toBe(true);
    expect(audit.find((a: any) => a.action === 'subscriber.create').detail.support_access).toBe(true);
    expect((await call(op, 'POST', '/api/support/exit')).status).toBe(200);
    expect((await call(op, 'GET', '/api/subscribers')).status).toBe(403);

    // suspender o provedor derruba as sessões dos usuários dele
    expect((await call(op, 'PATCH', `/api/tenants/${created.body.id}`, { status: 'suspended' })).status).toBe(200);
    expect((await call(novo, 'GET', '/api/me')).status).toBe(401);
    expect((await call(null, 'POST', '/api/auth/login', { email: `admin@${slug}.demo`, password: 'demo1234' })).status).toBe(401);
  });
  it('módulos por provedor: provedor novo nasce só com o núcleo; o servidor recusa o que não foi liberado', async () => {
    const op = await login('operador@nexoisp.demo');
    const slug = `mod-${Date.now()}`;
    const t = (await call(op, 'POST', '/api/tenants', { name: 'Provedor Módulos', slug, admin_name: 'Admin', admin_email: `admin@${slug}.demo`, admin_password: 'demo1234' })).body;
    const adm = await login(`admin@${slug}.demo`);
    expect((await call(adm, 'GET', '/api/me')).body.modules).toEqual([]);
    for (const url of ['/api/subscribers', '/api/plans', '/api/contracts', '/api/invoices', '/api/agents', '/api/devices', '/api/operations', '/api/audit', '/api/today'])
      expect((await call(adm, 'GET', url)).status, url).toBe(200);                                    // núcleo sempre disponível
    for (const url of ['/api/onus', '/api/olt/discoveries', '/api/ipam/pools', '/api/cgnat/plans', '/api/work-orders', '/api/stock/items', '/api/ftth/boxes',
      '/api/leads', '/api/tickets', '/api/crm/report?from=2026-01-01&to=2026-01-02', '/api/noc/overview', '/api/notifications']) {
      const r = await call(adm, 'GET', url);
      expect([r.status, r.body.code], url).toEqual([403, 'module_disabled']);
    }
    expect((await call(adm, 'POST', '/api/devices', { name: 'olt', driver: 'olt_huawei', host: '192.0.2.1', api_port: 22, credential_ref: 'x' })).body.code).toBe('module_disabled');
    expect((await call(adm, 'POST', '/api/devices', { name: 'nas', driver: 'mikrotik_radius', host: '192.0.2.2', api_port: 8729, credential_ref: 'x' })).status).toBe(200);
    expect((await call(adm, 'PATCH', `/api/tenants/${t.id}`, { modules: ['olt'] })).status).toBe(403);   // o próprio provedor não se libera
    expect((await call(op, 'PATCH', `/api/tenants/${t.id}`, { modules: ['inexistente'] })).status).toBe(400);
    expect((await call(op, 'PATCH', `/api/tenants/${t.id}`, { modules: ['crm', 'crm', 'field'] })).body.modules).toEqual(['crm', 'field']);
    expect((await call(adm, 'GET', '/api/tickets')).status).toBe(200);
    expect((await call(adm, 'GET', '/api/work-orders')).status).toBe(200);
    expect((await call(adm, 'GET', '/api/onus')).status).toBe(403);
    expect((await call(await login('admin@alfa.demo'), 'GET', '/api/me')).body.modules).toHaveLength(7);   // demonstração mostra tudo
  });
});
