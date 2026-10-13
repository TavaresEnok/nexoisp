import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withScope } from '../src/db.js';
import { runSla } from '../src/sla.js';
import { call, login } from './helpers.js';

// Lote 4: fluxo de status da OS com deslocamento, catálogos, SLA, agenda, endereço por serviço e pesquisa de satisfação.
let admin: string, beta: string, tenantId: string, contract: any, tech: any, other: any;
const tag = String(Date.now()).slice(-6);
const dayAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const created: string[] = [];

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  tenantId = (await call(admin, 'GET', '/api/me')).body.tenant.id;
  contract = (await call(admin, 'GET', '/api/contracts?status=active')).body[0];
  const staff = (await call(admin, 'GET', '/api/staff')).body;
  tech = staff.find((s: any) => s.role === 'noc') ?? staff[0];
  other = staff.find((s: any) => s.id !== tech.id);
});

async function newOs(extra: object = {}) {
  const r = await call(admin, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: contract.subscriber_id, contract_id: contract.id, description: `Teste ${tag}`, ...extra });
  expect(r.status).toBe(200);
  created.push(r.body.id);
  return r.body;
}
const status = (id: string, body: object) => call(admin, 'POST', `/api/work-orders/${id}/status`, body);

afterAll(async () => {
  // encerra o que o teste abriu para não poluir filas de outros arquivos
  for (const id of created) await status(id, { status: 'canceled', resolution: 'limpeza do teste' });
});

describe('fluxo de status da OS', () => {
  it('análise → aguardando agendamento → agendada → deslocamento → execução → concluída, com marcas de tempo e pesquisa', async () => {
    const w = await newOs();
    expect(w.status).toBe('open');
    expect((await status(w.id, { status: 'analysis' })).status).toBe(200);
    const esperando = await status(w.id, { status: 'awaiting_schedule', reason: 'cliente viaja até segunda' });
    expect(esperando.body).toMatchObject({ status: 'awaiting_schedule', awaiting_reason: 'cliente viaja até segunda', scheduled_for: null });
    // agendar a partir de "aguardando agendamento" pela alteração da data
    const quando = new Date(Date.now() + 3 * 86_400_000).toISOString();
    expect((await call(admin, 'PATCH', `/api/work-orders/${w.id}`, { scheduled_for: quando })).body.status).toBe('scheduled');
    // deslocamento exige técnico
    expect((await status(w.id, { status: 'en_route' })).status).toBe(400);
    expect((await call(admin, 'PATCH', `/api/work-orders/${w.id}`, { assignee_id: tech.id })).status).toBe(200);
    const ida = (await status(w.id, { status: 'en_route' })).body;
    expect(ida.status).toBe('en_route');
    expect(ida.en_route_at).toBeTruthy();
    const exec = (await status(w.id, { status: 'in_progress' })).body;
    expect(exec.started_at).toBeTruthy();
    // concluir exige o que foi feito
    expect((await status(w.id, { status: 'done' })).status).toBe(400);
    const fim = await status(w.id, { status: 'done', resolution: 'Trocado o conector' });
    expect(fim.body.status).toBe('done');
    // estado final não volta
    expect((await status(w.id, { status: 'open' })).status).toBe(400);
    // a pesquisa de satisfação nasce ao concluir e aparece na lista da equipe
    const sv = (await call(admin, 'GET', '/api/surveys?status=pending')).body;
    expect(sv.rows.some((r: any) => r.work_order_number === w.number)).toBe(true);
    // a linha do tempo registra o deslocamento
    const det = (await call(admin, 'GET', `/api/work-orders/${w.id}`)).body;
    expect(det.events.filter((e: any) => e.event === 'status').map((e: any) => e.detail.to).reverse())
      .toEqual(['analysis', 'awaiting_schedule', 'en_route', 'in_progress', 'done']);
  });

  it('a fila "pendentes" inclui os novos estados e o filtro por estado funciona', async () => {
    const w = await newOs();
    await status(w.id, { status: 'analysis' });
    const pend = (await call(admin, 'GET', '/api/work-orders?status=pending&limit=500')).body;
    expect(pend.some((x: any) => x.id === w.id)).toBe(true);
    const so = (await call(admin, 'GET', '/api/work-orders?status=analysis&limit=500')).body;
    expect(so.every((x: any) => x.status === 'analysis')).toBe(true);
    expect((await status(w.id, { status: 'bogus' })).status).toBe(400);
  });
});

