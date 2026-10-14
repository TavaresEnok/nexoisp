import { beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { fakeCpf } from '../src/seed.js';
import { call, login } from './helpers.js';

// LGPD: cópia dos dados do titular e anonimização com a retenção legal (faturas ficam, o que identifica sai).
let admin: string, beta: string, atend: string, tenantId: string, planId: string;
const r = 100 + (Date.now() % 800);
const email = `lgpd${r}@cliente.demo`;
let sub: any, contractId: string, invoiceId: string;

beforeAll(async () => {
  admin = await login('admin@alfa.demo'); beta = await login('admin@beta.demo'); atend = await login('atendimento@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano lgpd ${r}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `lg${r}` })).body.id;
  sub = (await call(admin, 'POST', '/api/subscribers', { name: `Titular LGPD ${r}`, document: fakeCpf(r * 7), email, phone: '31999990000',
    address_street: 'Rua Secreta', address_number: '77', address_city: 'Vila', address_state: 'MG' })).body;
  contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body.id;
  await call(admin, 'PUT', `/api/contracts/${contractId}/install-address`, { street: 'Rua da Instalação', number: '5', city: 'Vila', state: 'MG' });
  await call(admin, 'POST', `/api/subscribers/${sub.id}/portal-access`, { email: `portal${email}`, password: 'demo1234' });
  invoiceId = (await call(admin, 'POST', '/api/invoices', { contract_id: contractId, description: 'Taxa', due_date: '2031-05-10', amount_cents: 3000 })).body.id;
  await call(admin, 'POST', `/api/subscribers/${sub.id}/notes`, { body: 'Cliente prefere contato à noite', alert: true });
});

describe('LGPD do titular', () => {
  it('exportação: reúne os dados, é auditada e só o administrador faz', async () => {
    expect((await call(atend, 'GET', `/api/subscribers/${sub.id}/lgpd-export`)).status).toBe(403);
    const x = (await call(admin, 'GET', `/api/subscribers/${sub.id}/lgpd-export`)).body;
    expect(x.subscriber).toMatchObject({ name: `Titular LGPD ${r}`, email });
    expect(x.contracts).toHaveLength(1);
    expect(x.contracts[0].install_street).toBe('Rua da Instalação');
    expect(x.invoices).toHaveLength(1);
    expect(x.portal_access[0].email).toBe(`portal${email}`);
    expect(JSON.stringify(x)).not.toMatch(/password_hash/);
    expect((await call(beta, 'GET', `/api/subscribers/${sub.id}/lgpd-export`)).status).toBe(404);
  });

  it('anonimização recusada com contrato vigente, fatura em aberto, nome errado ou sem motivo', async () => {
    const body = { reason: 'Pedido do titular, protocolo 123', confirm_name: `Titular LGPD ${r}` };
    expect((await call(admin, 'POST', `/api/subscribers/${sub.id}/anonymize`, { ...body, confirm_name: 'Outro Nome' })).status).toBe(400);
    expect((await call(admin, 'POST', `/api/subscribers/${sub.id}/anonymize`, { ...body, reason: 'x' })).status).toBe(400);
    expect((await call(admin, 'POST', `/api/subscribers/${sub.id}/anonymize`, body)).status).toBe(409);       // contrato vigente
    await call(admin, 'PATCH', `/api/contracts/${contractId}`, { end: true });
    const aberta = await call(admin, 'POST', `/api/subscribers/${sub.id}/anonymize`, body);
    expect(aberta.status).toBe(409);                                                                           // fatura em aberto
    expect(aberta.body.error).toMatch(/faturas em aberto/);
    expect((await call(atend, 'POST', `/api/subscribers/${sub.id}/anonymize`, body)).status).toBe(403);
    expect((await call(beta, 'POST', `/api/subscribers/${sub.id}/anonymize`, body)).status).toBe(404);
  });

  it('depois de quitar: sai o que identifica, ficam fatura, pagamento e contrato; o cadastro fica travado', async () => {
    await withScope({ tenantId, operator: false }, (c) => c.query(`update invoices set status = 'canceled', canceled_at = now() where subscriber_id = $1 and status = 'open'`, [sub.id]));
    const ok = await call(admin, 'POST', `/api/subscribers/${sub.id}/anonymize`, { reason: 'Pedido do titular, protocolo 123', confirm_name: `Titular LGPD ${r}` });
    expect(ok.status).toBe(200);
    expect(ok.body.counts).toMatchObject({ contacts: expect.any(Number), notes: 1 });
    const s = (await call(admin, 'GET', `/api/subscribers/${sub.id}`)).body;
    expect(s).toMatchObject({ name: 'Titular anonimizado', document: null, email: null, phone: null, address_street: null, status: 'inactive' });
    expect(s.anonymized_at).toBeTruthy();
    const x = (await call(admin, 'GET', `/api/subscribers/${sub.id}/lgpd-export`)).body;
    expect(x.contracts[0]).toMatchObject({ install_street: null, status: 'ended' });
    expect(x.invoices).toHaveLength(1);                                    // retenção: a fatura continua
    expect(x.notes[0].body).toMatch(/removido/);
    expect(x.portal_access[0]).toMatchObject({ active: false });
    expect(x.portal_access[0].email).toMatch(/anonimizado\.invalid$/);
    expect((await call(admin, 'PATCH', `/api/subscribers/${sub.id}`, { name: 'Voltou' })).status).toBe(409);
    expect((await call(admin, 'POST', `/api/subscribers/${sub.id}/anonymize`, { reason: 'de novo, por engano', confirm_name: 'Titular anonimizado' })).status).toBe(409);
    expect((await call(admin, 'POST', '/api/auth/login', { email: `portal${email}`, password: 'demo1234' })).status).toBe(401);
    const aud = (await call(admin, 'GET', '/api/audit?limit=50')).body;
    expect(JSON.stringify(aud)).toMatch(/subscriber\.anonymize/);
  });
  it('retenção por provedor: mínimos legais travados; a limpeza respeita o prazo do provedor', async () => {
    expect((await call(admin, 'PUT', '/api/settings/retention', { auth_log_days: 7, sessions_days: 200, notice_log_days: null })).status).toBe(400);   // < 1 ano
    expect((await call(atend, 'PUT', '/api/settings/retention', { auth_log_days: 7, sessions_days: 400, notice_log_days: null })).status).toBe(403);
    expect((await call(admin, 'PUT', '/api/settings/retention', { auth_log_days: 10, sessions_days: 400, notice_log_days: 30 })).status).toBe(200);
    expect((await call(admin, 'GET', '/api/settings/retention')).body).toMatchObject({ auth_log_days: 10, sessions_days: 400, notice_log_days: 30 });
    await withScope({ tenantId, operator: false }, (c) => c.query(
      `insert into notice_log (tenant_id, subscriber_id, status, created_at) values ($1, $2, 'sent', now() - interval '40 days'), ($1, $2, 'sent', now() - interval '5 days')`, [tenantId, sub.id]));
    const { purgeRadius } = await import('../src/radius/executor.js');
    await purgeRadius(tenantId);
    const left = (await withScope({ tenantId, operator: false }, (c) => c.query(`select count(*)::int as n from notice_log where subscriber_id = $1`, [sub.id]))).rows[0].n;
    expect(left).toBe(1);                                                 // o de 40 dias saiu (prazo 30), o de 5 dias ficou
    await call(admin, 'PUT', '/api/settings/retention', { auth_log_days: null, sessions_days: null, notice_log_days: null });
  });
});
