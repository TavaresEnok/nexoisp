import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { demoSign } from '../src/finance/gateway.js';
import { call, freeContract, getApp, login, testAgent } from './helpers.js';

// Regressões essenciais: cobrança e pagamento não duplicam; evento perdido é recuperado; divergência não vira baixa;
// suspensão obsoleta não executa após pagamento; sem política configurada não há suspensão automática.
let admin: string;
// competências já vencidas, relativas à data de hoje
const comp = (monthsAgo: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - monthsAgo); return d.toISOString().slice(0, 7); };
const [C1, C2] = [comp(2), comp(3)];
const invoices = async (q = '') => (await call(admin, 'GET', `/api/invoices${q}`)).body as any[];
const invoice = async (id: string) => (await call(admin, 'GET', `/api/invoices/${id}`)).body;
const pay = async (id: string, mode: string) => (await call(admin, 'POST', '/api/demo-gateway/pay', { invoice_id: id, mode })).body;
async function webhook(body: object, opts: { sig?: string; ts?: string } = {}) {
  const raw = JSON.stringify(body), ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const r = await (await getApp()).inject({ method: 'POST', url: '/api/webhooks/gateway/demo', payload: raw,
    headers: { 'content-type': 'application/json', 'x-nexo-timestamp': ts, 'x-nexo-signature': opts.sig ?? demoSign(raw, ts) } });
  return { status: r.statusCode, body: r.json() };
}

beforeAll(async () => {
  process.env.NEXO_GATEWAY_WEBHOOK_SECRET ??= 'segredo-de-teste';
  admin = await login('admin@alfa.demo');
  // contratos sintéticos passam a valer desde o ano anterior, para existirem competências vencidas
  for (const email of ['admin@alfa.demo', 'admin@beta.demo']) {
    const t = (await call(await login(email), 'GET', '/api/me')).body.tenant.id;
    await withScope({ tenantId: t, operator: false }, (c) => c.query(`update contracts set start_date = current_date - 400`));
  }
  const s = await call(admin, 'PUT', '/api/finance/settings', { gateway: 'demo', billing_auto: false, auto_suspend: true, suspend_after_days: 0, auto_resume_on_payment: true });
  expect(s.status).toBe(200);
});

