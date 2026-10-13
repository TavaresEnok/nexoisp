import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freeContract, login, testAgent } from './helpers.js';

// Financeiro avançado: multa e juros, baixa parcial com desconto, estorno, acordo, proporcional e liberação por confiança.
// O nome do arquivo o coloca depois de financeiro.test.ts, que confere TODAS as faturas do provedor.
let admin: string;
let before: any;
const contracts: string[] = [];
let generatedCompetence: string | null = null;
const day = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
// gateway de demonstração: as faturas criadas aqui também recebem cobrança, como financeiro.test.ts espera de todas
const base = { gateway: 'demo', billing_auto: false, auto_suspend: false, suspend_after_days: null, auto_resume_on_payment: false };
const settings = async (extra: object) => call(admin, 'PUT', '/api/finance/settings', { ...base, ...extra });
const invoice = async (id: string) => (await call(admin, 'GET', `/api/invoices/${id}`)).body;
async function newContract(extra: object = {}): Promise<string> {
  const plan = (await call(admin, 'GET', '/api/plans')).body.find((p: any) => p.active && p.price_cents > 0);
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Avançado ${Date.now()}${Math.floor(Math.random() * 1e4)}` })).body;
  const k = await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan.id, due_day: 10, ...extra });
  expect(k.status).toBe(200);
  contracts.push(k.body.id);
  return k.body.id;
}
async function manualInvoice(contractId: string, cents: number, dueOffset: number): Promise<string> {
  const r = await call(admin, 'POST', '/api/invoices', { contract_id: contractId, description: 'Teste avançado', amount_cents: cents, due_date: day(dueOffset) });
  expect(r.status).toBe(200);
  return r.body.id;
}

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  before = (await call(admin, 'GET', '/api/finance/settings')).body;
});
afterAll(async () => {
  // financeiro.test.ts escolhe "a primeira fatura em aberto" do provedor: nada em aberto pode sobrar daqui
  const cancel = async (rows: any[]) => { for (const i of rows) if (i.status === 'open') await call(admin, 'POST', `/api/invoices/${i.id}/cancel`, { reason: 'limpeza do teste' }); };
  for (const k of contracts) await cancel((await call(admin, 'GET', `/api/invoices?contract_id=${k}&limit=100`)).body);
  if (generatedCompetence)
    await cancel((await call(admin, 'GET', '/api/invoices?status=open&limit=500')).body.filter((i: any) => i.competence?.slice(0, 7) === generatedCompetence));
  await call(admin, 'PUT', '/api/finance/settings', {
    gateway: before.gateway, billing_auto: before.billing_auto, auto_suspend: before.auto_suspend, suspend_after_days: before.suspend_after_days,
    auto_resume_on_payment: before.auto_resume_on_payment, late_fee_percent: 0, interest_monthly_percent: 0, prorate_first_month: false,
    trust_release_enabled: false,
  });
});

describe('multa, juros, baixa parcial, desconto e estorno', () => {
  it('multa e juros seguem a política; a baixa parcial mantém a fatura aberta e a soma fecha com desconto', async () => {
    expect((await settings({ late_fee_percent: 2, interest_monthly_percent: 1 })).status).toBe(200);
    const id = await manualInvoice(await newContract(), 10000, -30);
    const due = (await call(admin, 'GET', `/api/invoices/${id}/due`)).body;
    // o provedor está em America/Sao_Paulo: perto da meia-noite UTC o atraso é de 29 ou 30 dias
    expect([29, 30]).toContain(due.days_late);
    expect(due).toMatchObject({ fine_cents: 200, interest_cents: Math.round(10000 * 0.01 * due.days_late / 30), remaining_cents: 10000 });
    const fee = due.fine_cents + due.interest_cents;
    expect(due.fee_if_applied_cents).toBe(fee);

    const p1 = await call(admin, 'POST', `/api/invoices/${id}/manual-payment`,
      { amount_cents: 5000, paid_at: day(0), note: 'primeira parte', apply_fees: true, partial: true });
    expect(p1.body.status).toBe('open');
    let d = await invoice(id);
    expect(d).toMatchObject({ status: 'open', paid_cents: 5000, fee_cents: fee });
    expect((await call(admin, 'GET', `/api/invoices/${id}/due`)).body.remaining_cents).toBe(5000 + fee);

    // segunda parte com desconto igual à multa e aos juros: 5000 + 5000 = 10000 + fee - fee
    const p2 = await call(admin, 'POST', `/api/invoices/${id}/manual-payment`,
      { amount_cents: 5000, paid_at: day(0), note: 'segunda parte', discount_cents: fee, discount_reason: 'acordo com o atendente' });
    expect(p2.body.status).toBe('paid');
    d = await invoice(id);
    expect(d).toMatchObject({ status: 'paid', paid_cents: 10000, discount_cents: fee });
    expect(d.items.map((i: any) => i.amount_cents)).toEqual([10000, fee, -fee]);

    // estorno da segunda baixa: reabre, mantém o que foi pago antes; estornar de novo é recusado
    const second = d.payments.find((p: any) => p.note === 'segunda parte');
    const rev = await call(admin, 'POST', `/api/invoices/${id}/payments/${second.id}/reverse`, { reason: 'valor lançado na fatura errada' });
    expect(rev.body).toMatchObject({ status: 'open', paid_cents: 5000 });
    expect((await call(admin, 'POST', `/api/invoices/${id}/payments/${second.id}/reverse`, { reason: 'de novo, por engano' })).status).toBe(409);
    d = await invoice(id);
    expect(d.status).toBe('open');
    expect(d.payments.filter((p: any) => p.kind === 'reversal')).toHaveLength(1);
  });

  it('sem a marca de parcial, valor diferente do devido continua indo para a conciliação; desconto exige motivo', async () => {
    const id = await manualInvoice(await newContract(), 8000, 5);
    const r = await call(admin, 'POST', `/api/invoices/${id}/manual-payment`, { amount_cents: 3000, paid_at: day(0), note: 'valor menor' });
    expect(r.body.status).toBe('reconciling');
    const id2 = await manualInvoice(await newContract(), 8000, 5);
    expect((await call(admin, 'POST', `/api/invoices/${id2}/manual-payment`, { amount_cents: 7000, paid_at: day(0), note: 'sem motivo', discount_cents: 1000 })).status).toBe(400);
    expect((await call(admin, 'POST', `/api/invoices/${id2}/manual-payment`, { amount_cents: 1000, paid_at: day(0), note: 'desconto alto', discount_cents: 9000, discount_reason: 'x x x' })).status).toBe(400);
  });
});

describe('acordo de pagamento', () => {
  it('reúne faturas em aberto, cancela as originais e gera as parcelas que somam o acordo', async () => {
    const k = await newContract();
    const [a, b] = [await manualInvoice(k, 6000, -40), await manualInvoice(k, 4000, -10)];
    const outro = await manualInvoice(await newContract(), 1000, -5);
    expect((await call(admin, 'POST', `/api/contracts/${k}/agreement`,
      { invoice_ids: [a, outro], installments: 2, first_due_date: day(7), reason: 'fatura de outro contrato' })).status).toBe(400);

    const r = await call(admin, 'POST', `/api/contracts/${k}/agreement`,
      { invoice_ids: [a, b], installments: 3, first_due_date: day(7), discount_cents: 1000, reason: 'renegociação combinada por telefone' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ original_cents: 10000, total_cents: 9000 });
    expect(r.body.installments.map((i: any) => i.amount_cents)).toEqual([3000, 3000, 3000]);
    expect((await invoice(a)).status).toBe('canceled');
    expect((await invoice(b)).status).toBe('canceled');
    const parcelas = (await call(admin, 'GET', `/api/invoices?contract_id=${k}`)).body.filter((i: any) => i.kind === 'agreement');
    expect(parcelas).toHaveLength(3);
    expect(parcelas.every((i: any) => i.status === 'open' && i.agreement_id === r.body.id)).toBe(true);
    // faturas já canceladas não entram em outro acordo
    expect((await call(admin, 'POST', `/api/contracts/${k}/agreement`,
      { invoice_ids: [a], installments: 1, first_due_date: day(7), reason: 'tentativa repetida' })).status).toBe(400);
  });
});

describe('mensalidade proporcional', () => {
  it('com a opção ligada o primeiro mês é cobrado pelos dias de uso; desligada, pelo valor cheio', async () => {
    const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 6);
    const comp = d.toISOString().slice(0, 7);
    const dias = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const start = `${comp}-16`;
    const k = await newContract({ start_date: start });
    const price = (await call(admin, 'GET', `/api/contracts/${k}`)).body.price_cents;
    await settings({ prorate_first_month: true });
    generatedCompetence = comp;
    const g = await call(admin, 'POST', '/api/finance/generate', { competence: comp });
    expect(g.status).toBe(200);
    const inv = (await call(admin, 'GET', `/api/invoices?contract_id=${k}`)).body.find((i: any) => i.kind === 'monthly');
    expect(inv.amount_cents).toBe(Math.round(price * (dias - 15) / dias));
    expect((await invoice(inv.id)).items[0].description).toMatch(/proporcional/);
  });
});

describe('liberação por confiança', () => {
  it('só libera acesso suspenso, respeita prazo e intervalo, e não é re-suspenso enquanto vale', async () => {
    const ag = await testAgent(admin);
    const kc = await freeContract(admin);
    contracts.push(kc.id);
    const svc = await call(admin, 'POST', `/api/contracts/${kc.id}/service`, { device_id: ag.deviceId, pppoe_username: `confianca${Date.now()}` });
    expect(svc.status).toBe(200);
    await ag.runNext();   // provisiona
    const rid = svc.body.resource_id;

    // desabilitada: recusa
    await settings({ trust_release_enabled: false });
    expect((await call(admin, 'POST', `/api/contracts/${kc.id}/trust-release`, { reason: 'cliente prometeu pagar' })).status).toBe(409);
    await settings({ trust_release_enabled: true, trust_release_days: 3, trust_release_gap_days: 30 });
    // acesso ativo: nada a liberar
    const s0 = (await call(admin, 'GET', `/api/contracts/${kc.id}/trust-release`)).body;
    expect(s0).toMatchObject({ enabled: true, eligible: false, reason: 'o acesso não está suspenso' });

    expect((await call(admin, 'POST', `/api/resources/${rid}/suspend`, { reason: 'inadimplência: teste' })).status).toBe(200);
    await ag.runNext();
    expect((await call(admin, 'GET', `/api/contracts/${kc.id}/trust-release`)).body.eligible).toBe(true);
    // prazo acima do máximo
    expect((await call(admin, 'POST', `/api/contracts/${kc.id}/trust-release`, { days: 10, reason: 'prazo longo' })).status).toBe(400);

    const ok = await call(admin, 'POST', `/api/contracts/${kc.id}/trust-release`, { days: 2, reason: 'cliente prometeu pagar sexta' });
    expect(ok.status).toBe(200);
    const env = await ag.runNext();
    expect(env.action).toBe('subscriber.resume');
    expect((await call(admin, 'GET', `/api/contracts/${kc.id}/service`)).body.resource.desired_policy).toBe('active');
    const st = (await call(admin, 'GET', `/api/contracts/${kc.id}/trust-release`)).body;
    expect(st.active).toBeTruthy();
    expect(st.eligible).toBe(false);

    // com liberação vigente e fatura vencida, a suspensão automática NÃO age
    await settings({ trust_release_enabled: true, auto_suspend: true, suspend_after_days: 0 });
    await manualInvoice(kc.id, 5000, -20);
    const run = (await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: kc.id })).body;
    expect(run.requested).toBe(0);
    expect((await call(admin, 'GET', `/api/contracts/${kc.id}/service`)).body.resource.desired_policy).toBe('active');
    // vencida a liberação, a mesma verificação passa a suspender o contrato
    await (await import('../src/db.js')).withScope({ tenantId: (await call(admin, 'GET', '/api/me')).body.tenant.id, operator: false },
      (c) => c.query(`update trust_releases set expires_at = now() - interval '1 minute' where contract_id = $1`, [kc.id]));
    expect((await call(admin, 'POST', '/api/finance/run-auto-suspend', { contract_id: kc.id })).body.requested).toBe(1);
  });

  it('o assinante pede pelo portal só para o próprio contrato e com as mesmas regras', async () => {
    const ag = await testAgent(admin);
    const kc = await freeContract(admin);
    contracts.push(kc.id);
    const svc = await call(admin, 'POST', `/api/contracts/${kc.id}/service`, { device_id: ag.deviceId, pppoe_username: `portal${Date.now()}` });
    await ag.runNext();
    await call(admin, 'POST', `/api/resources/${svc.body.resource_id}/suspend`, { reason: 'inadimplência: teste portal' });
    await ag.runNext();
    await settings({ trust_release_enabled: true, trust_release_days: 2, trust_release_gap_days: 30 });
    const email = `portal-${Date.now()}@teste.local`;
    expect((await call(admin, 'POST', `/api/subscribers/${kc.subscriber_id}/portal-access`, { email, password: 'demo1234' })).status).toBe(200);
    const sub = await login(email);
    const ov = (await call(sub, 'GET', '/api/portal/overview')).body;
    expect(ov.contracts.find((c: any) => c.id === kc.id).trust_release).toMatchObject({ enabled: true, eligible: true, max_days: 2 });
    // contrato de outro assinante: não existe para quem pede
    const alheio = (await call(admin, 'GET', '/api/contracts?status=active')).body.find((c: any) => c.subscriber_id !== kc.subscriber_id);
    expect((await call(sub, 'POST', '/api/portal/trust-release', { contract_id: alheio.id })).status).toBe(404);
    const ok = await call(sub, 'POST', '/api/portal/trust-release', { contract_id: kc.id });
    expect(ok.status).toBe(200);
    expect(ok.body.days).toBe(2);
    expect((await ag.runNext()).action).toBe('subscriber.resume');
    // não pode repetir enquanto vale nem dentro do intervalo
    expect((await call(sub, 'POST', '/api/portal/trust-release', { contract_id: kc.id })).status).toBe(409);
    // a equipe não é obrigada pela tela do assinante, mas vê o mesmo histórico
    const hist = (await call(admin, 'GET', `/api/contracts/${kc.id}/trust-release`)).body.history;
    expect(hist[0]).toMatchObject({ source: 'portal', status: 'active' });
  });
});