describe('catálogos e SLA', () => {
  it('catálogo: nome único por tipo, vínculo confere o tipo e item inativo não é aceito', async () => {
    const tipo = (await call(admin, 'POST', '/api/catalogs', { kind: 'ticket_type', name: `Sem sinal ${tag}` })).body;
    expect(tipo.id).toBeTruthy();
    expect((await call(admin, 'POST', '/api/catalogs', { kind: 'ticket_type', name: `Sem sinal ${tag}` })).status).toBe(409);
    const motivo = (await call(admin, 'POST', '/api/catalogs', { kind: 'os_reason', name: `Troca de equipamento ${tag}` })).body;
    // motivo de OS não serve como tipo de atendimento
    const t1 = await call(admin, 'POST', '/api/tickets', { subscriber_id: contract.subscriber_id, subject: `Tipo errado ${tag}`, category: 'other', body: 'x', type_id: motivo.id });
    expect(t1.status).toBe(400);
    const t2 = await call(admin, 'POST', '/api/tickets', { subscriber_id: contract.subscriber_id, subject: `Tipo certo ${tag}`, category: 'other', body: 'x', type_id: tipo.id });
    expect(t2.status).toBe(200);
    expect(t2.body.type_id).toBe(tipo.id);
    expect((await call(admin, 'PATCH', `/api/catalogs/${tipo.id}`, { active: false })).body.active).toBe(false);
    expect((await call(admin, 'POST', '/api/tickets', { subscriber_id: contract.subscriber_id, subject: `Inativo ${tag}`, category: 'other', body: 'x', type_id: tipo.id })).status).toBe(400);
    // motivo vira dado da OS
    const w = await newOs({ reason_id: motivo.id });
    expect((await call(admin, 'GET', `/api/work-orders/${w.id}`)).body.reason_name).toBe(`Troca de equipamento ${tag}`);
    // outro provedor não enxerga o catálogo
    expect((await call(beta, 'GET', '/api/catalogs?all=1')).body.some?.((x: any) => x.id === tipo.id) ?? false).toBe(false);
  });

  it('SLA: política mais específica vence, prazo vencido é marcado uma vez, escalona e entra no relatório', async () => {
    const geral = (await call(admin, 'POST', '/api/sla-policies', { name: `Geral ${tag}`, applies_to: 'ticket', resolution_minutes: 1440 })).body;
    const alta = (await call(admin, 'POST', '/api/sla-policies', { name: `Alta ${tag}`, applies_to: 'ticket', priority: 'high', resolution_minutes: 60, escalate_to: other.id })).body;
    expect(geral.id && alta.id).toBeTruthy();
    // política de OS não aceita prioridade; de atendimento não aceita natureza de OS
    expect((await call(admin, 'POST', '/api/sla-policies', { name: `Ruim ${tag}`, applies_to: 'work_order', priority: 'high', resolution_minutes: 60 })).status).toBe(400);
    expect((await call(admin, 'POST', '/api/sla-policies', { name: `Ruim2 ${tag}`, applies_to: 'ticket', kind: 'repair', resolution_minutes: 60 })).status).toBe(400);

    const tk = (await call(admin, 'POST', '/api/tickets', { subscriber_id: contract.subscriber_id, subject: `Urgente ${tag}`, category: 'other', priority: 'high', body: 'sem internet' })).body;
    expect(tk.sla_policy_id).toBe(alta.id);
    expect(new Date(tk.sla_due_at).getTime() - new Date(tk.created_at).getTime()).toBe(60 * 60_000);
    const normal = (await call(admin, 'POST', '/api/tickets', { subscriber_id: contract.subscriber_id, subject: `Normal ${tag}`, category: 'other', body: 'x' })).body;
    expect(normal.sla_policy_id).toBe(geral.id);
    // subir a prioridade recalcula a política
    expect((await call(admin, 'PATCH', `/api/tickets/${normal.id}`, { priority: 'high' })).body.sla_policy_id).toBe(alta.id);

    // vence o prazo: marca uma vez, escalona e avisa na linha do atendimento
    await withScope({ tenantId, operator: false }, (c) => c.query(`update tickets set sla_due_at = now() - interval '5 minutes' where id = $1`, [tk.id]));
    const r1 = await runSla(tenantId);
    expect(r1.tickets).toBeGreaterThanOrEqual(1);
    expect((await runSla(tenantId)).tickets).toBe(0);
    const det = (await call(admin, 'GET', `/api/tickets/${tk.id}`)).body;
    expect(det.sla_breached_at).toBeTruthy();
    expect(det.assignee_id).toBe(other.id);
    expect(det.thread.some((m: any) => m.internal && /SLA vencido/.test(m.body))).toBe(true);

    const rep = (await call(admin, 'GET', '/api/reports/sla')).body;
    const linha = rep.rows.find((x: any) => x.policy_id === alta.id);
    expect(linha.total).toBeGreaterThanOrEqual(2);
    expect(linha.breached).toBeGreaterThanOrEqual(1);
    // política em uso não é excluída
    expect((await call(admin, 'DELETE', `/api/sla-policies/${alta.id}`)).status).toBe(409);
    for (const p of [geral, alta]) await call(admin, 'PATCH', `/api/sla-policies/${p.id}`, { active: false });
    await call(admin, 'POST', `/api/tickets/${tk.id}/status`, { status: 'closed' });
    await call(admin, 'POST', `/api/tickets/${normal.id}/status`, { status: 'closed' });
  });

  it('SLA de OS por natureza: prazo vencido marca a OS e registra evento', async () => {
    const p = (await call(admin, 'POST', '/api/sla-policies', { name: `Instalação ${tag}`, applies_to: 'work_order', kind: 'install', resolution_minutes: 120 })).body;
    const w = await newOs({ kind: 'install' });
    expect(w.sla_policy_id).toBe(p.id);
    await withScope({ tenantId, operator: false }, (c) => c.query(`update work_orders set sla_due_at = now() - interval '1 minute' where id = $1`, [w.id]));
    expect((await runSla(tenantId)).work_orders).toBeGreaterThanOrEqual(1);
    const det = (await call(admin, 'GET', `/api/work-orders/${w.id}`)).body;
    expect(det.sla_breached).toBe(true);
    expect(det.events.some((e: any) => e.event === 'sla_breached')).toBe(true);
    await call(admin, 'PATCH', `/api/sla-policies/${p.id}`, { active: false });
  });
});

