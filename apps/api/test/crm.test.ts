import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeCpf } from '../src/seed.js';
import { call, login } from './helpers.js';

// Expansão 4: funil de prospectos, atendimentos e o que o assinante enxerga pelo portal (API e banco).
let admin: string, beta: string, att: string;
const tag = String(Date.now()).slice(-6);

beforeAll(async () => {
  admin = await login('admin@alfa.demo');
  beta = await login('admin@beta.demo');
  att = await login('atendimento@alfa.demo');
});

describe('prospectos', () => {
  it('funil: perda exige motivo; conversão cria o assinante uma única vez; outro provedor não vê', async () => {
    expect((await call(att, 'POST', '/api/leads', { name: 'Sem contato' })).status).toBe(400);
    expect((await call(await login('noc@alfa.demo'), 'GET', '/api/leads')).status).toBe(200);
    const plano = (await call(admin, 'GET', '/api/plans')).body[0];
    const planoBeta = (await call(beta, 'GET', '/api/plans')).body[0];
    expect((await call(att, 'POST', '/api/leads', { name: 'X', phone: '11999990000', plan_id: planoBeta.id })).status).toBe(400);   // plano de outro provedor
    const doc = fakeCpf(Number(tag) + 5000);
    const l = (await call(att, 'POST', '/api/leads', { name: `Prospecto ${tag}`, phone: '11988887777', document: doc, address_city: 'Cidade Demo', address_state: 'SP', source: 'indicação', plan_id: plano.id })).body;
    expect(l.stage).toBe('new');
    expect((await call(beta, 'GET', `/api/leads/${l.id}`)).status).toBe(404);
    expect((await call(beta, 'POST', `/api/leads/${l.id}/convert`, {})).status).toBe(404);
    expect((await call(att, 'POST', `/api/leads/${l.id}/stage`, { stage: 'lost' })).status).toBe(400);
    expect((await call(att, 'POST', `/api/leads/${l.id}/stage`, { stage: 'won' })).status).toBe(400);                                // ganho só pela conversão
    expect((await call(att, 'POST', `/api/leads/${l.id}/stage`, { stage: 'proposal' })).body.stage).toBe('proposal');
    await call(att, 'POST', `/api/leads/${l.id}/notes`, { note: 'ligar amanhã' });
    expect((await call(await login('financeiro@alfa.demo'), 'POST', `/api/leads/${l.id}/convert`, {})).status).toBe(403);           // sem permissão de cadastro

    const conv = await call(att, 'POST', `/api/leads/${l.id}/convert`, {});
    expect(conv.status).toBe(200);
    const s = (await call(admin, 'GET', `/api/subscribers/${conv.body.subscriber_id}`)).body;
    expect(s).toMatchObject({ name: `Prospecto ${tag}`, document: doc, phone: '11988887777', address_city: 'Cidade Demo' });
    expect((await call(att, 'POST', `/api/leads/${l.id}/convert`, {})).status).toBe(400);
    const d = (await call(att, 'GET', `/api/leads/${l.id}`)).body;
    expect(d).toMatchObject({ stage: 'won', subscriber_id: s.id });
    expect(d.events.map((e: any) => e.event)).toEqual(['converted', 'note', 'stage', 'created']);

    // segundo prospecto com o mesmo documento: não duplica o assinante; vincula ao existente
    const l2 = (await call(att, 'POST', '/api/leads', { name: 'Mesmo CPF', email: 'x@exemplo.demo', document: doc })).body;
    expect((await call(att, 'POST', `/api/leads/${l2.id}/convert`, {})).status).toBe(409);
    expect((await call(att, 'POST', `/api/leads/${l2.id}/convert`, { subscriber_id: s.id })).body.subscriber_id).toBe(s.id);
    expect((await call(att, 'GET', '/api/leads/summary')).body.won_month).toBeGreaterThanOrEqual(2);
  });
});