describe('financeiro', () => {
  it('recorrência: reexecutar a mesma competência não duplica faturas', async () => {
    const a = (await call(admin, 'POST', '/api/finance/generate', { competence: C1 })).body;
    expect(a.created).toBeGreaterThan(0);
    const n = (await invoices()).length;
    const b = (await call(admin, 'POST', '/api/finance/generate', { competence: C1 })).body;
    expect(b).toMatchObject({ created: 0, already_existing: a.created });
    expect((await invoices()).length).toBe(n);
    // só o que a recorrência desta competência gerou (faturas avulsas de outros testes podem existir sem cobrança no gateway)
    const daCompetencia = (await invoices()).filter((i) => i.kind === 'monthly' && String(i.competence).startsWith(C1));
    expect(daCompetencia.length).toBeGreaterThan(0);
    expect(daCompetencia.every((i) => i.gateway_charge_id && Number.isInteger(i.amount_cents))).toBe(true);
  });

  it('webhook repetido e pagamento reenviado em outro evento não duplicam a baixa', async () => {
    const inv = (await invoices('?status=open'))[0];
    const r = await pay(inv.id, 'duplicate');
    expect(r.webhook.status).toBe('processed');
    expect(r.webhook_repeated.status).toBe('duplicate');
    let d = await invoice(inv.id);
    expect(d.status).toBe('paid');
    expect(d.payments).toHaveLength(1);
    // mesmo pagamento chegando com OUTRO id de evento
    const again = await webhook({ id: `evt_${randomUUID()}`, type: 'payment.confirmed', charge_id: d.gateway_charge_id,
      payment: { id: d.payments[0].gateway_payment_id, amount_cents: d.amount_cents, paid_at: new Date().toISOString() } });
    expect(again.body.status).toBe('processed');
    d = await invoice(inv.id);
    expect(d.payments).toHaveLength(1);
    expect(d.paid_cents).toBe(d.amount_cents);
  });

  it('webhook sem assinatura válida, fora da janela ou de cobrança desconhecida não gera baixa', async () => {
    const inv = (await invoices('?status=open'))[0];
    const body = { id: `evt_${randomUUID()}`, type: 'payment.confirmed', charge_id: inv.gateway_charge_id, payment: { id: `p_${randomUUID()}`, amount_cents: inv.amount_cents, paid_at: new Date().toISOString() } };
    expect((await webhook(body, { sig: 'sha256=00' })).status).toBe(401);
    expect((await webhook(body, { ts: String(Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
    // valor coincidente sem cobrança correspondente: não é atribuído a ninguém
    expect((await webhook({ ...body, charge_id: 'cobranca_inexistente' })).body.status).toBe('unmatched');
    expect((await invoice(inv.id)).status).toBe('open');
  });

  it('evento perdido é recuperado pela conciliação, uma única vez', async () => {
    const inv = (await invoices('?status=open'))[0];
    await pay(inv.id, 'lost');
    expect((await invoice(inv.id)).status).toBe('open');
    expect((await call(admin, 'POST', '/api/finance/reconcile')).body.recovered).toBe(1);
    const d = await invoice(inv.id);
    expect(d.status).toBe('paid');
    expect(d.payments[0].source).toBe('reconciliation');
    expect((await call(admin, 'POST', '/api/finance/reconcile')).body.recovered).toBe(0);
    expect((await invoice(inv.id)).payments).toHaveLength(1);
  });

  it('valor divergente vai para conciliação, sem baixa inventada', async () => {
    const inv = (await invoices('?status=open'))[0];
    await pay(inv.id, 'divergent');
    const d = await invoice(inv.id);
    expect(d.status).toBe('reconciling');
    expect(d.paid_cents).toBeLessThan(d.amount_cents);
    expect((await call(admin, 'GET', '/api/finance/reconciliation')).body.invoices.some((i: any) => i.id === inv.id)).toBe(true);
  });

  it('suspensão por inadimplência fica obsoleta e NÃO executa quando o pagamento chega antes', async () => {
    const ag = await testAgent(admin, `fin-${Date.now()}`);
    const open = await invoices('?status=open');
    const contract = await freeContract(admin, (k) => open.some((i) => i.contract_id === k.id));
    const inv = open.find((i) => i.contract_id === contract.id);
    const svc = await call(admin, 'POST', `/api/contracts/${contract.id}/service`, { device_id: ag.deviceId, pppoe_username: `fin${Date.now()}` });
    expect(svc.body.error ?? svc.status).toBe(200);
    expect((await ag.runNext())?.action).toBe('subscriber.provision');

    // fatura vencida => política configurada solicita a suspensão
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: contract.id })).body.requested).toBeGreaterThanOrEqual(1);
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: contract.id })).body.requested).toBe(0); // não repete
    let s = (await call(admin, 'GET', `/api/contracts/${contract.id}/service`)).body;
    expect(s.resource.desired_policy).toBe('suspended');
    const suspendOp = s.operations[0];
    expect(suspendOp).toMatchObject({ action: 'subscriber.suspend', status: 'PENDING' });

    // pagamento confirmado ANTES de o agente executar
    expect((await pay(inv.id, 'webhook')).webhook.status).toBe('processed');
    s = (await call(admin, 'GET', `/api/contracts/${contract.id}/service`)).body;
    expect(s.resource.desired_policy).toBe('active'); // intenção atualizada…
    expect(s.resource.observed_version).toBeLessThan(s.resource.desired_version); // …mas rede ainda não confirmada
    expect(s.operations.find((o: any) => o.id === suspendOp.id).status).toBe('SUPERSEDED');
    const next = await ag.runNext();
    expect(next).toMatchObject({ action: 'subscriber.resume', go: true });
    expect(await ag.poll()).toBeNull(); // a suspensão antiga nunca é entregue

    // pagamento cujo evento se perdeu: a rotina consulta o gateway antes de suspender
    await call(admin, 'POST', '/api/finance/generate', { competence: C2 });
    const inv2 = (await invoices(`?status=open&contract_id=${contract.id}`))[0];
    await pay(inv2.id, 'lost');
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: contract.id })).body.requested).toBe(0);
    expect((await invoice(inv2.id)).status).toBe('paid');
    expect((await call(admin, 'GET', `/api/contracts/${contract.id}/service`)).body.resource.desired_policy).toBe('active');
  });

  it('sem política configurada não há suspensão automática; gateway demo e ajustes exigem permissão', async () => {
    const beta = await login('admin@beta.demo');
    await call(beta, 'PUT', '/api/finance/settings', { gateway: 'demo', billing_auto: false, auto_suspend: false, suspend_after_days: null, auto_resume_on_payment: false });
    const ag = await testAgent(beta, `beta-${Date.now()}`);
    await call(beta, 'POST', '/api/finance/generate', { competence: C2 });
    const k = await freeContract(beta);
    await call(beta, 'POST', `/api/contracts/${k.id}/service`, { device_id: ag.deviceId, pppoe_username: `beta${Date.now()}` });
    await ag.runNext();
    expect((await call(beta, 'POST', '/api/finance/run-auto-suspend')).body.requested).toBe(0);
    expect((await call(beta, 'GET', `/api/contracts/${k.id}/service`)).body.resource.desired_policy).toBe('active');
    expect((await call(beta, 'PUT', '/api/finance/settings', { gateway: 'demo', billing_auto: false, auto_suspend: true, suspend_after_days: null, auto_resume_on_payment: false })).status).toBe(400);
    const fin = await login('financeiro@alfa.demo');
    expect((await call(fin, 'PUT', '/api/finance/settings', { gateway: 'none', billing_auto: false, auto_suspend: false, suspend_after_days: null, auto_resume_on_payment: false })).status).toBe(403);
    // faturas de A não aparecem para B
    const idsA = new Set((await invoices()).map((i) => i.id));
    expect((await call(beta, 'GET', '/api/invoices')).body.some((i: any) => idsA.has(i.id))).toBe(false);
  });
});