describe('agenda e endereço', () => {
  it('agenda agrupa por técnico, aponta sobreposição e calcula janelas livres', async () => {
    const d = dayAhead(20);
    const a = await newOs({ assignee_id: tech.id, scheduled_for: `${d}T13:00:00Z`, estimated_minutes: 60 });
    const b = await newOs({ assignee_id: tech.id, scheduled_for: `${d}T13:30:00Z`, estimated_minutes: 60 });
    const ag = (await call(admin, 'GET', `/api/agenda?date=${d}&assignee_id=${tech.id}`)).body;
    expect(ag.technicians).toHaveLength(1);
    const items = ag.technicians[0].items;
    expect(items.map((i: any) => i.number)).toEqual([a.number, b.number]);
    expect(items.map((i: any) => i.conflict)).toEqual([false, true]);
    // expediente 8h–18h locais (UTC-3): ocupado 10:00–11:30
    const free = (await call(admin, 'GET', `/api/agenda/free?assignee_id=${tech.id}&date=${d}&minutes=60`)).body.free;
    expect(free).toEqual([
      { from: `${d}T11:00:00.000Z`, to: `${d}T13:00:00.000Z` },
      { from: `${d}T14:30:00.000Z`, to: `${d}T21:00:00.000Z` },
    ]);
    expect((await call(admin, 'GET', `/api/agenda/free?assignee_id=${tech.id}&date=${d}&from_hour=10&to_hour=9`)).status).toBe(400);
    expect((await call(admin, 'GET', '/api/agenda?date=amanha')).status).toBe(400);
    // aguardando agendamento aparece na lista própria
    const w = await newOs();
    await status(w.id, { status: 'awaiting_schedule', reason: 'sem horário' });
    const ag2 = (await call(admin, 'GET', `/api/agenda?date=${d}`)).body;
    expect(ag2.awaiting_schedule.some((x: any) => x.id === w.id)).toBe(true);
  });

  it('endereço por serviço: OS usa o endereço do contrato quando pedido e guarda a origem', async () => {
    // sem endereço de instalação, não dá para usar o do contrato
    const sem = await call(admin, 'POST', '/api/work-orders', { kind: 'install', subscriber_id: contract.subscriber_id, contract_id: contract.id, description: `Sem end ${tag}`, address_origin: 'contract' });
    if (sem.status === 200) created.push(sem.body.id);
    const put = await call(admin, 'PUT', `/api/contracts/${contract.id}/install-address`, { street: 'Rua da Instalação', number: '77', district: 'Centro', city: 'Campinas', state: 'SP', zip: '13000000' });
    expect(put.status).toBe(200);
    const w = await newOs({ address_origin: 'contract' });
    expect(w).toMatchObject({ address_origin: 'contract', address_text: 'Rua da Instalação, 77, Centro, Campinas' });
    expect((await call(admin, 'GET', `/api/work-orders/${w.id}`)).body.service_address).toBe('Rua da Instalação, 77, Centro, Campinas');
    // mudar o cadastro depois não altera a OS aberta
    await call(admin, 'PUT', `/api/contracts/${contract.id}/install-address`, { street: 'Outra Rua', number: '1', city: 'Jundiaí' });
    expect((await call(admin, 'GET', `/api/work-orders/${w.id}`)).body.service_address).toBe('Rua da Instalação, 77, Centro, Campinas');
    // manual exige texto
    expect((await call(admin, 'POST', '/api/work-orders', { kind: 'install', subscriber_id: contract.subscriber_id, description: 'x y z', address_origin: 'manual' })).status).toBe(400);
    const man = await newOs({ address_origin: 'manual', address_text: 'Sítio Boa Vista, km 3' });
    expect(man.address_text).toBe('Sítio Boa Vista, km 3');
    // limpa para não afetar outros arquivos
    await call(admin, 'PUT', `/api/contracts/${contract.id}/install-address`, {});
    expect(sem.status).toBe(400);
  });
});