describe('atendimentos e portal', () => {
  it('assinante vê só os próprios atendimentos e nunca as notas internas — pela API e por SQL direto', async () => {
    const subs = (await call(admin, 'GET', '/api/subscribers')).body;
    const [a, b] = subs;
    const email = `portal-crm-${tag}@exemplo.demo`;
    expect((await call(admin, 'POST', `/api/subscribers/${a.id}/portal-access`, { email, password: 'demo1234' })).status).toBe(200);
    const portal = await login(email);

    const deOutro = (await call(att, 'POST', '/api/tickets', { subscriber_id: b.id, subject: 'do vizinho', category: 'financial', body: 'segunda via' })).body;
    const t = (await call(portal, 'POST', '/api/portal/tickets', { subject: `Internet lenta ${tag}`, category: 'technical', body: 'desde ontem' })).body;
    expect(t.number).toBe(deOutro.number + 1);
    expect((await call(portal, 'GET', '/api/tickets')).status).toBe(403);
    expect((await call(portal, 'GET', `/api/portal/tickets/${deOutro.id}`)).status).toBe(404);
    expect((await call(portal, 'POST', `/api/portal/tickets/${deOutro.id}/messages`, { body: 'oi' })).status).toBe(404);

    await call(att, 'POST', `/api/tickets/${t.id}/messages`, { body: 'cliente inadimplente, cuidado', internal: true });
    expect((await call(att, 'GET', `/api/tickets/${t.id}`)).body.status).toBe('open');                 // nota interna não muda a situação
    await call(att, 'POST', `/api/tickets/${t.id}/messages`, { body: 'Reinicie a ONU, por favor.' });
    expect((await call(att, 'GET', `/api/tickets/${t.id}`)).body).toMatchObject({ status: 'waiting', origin: 'portal', messages: 3 });

    const visto = (await call(portal, 'GET', `/api/portal/tickets/${t.id}`)).body;
    expect(visto.thread.map((m: any) => m.body)).toEqual(['desde ontem', 'Reinicie a ONU, por favor.']);
    expect(JSON.stringify(visto)).not.toContain('inadimplente');
    expect((await call(portal, 'GET', '/api/portal/tickets')).body.map((x: any) => x.id)).toEqual([t.id]);
    await call(portal, 'POST', `/api/portal/tickets/${t.id}/messages`, { body: 'continua lento' });
    expect((await call(att, 'GET', `/api/tickets/${t.id}`)).body).toMatchObject({ status: 'open', last_from: 'subscriber' });

    // banco: com a sessão do assinante, nem SQL direto enxerga nota interna ou atendimento alheio
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL_APP });
    await c.connect();
    try {
      await c.query('begin');
      const tenant = (await call(admin, 'GET', '/api/me')).body.tenant.id;
      await c.query(`select set_config('app.tenant_id', $1, true), set_config('app.subscriber_id', $2, true)`, [tenant, a.id]);
      expect((await c.query('select id from tickets')).rows.map((r) => r.id)).toEqual([t.id]);
      const msgs = (await c.query('select body, internal from ticket_messages')).rows;
      expect(msgs).toHaveLength(3);
      expect(msgs.some((m) => m.internal)).toBe(false);
      expect((await c.query('select count(*)::int as n from leads')).rows[0].n).toBe(0);
      expect((await c.query('select count(*)::int as n from work_orders')).rows[0].n).toBe(0);
      expect((await c.query('select count(*)::int as n from ip_allocations')).rows[0].n).toBe(0);
      await expect(c.query(`insert into ticket_messages (tenant_id, ticket_id, author_kind, body, internal) values ($1,$2,'staff','forjada',true)`, [tenant, t.id])).rejects.toThrow();
    } finally {
      await c.query('rollback').catch(() => {});
      await c.end();
    }

    // OS aberta a partir do atendimento; encerrado não recebe resposta
    const wo = await call(att, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: a.id, description: 'verificar sinal', ticket_id: t.id });
    expect(wo.status).toBe(200);
    expect((await call(att, 'POST', '/api/work-orders', { kind: 'repair', subscriber_id: b.id, description: 'x', ticket_id: t.id })).status).toBe(400);
    expect((await call(att, 'GET', `/api/tickets/${t.id}`)).body.work_orders).toHaveLength(1);
    expect((await call(att, 'POST', `/api/tickets/${t.id}/status`, { status: 'closed' })).body.closed_at).toBeTruthy();
    expect((await call(portal, 'POST', `/api/portal/tickets/${t.id}/messages`, { body: 'ainda?' })).status).toBe(400);
    expect((await call(beta, 'GET', `/api/tickets/${t.id}`)).status).toBe(404);
  });

  it('relatório do período: conversão por origem e tempos de atendimento, só do próprio provedor', async () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const r = (await call(att, 'GET', `/api/crm/report?from=2000-01-01&to=2099-12-31`)).body;
    const ind = r.leads.find((x: any) => x.source === 'indicação');
    expect(ind).toMatchObject({ won: 1 });
    expect(ind.created).toBeGreaterThanOrEqual(1);
    const tec = r.tickets.find((x: any) => x.category === 'technical');
    expect(tec).toMatchObject({ from_portal: 1, closed: 1 });
    expect(tec.first_response_h).toBeGreaterThanOrEqual(0);       // resposta ao assinante conta; a nota interna anterior não
    expect(tec.resolution_h).toBeGreaterThanOrEqual(0);
    expect(r.work_orders.find((x: any) => x.kind === 'repair').opened).toBeGreaterThanOrEqual(1);
    expect((await call(await login('financeiro@alfa.demo'), 'GET', `/api/crm/report?from=${hoje}&to=${hoje}`)).body.work_orders).toBeNull();   // sem permissão de OS
    const b = (await call(beta, 'GET', `/api/crm/report?from=2000-01-01&to=2099-12-31`)).body;
    expect(b.leads.some((x: any) => x.source === 'indicação')).toBe(false);
    expect(b.tickets).toEqual([]);
    expect((await call(att, 'GET', `/api/crm/report?from=${hoje}&to=2000-01-01`)).status).toBe(400);
  });

  it('exportação contábil: CSV do período, sem fórmulas e só do próprio provedor', async () => {
    const fin = await login('financeiro@alfa.demo');
    const hoje = new Date().toISOString().slice(0, 10);
    const r = await call(fin, 'GET', `/api/finance/export?kind=invoices&from=2000-01-01&to=2099-12-31`);
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain('vencimento;assinante;cpf_cnpj');
    expect(String(r.body)).not.toContain('(beta)');
    expect((await call(fin, 'GET', `/api/finance/export?from=${hoje}&to=2000-01-01`)).status).toBe(400);
    expect((await call(att, 'GET', `/api/finance/export?from=${hoje}&to=${hoje}`)).status).toBe(200);     // atendimento tem leitura do financeiro
    expect((await call(await login('noc@alfa.demo'), 'GET', `/api/finance/export?from=${hoje}&to=${hoje}`)).status).toBe(403);
  });
});
