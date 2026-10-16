import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { agentCall, call, login } from './helpers.js';

// Degraus de inadimplência por plano: reduzir a velocidade e bloquear, com limites do plano acima da política do provedor.
let admin: string, tenantId: string, before: any, agentToken: string, deviceId: string;
let planId: string, contractId: string, resourceId: string;
const tag = String(Date.now()).slice(-6);
// data no fuso do provedor (à noite, o dia em UTC já é o seguinte)
const day = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + n * 86_400_000));
const settings = (extra: object) => call(admin, 'PUT', '/api/finance/settings', {
  gateway: 'none', billing_auto: false, auto_suspend: true, suspend_after_days: 30, auto_resume_on_payment: true, ...extra });
const svc = async () => (await call(admin, 'GET', `/api/contracts/${contractId}/service`)).body;
const lastEnv = async () => (await call(admin, 'GET', `/api/operations/${(await svc()).operations[0].id}`)).body;

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  before = (await call(admin, 'GET', '/api/finance/settings')).body;
  const a = (await call(admin, 'POST', '/api/agents', { name: `agente-degraus-${tag}` })).body;
  agentToken = a.token;
  deviceId = (await call(admin, 'POST', '/api/devices', { name: `nas-degraus-${tag}`, driver: 'demo', agent_id: a.id })).body.id;
  await agentCall(agentToken, 'hello', { session_id: `sess-deg-${tag}`, version: '0.4.0' });
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano degraus ${tag}`, price_cents: 5000, down_kbps: 100000, up_kbps: 50000, profile_name: `deg${tag}` })).body.id;
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Degraus ${tag}` })).body;
  contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: planId, due_day: 10 })).body.id;
  const s = await call(admin, 'POST', `/api/contracts/${contractId}/service`, { device_id: deviceId, pppoe_username: `deg${tag}` });
  resourceId = s.body.resource_id;
});
afterAll(async () => {
  await call(admin, 'PUT', '/api/finance/settings', { gateway: before.gateway, billing_auto: before.billing_auto, auto_suspend: before.auto_suspend,
    suspend_after_days: before.suspend_after_days, auto_resume_on_payment: before.auto_resume_on_payment });
  // nada em aberto pode sobrar para financeiro.test.ts, que escolhe "a primeira fatura em aberto"
  for (const i of (await call(admin, 'GET', `/api/invoices?contract_id=${contractId}&limit=50`)).body)
    if (i.status === 'open') await call(admin, 'POST', `/api/invoices/${i.id}/cancel`, { reason: 'limpeza do teste' });
});

describe('degraus por plano', () => {
  it('valida a ordem dos dias e exige o perfil reduzido', async () => {
    const put = (b: object) => call(admin, 'PUT', `/api/plans/${planId}/dunning`, b);
    expect((await put({ warn_after_days: 5, reduce_after_days: 3, block_after_days: 40, reduced_profile: 'lento' })).status).toBe(400);   // aviso depois da redução
    expect((await put({ warn_after_days: null, reduce_after_days: 10, block_after_days: 40, reduced_profile: null })).status).toBe(400);   // sem perfil
    expect((await put({ warn_after_days: null, reduce_after_days: 10, block_after_days: 5, reduced_profile: 'lento' })).status).toBe(400);   // redução depois do bloqueio
    const ok = await put({ warn_after_days: 3, reduce_after_days: 10, block_after_days: 40, reduced_profile: 'nexo-lento' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ warn_after_days: 3, reduce_after_days: 10, block_after_days: 40, reduced_profile: 'nexo-lento' });
    expect((await call(admin, 'GET', '/api/plans')).body.find((p: any) => p.id === planId)).toMatchObject({ reduce_after_days: 10, reduced_profile: 'nexo-lento' });
  });

  it('reduz aos 10 dias (não bloqueia), bloqueia aos 40 e o pagamento volta ao normal', async () => {
    expect((await settings({})).status).toBe(200);
    await call(admin, 'POST', `/api/resources/${resourceId}/resume`, { reason: 'provisão inicial do teste' }).catch(() => {});
    const inv = (await call(admin, 'POST', '/api/invoices', { contract_id: contractId, description: 'Degraus', amount_cents: 5000, due_date: day(-20) })).body;
    // 20 dias de atraso: acima do degrau de redução (10), abaixo do bloqueio do plano (40) e do limite do provedor (30)
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: contractId })).body.requested).toBe(1);
    let s = await svc();
    expect(s.resource).toMatchObject({ desired_policy: 'suspended', desired_stage: 'reduced' });
    const op = await lastEnv();
    expect(op.parameters.suspension).toEqual({ mode: 'profile', profile: 'nexo-lento', session: 'disconnect' });
    expect(String(op.reason)).toMatch(/velocidade reduzida/);
    // repetir a rotina não pede de novo
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: contractId })).body.requested).toBe(0);

    // 45 dias de atraso: acima do bloqueio do plano; escala de reduzida para bloqueada
    await withScope({ tenantId, operator: false }, (c) => c.query('update invoices set due_date = $2 where id = $1', [inv.id, day(-45)]));
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: contractId })).body.requested).toBe(1);
    s = await svc();
    expect(s.resource).toMatchObject({ desired_policy: 'suspended', desired_stage: 'blocked' });
    expect((await lastEnv()).parameters.suspension).toEqual({ mode: 'reject', session: 'disconnect' });

    // pagamento confirmado: volta ao normal (sem degrau)
    const pay = await call(admin, 'POST', `/api/invoices/${inv.id}/manual-payment`, { amount_cents: 5000, paid_at: day(0), note: 'pago no balcão' });
    expect(pay.body.status).toBe('paid');
    s = await svc();
    expect(s.resource).toMatchObject({ desired_policy: 'active', desired_stage: null });
  });

  it('sem limite no plano vale a política do provedor; plano sem perfil reduzido não reduz', async () => {
    await call(admin, 'PUT', `/api/plans/${planId}/dunning`, { warn_after_days: null, reduce_after_days: null, block_after_days: null, reduced_profile: null });
    const inv = (await call(admin, 'POST', '/api/invoices', { contract_id: contractId, description: 'Política do provedor', amount_cents: 5000, due_date: day(-20) })).body;
    // 20 dias < 30 do provedor: nada
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: contractId })).body.requested).toBe(0);
    await withScope({ tenantId, operator: false }, (c) => c.query('update invoices set due_date = $2 where id = $1', [inv.id, day(-31)]));
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: contractId })).body.requested).toBe(1);
    expect((await svc()).resource).toMatchObject({ desired_policy: 'suspended', desired_stage: 'blocked' });
  });
});