describe('pesquisa de satisfação pelo portal', () => {
  it('o assinante responde uma vez; não vê nem responde a de outro; a equipe vê a nota', async () => {
    const k = (await call(admin, 'GET', '/api/contracts?status=active')).body.find((c: any) => c.id === contract.id);
    const email = `pesq-${tag}@teste.local`;
    expect((await call(admin, 'POST', `/api/subscribers/${k.subscriber_id}/portal-access`, { email, password: 'demo1234' })).status).toBe(200);
    const sub = await login(email);
    const w = await newOs();
    await status(w.id, { status: 'in_progress' });
    await status(w.id, { status: 'done', resolution: 'Resolvido' });
    const pend = (await call(sub, 'GET', '/api/portal/surveys')).body;
    const s = pend.find((x: any) => x.work_order_number === w.number);
    expect(s).toBeTruthy();
    expect((await call(sub, 'POST', `/api/portal/surveys/${s.id}`, { score: 9 })).status).toBe(400);
    expect((await call(sub, 'POST', `/api/portal/surveys/${s.id}`, { score: 5, comment: 'Rápido e educado' })).status).toBe(200);
    expect((await call(sub, 'POST', `/api/portal/surveys/${s.id}`, { score: 1 })).status).toBe(409);
    expect((await call(sub, 'GET', '/api/portal/surveys')).body.some((x: any) => x.id === s.id)).toBe(false);
    const lista = (await call(admin, 'GET', '/api/surveys?status=answered')).body;
    expect(lista.rows.find((r: any) => r.work_order_number === w.number)).toMatchObject({ score: 5, comment: 'Rápido e educado', status: 'answered' });
    expect(lista.summary.answered).toBeGreaterThanOrEqual(1);
    // o portal não alcança a lista da equipe
    expect((await call(sub, 'GET', '/api/surveys')).status).toBe(403);
  });
});
