import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { applyScheduledChanges } from '../src/scheduled.js';
import { call, login } from './helpers.js';

// Lote 7: desconto na mensalidade, fidelidade com multa, mudança agendada, aditivos e indicação.
let admin: string, noc: string, tenantId: string, planId: string, plan2Id: string;
const tag = String(Date.now()).slice(-6);
// data no fuso do provedor (à noite, o dia em UTC já é o seguinte)
const day = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + n * 86_400_000));

async function novoContrato(planoId = planId, nome = `Cond ${tag}-${Math.random().toString(36).slice(2, 6)}`) {
  const s = (await call(admin, 'POST', '/api/subscribers', { name: nome })).body;
  const k = (await call(admin, 'POST', '/api/contracts', { subscriber_id: s.id, plan_id: planoId, due_day: 10 })).body;
  return { sub: s, id: k.id as string, body: k };
}
const invoicesOf = async (contractId: string) => (await call(admin, 'GET', `/api/invoices?contract_id=${contractId}&limit=100`)).body as any[];

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  noc = await login('noc@alfa.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  planId = (await call(admin, 'POST', '/api/plans', { name: `Plano cond ${tag}`, price_cents: 10000, down_kbps: 100000, up_kbps: 50000, profile_name: `cd${tag}` })).body.id;
  plan2Id = (await call(admin, 'POST', '/api/plans', { name: `Plano cond B ${tag}`, price_cents: 15000, down_kbps: 200000, up_kbps: 100000, profile_name: `cdb${tag}` })).body.id;
});
afterAll(async () => {
  // não deixar fatura de competência futura nem multa em aberto para os outros arquivos
  await withScope({ tenantId, operator: false }, (c) =>
    c.query(`update invoices set status = 'canceled', canceled_at = now(), status_note = 'limpeza do teste' where status = 'open' and (competence >= '2031-01-01' or id in
             (select i.id from invoices i join contracts k on k.id = i.contract_id join subscribers s on s.id = k.subscriber_id where s.name like $1))`, [`Cond ${tag}%`]));
});

describe('desconto na mensalidade', () => {
  it('percentual por prazo, mês gratuito sem fatura e cancelamento; exige permissão e valida', async () => {
    const k = await novoContrato();
    const dsc = (b: object) => call(admin, 'POST', `/api/contracts/${k.id}/discounts`, b);
    expect((await call(noc, 'POST', `/api/contracts/${k.id}/discounts`, { kind: 'percent', value: 10, reason: 'promoção' })).status).toBe(403);
    expect((await dsc({ kind: 'percent', value: 101, reason: 'promoção' })).status).toBe(400);
    expect((await dsc({ kind: 'percent', value: 10, reason: 'x' })).status).toBe(400);
    expect((await dsc({ kind: 'percent', value: 10, reason: 'Promoção de boas-vindas', from_competence: '2031-03-01', months: 2 })).status).toBe(200);

    expect((await call(admin, 'POST', '/api/finance/generate', { competence: '2031-03' })).status).toBe(200);
    const mar = (await invoicesOf(k.id)).find((i) => String(i.competence).startsWith('2031-03'));
    expect(mar.amount_cents).toBe(9000);                                                 // 10000 − 10%
    const det = (await call(admin, 'GET', `/api/invoices/${mar.id}`)).body;
    const itens = (det.items ?? []).map((x: any) => x.amount_cents).sort((a: number, b: number) => a - b);
    expect(itens).toEqual([-1000, 10000]);
    expect((det.items ?? []).some((x: any) => /Promoção de boas-vindas/.test(x.description))).toBe(true);

    await call(admin, 'POST', '/api/finance/generate', { competence: '2031-04' });
    expect((await invoicesOf(k.id)).find((i) => String(i.competence).startsWith('2031-04')).amount_cents).toBe(9000);
    await call(admin, 'POST', '/api/finance/generate', { competence: '2031-05' });
    expect((await invoicesOf(k.id)).find((i) => String(i.competence).startsWith('2031-05')).amount_cents).toBe(10000);   // prazo acabou

    // mês totalmente descontado não gera fatura (valor zero não é cobrança)
    const livre = (await dsc({ kind: 'fixed', value: 10000, reason: 'Mês grátis', from_competence: '2031-06-01', months: 1 })).body;
    await call(admin, 'POST', '/api/finance/generate', { competence: '2031-06' });
    expect((await invoicesOf(k.id)).some((i) => String(i.competence).startsWith('2031-06'))).toBe(false);
    // cancelado, volta ao normal
    expect((await call(admin, 'DELETE', `/api/discounts/${livre.id}`)).status).toBe(200);
    await call(admin, 'POST', '/api/finance/generate', { competence: '2031-07' });
    expect((await invoicesOf(k.id)).find((i) => String(i.competence).startsWith('2031-07')).amount_cents).toBe(10000);
    expect((await call(admin, 'GET', `/api/contracts/${k.id}/discounts`)).body).toHaveLength(2);
  });
});

describe('fidelidade e multa rescisória', () => {
  it('plano define o padrão; encerrar dentro da carência exige decidir; cobrar gera fatura, dispensar exige motivo', async () => {
    expect((await call(admin, 'PUT', `/api/plans/${planId}/loyalty`, { months: 12 })).status).toBe(400);              // sem modelo
    expect((await call(admin, 'PUT', `/api/plans/${planId}/loyalty`, { months: 12, penalty_model: 'fixed', penalty_cents: 30000 })).status).toBe(200);
    const k = await novoContrato();
    expect(k.body.loyalty_until).toBeTruthy();                                                                          // copiado do plano
    const q = (await call(admin, 'GET', `/api/contracts/${k.id}/termination-quote`)).body;
    expect(q).toMatchObject({ within_loyalty: true, penalty_cents: 30000, penalty_model: 'fixed' });
    expect(q.remaining_months).toBeGreaterThanOrEqual(11);

    const end = (b: object) => call(admin, 'PATCH', `/api/contracts/${k.id}`, { end: true, ...b });
    const sem = await end({});
    expect(sem.status).toBe(409);
    expect(sem.body.code).toBe('penalty_decision_required');
    expect((await end({ penalty: 'waive' })).status).toBe(400);                                                        // dispensar sem motivo
    const ok = await end({ penalty: 'charge', penalty_due_days: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ended');
    const fat = (await invoicesOf(k.id)).find((i) => i.kind === 'manual' && i.status === 'open');
    expect(fat.amount_cents).toBe(30000);
    expect(String(fat.due_date).slice(0, 10)).toBe(day(5));
    const hist = (await call(admin, 'GET', `/api/contracts/${k.id}`)).body.history.map((h: any) => h.event);
    expect(hist).toContain('penalty_charged');
  });

  it('multa por mês restante, dispensa com motivo na história; contrato fora da carência encerra sem decisão', async () => {
    const k = await novoContrato();
    expect((await call(admin, 'PUT', `/api/contracts/${k.id}/loyalty`, { months: 6, penalty_model: 'monthly', penalty_cents: 2000 })).status).toBe(200);
    const q = (await call(admin, 'GET', `/api/contracts/${k.id}/termination-quote`)).body;
    expect(q.penalty_cents).toBe(2000 * q.remaining_months);
    expect(q.remaining_months).toBeGreaterThanOrEqual(5);
    // cotação em data futura depois da carência não tem multa
    expect((await call(admin, 'GET', `/api/contracts/${k.id}/termination-quote?date=${day(400)}`)).body).toMatchObject({ within_loyalty: false, penalty_cents: 0 });
    const w = await call(admin, 'PATCH', `/api/contracts/${k.id}`, { end: true, penalty: 'waive', penalty_waive_reason: 'cortesia da diretoria' });
    expect(w.status).toBe(200);
    expect((await invoicesOf(k.id)).some((i) => i.kind === 'manual')).toBe(false);
    const h = (await call(admin, 'GET', `/api/contracts/${k.id}`)).body.history;
    expect(h.find((x: any) => x.event === 'penalty_waived').detail).toMatchObject({ reason: 'cortesia da diretoria', amount_cents: q.penalty_cents });

    const livre = await novoContrato(plan2Id);          // plano B sem fidelidade
    expect((await call(admin, 'PATCH', `/api/contracts/${livre.id}`, { end: true })).status).toBe(200);
    // remover a carência
    const k2 = await novoContrato();
    await call(admin, 'PUT', `/api/contracts/${k2.id}/loyalty`, { months: 3, penalty_model: 'fixed', penalty_cents: 1000 });
    expect((await call(admin, 'PUT', `/api/contracts/${k2.id}/loyalty`, { months: null })).body.loyalty_until).toBeNull();
    expect((await call(admin, 'PATCH', `/api/contracts/${k2.id}`, { end: true })).status).toBe(200);
  });
});

describe('mudança agendada e aditivos', () => {
  it('valida a data, não duplica, cancela, aplica na data pelo sistema e registra falha com motivo', async () => {
    const k = await novoContrato(plan2Id);
    const ag = (b: object) => call(admin, 'POST', `/api/contracts/${k.id}/scheduled-changes`, b);
    expect((await ag({ kind: 'plan_change', plan_id: planId, effective_date: day(0) })).status).toBe(400);              // hoje não é futuro
    expect((await ag({ kind: 'plan_change', effective_date: day(5) })).status).toBe(400);                               // sem plano
    const a = await ag({ kind: 'plan_change', plan_id: planId, effective_date: day(5) });
    expect(a.status).toBe(200);
    expect((await ag({ kind: 'plan_change', plan_id: planId, effective_date: day(5) })).status).toBe(409);
    const b = (await ag({ kind: 'due_day', due_day: 20, effective_date: day(6) })).body;
    expect((await call(admin, 'DELETE', `/api/scheduled-changes/${b.id}`)).status).toBe(200);
    expect((await call(admin, 'DELETE', `/api/scheduled-changes/${b.id}`)).status).toBe(404);

    // ainda não chegou a data: nada muda
    expect((await applyScheduledChanges(tenantId)).applied).toBe(0);
    expect((await call(admin, 'GET', `/api/contracts/${k.id}`)).body.plan_name).toBe(`Plano cond B ${tag}`);
    // a data chega
    await withScope({ tenantId, operator: false }, (c) => c.query(`update scheduled_changes set effective_date = current_date - 1 where id = $1`, [a.body.id]));
    expect((await applyScheduledChanges(tenantId)).applied).toBeGreaterThanOrEqual(1);
    const c1 = (await call(admin, 'GET', `/api/contracts/${k.id}`)).body;
    expect(c1.plan_name).toBe(`Plano cond ${tag}`);
    expect(c1.history.some((h: any) => h.event === 'plan_changed')).toBe(true);
    expect((await call(admin, 'GET', `/api/contracts/${k.id}/scheduled-changes`)).body.find((s: any) => s.id === a.body.id).status).toBe('applied');

    // falha: plano desativado antes da data → "failed" com o motivo, sem derrubar as demais
    const k2 = await novoContrato(planId);
    const p3 = (await call(admin, 'POST', '/api/plans', { name: `Plano temp ${tag}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `tp${tag}` })).body.id;
    const f = (await call(admin, 'POST', `/api/contracts/${k2.id}/scheduled-changes`, { kind: 'plan_change', plan_id: p3, effective_date: day(3) })).body;
    await call(admin, 'PATCH', `/api/plans/${p3}`, { active: false });
    await withScope({ tenantId, operator: false }, (c) => c.query(`update scheduled_changes set effective_date = current_date - 1 where id = $1`, [f.id]));
    expect((await applyScheduledChanges(tenantId)).failed).toBeGreaterThanOrEqual(1);
    const fs = (await call(admin, 'GET', `/api/contracts/${k2.id}/scheduled-changes`)).body[0];
    expect(fs).toMatchObject({ status: 'failed' });
    expect(fs.error).toMatch(/inativo/);
  });

  it('encerramento agendado respeita a decisão sobre a multa registrada no agendamento', async () => {
    const k = await novoContrato();                                           // plano com fidelidade de 12 meses (definida acima ou não)
    await call(admin, 'PUT', `/api/contracts/${k.id}/loyalty`, { months: 12, penalty_model: 'fixed', penalty_cents: 12345 });
    const s = (await call(admin, 'POST', `/api/contracts/${k.id}/scheduled-changes`, { kind: 'end', effective_date: day(2), penalty: 'charge', note: 'pedido por telefone' })).body;
    await withScope({ tenantId, operator: false }, (c) => c.query(`update scheduled_changes set effective_date = current_date - 1 where id = $1`, [s.id]));
    expect((await applyScheduledChanges(tenantId)).applied).toBeGreaterThanOrEqual(1);
    const c1 = (await call(admin, 'GET', `/api/contracts/${k.id}`)).body;
    expect(c1.status).toBe('ended');
    expect(c1.end_note).toBe('pedido por telefone');
    expect((await invoicesOf(k.id)).find((i) => i.kind === 'manual').amount_cents).toBe(12345);
  });

  it('aditivo fica registrado e aparece no histórico; indicação não aceita o próprio assinante', async () => {
    const k = await novoContrato();
    expect((await call(admin, 'POST', `/api/contracts/${k.id}/amendments`, { kind: 'address', title: 'x', body: 'y' })).status).toBe(400);
    const a = (await call(admin, 'POST', `/api/contracts/${k.id}/amendments`, { kind: 'address', title: 'Mudança de endereço de instalação', body: 'Nova instalação na Rua B, 20', effective_date: day(1) })).body;
    expect((await call(admin, 'GET', `/api/contracts/${k.id}/amendments`)).body.map((x: any) => x.id)).toEqual([a.id]);
    expect((await call(admin, 'GET', `/api/contracts/${k.id}`)).body.history.some((h: any) => h.event === 'amendment')).toBe(true);

    const indicador = await novoContrato();
    expect((await call(admin, 'PUT', `/api/contracts/${k.id}/referral`, { referrer_subscriber_id: k.sub.id })).status).toBe(400);
    expect((await call(admin, 'PUT', `/api/contracts/${k.id}/referral`, { referrer_subscriber_id: indicador.sub.id })).status).toBe(200);
    const rep = (await call(admin, 'GET', '/api/reports/referrals')).body;
    expect(rep.find((r: any) => r.referrer_id === indicador.sub.id)).toMatchObject({ referred: 1, active: 1 });
  });
});
