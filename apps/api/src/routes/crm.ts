import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError, type Ctx } from '../auth.js';
import { nextNumber, paged, withScope, type Tx } from '../db.js';
import { assertSafeWebhookUrl, deliverNotifications, queueNotice, sendTestNotice } from '../notify.js';
import { zDate, zDocument, zPage, zSubscriber, zUuid } from '../validators.js';

/** Expansão 4: CRM — prospectos (funil) e atendimentos (protocolos), inclusive abertos pelo assinante no portal. */
const optText = (max = 200) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const zText = (max: number) => z.string().trim().min(1).max(max);
const LEAD_COLS = ['name', 'phone', 'email', 'document', 'address_street', 'address_number', 'address_district', 'address_city', 'address_state', 'address_zip',
  'source', 'plan_id', 'notes', 'owner_id'] as const;
const zLead = z.object({
  name: z.string().trim().min(2, 'nome obrigatório').max(200), phone: optText(40),
  email: z.string().trim().email('e-mail inválido').max(200).nullish().or(z.literal('')).transform((v) => v || null),
  document: zDocument,
  address_street: optText(), address_number: optText(20), address_district: optText(), address_city: optText(), address_state: optText(2), address_zip: optText(12),
  source: optText(80), plan_id: zUuid.nullish().transform((v) => v ?? null), notes: optText(2000), owner_id: zUuid.nullish().transform((v) => v ?? null),
});
const LEAD_SELECT = `
  select l.*, p.name as plan_name, o.name as owner_name, s.name as subscriber_name
  from leads l left join plans p on p.id = l.plan_id left join users o on o.id = l.owner_id left join subscribers s on s.id = l.subscriber_id`;
const TICKET_SELECT = `
  select t.*, s.name as subscriber_name, a.name as assignee_name,
         (select count(*) from ticket_messages m where m.ticket_id = t.id) as messages,
         (select m.author_kind from ticket_messages m where m.ticket_id = t.id and not m.internal order by m.id desc limit 1) as last_from
  from tickets t join subscribers s on s.id = t.subscriber_id left join users a on a.id = t.assignee_id`;
const MESSAGES = `select m.id, m.at, m.author_kind, m.body, m.internal, u.name as author_name from ticket_messages m left join users u on u.id = m.author_id where m.ticket_id = $1 order by m.id`;
const zCategory = z.enum(['technical', 'financial', 'commercial', 'other']);

async function staff(c: Tx, id: string | null) {
  if (id && !(await c.query(`select 1 from users where id = $1 and active and role <> 'subscriber'`, [id])).rowCount) throw new HttpError(400, 'responsável não encontrado neste provedor');
}
const leadEvent = (c: Tx, ctx: Ctx, id: string, event: string, detail: object = {}) =>
  c.query(`insert into lead_events (tenant_id, lead_id, actor_id, event, detail) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, id, ctx.userId, event, JSON.stringify(detail)]);

async function openTicket(c: Tx, ctx: Ctx, t: { subscriber_id: string; contract_id: string | null; subject: string; category: string; priority: string; body: string; origin: 'staff' | 'portal' }) {
  const number = await nextNumber(c, ctx.tenantId!, 'ticket');
  const row = (await c.query(
    `insert into tickets (tenant_id, number, subscriber_id, contract_id, subject, category, priority, origin, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [ctx.tenantId, number, t.subscriber_id, t.contract_id, t.subject, t.category, t.priority, t.origin, ctx.userId])).rows[0];
  await c.query(`insert into ticket_messages (tenant_id, ticket_id, author_id, author_kind, body) values ($1,$2,$3,$4,$5)`,
    [ctx.tenantId, row.id, ctx.userId, t.origin === 'portal' ? 'subscriber' : 'staff', t.body]);
  return row;
}

export async function crmRoutes(app: FastifyInstance) {
  // ---- Prospectos ----
  app.get('/api/leads', { preHandler: guard('crm:read') }, async (req, reply) => {
    const q = z.object({ stage: z.enum(['new', 'contacted', 'proposal', 'won', 'lost', 'open']).optional(), q: z.string().trim().max(100).optional(), ...zPage }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      paged(c, reply,
        `${LEAD_SELECT} where ($1::text is null or (case when $1 = 'open' then l.stage in ('new','contacted','proposal') else l.stage = $1 end))
           and ($2::text is null or l.name ilike '%'||$2||'%' or l.phone like '%'||$2||'%' or l.email ilike '%'||$2||'%')
         order by l.updated_at desc, l.id`, [q.stage ?? null, q.q || null], q));
  });

  app.get('/api/leads/summary', { preHandler: guard('crm:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select count(*) filter (where stage = 'new') as new, count(*) filter (where stage = 'contacted') as contacted, count(*) filter (where stage = 'proposal') as proposal,
                count(*) filter (where stage = 'won' and updated_at >= date_trunc('month', now())) as won_month,
                count(*) filter (where stage = 'lost' and updated_at >= date_trunc('month', now())) as lost_month from leads`)).rows[0]));

  app.get('/api/leads/:id', { preHandler: guard('crm:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const l = (await c.query(`${LEAD_SELECT} where l.id = $1`, [id])).rows[0];
      if (!l) throw new HttpError(404, 'prospecto não encontrado');
      l.events = (await c.query(`select e.at, e.event, e.detail, u.name as actor_name from lead_events e left join users u on u.id = e.actor_id where e.lead_id = $1 order by e.id desc`, [id])).rows;
      return l;
    });
  });

  app.post('/api/leads', { preHandler: guard('crm:write') }, async (req) => {
    const b = zLead.parse(req.body) as Record<string, unknown>;
    if (!b.phone && !b.email) throw new HttpError(400, 'informe telefone ou e-mail para contato');
    return withScope(req.ctx.scope, async (c) => {
      await staff(c, b.owner_id as string | null);
      const l = (await c.query(
        `insert into leads (tenant_id, created_by, ${LEAD_COLS.join(', ')}) values ($1, $2, ${LEAD_COLS.map((_, i) => `$${i + 3}`).join(', ')}) returning *`,
        [req.ctx.tenantId, req.ctx.userId, ...LEAD_COLS.map((k) => b[k])])).rows[0];
      await leadEvent(c, req.ctx, l.id, 'created', { source: b.source });
      await audit(c, req.ctx, 'lead.create', 'lead', l.id);
      return l;
    });
  });

  app.patch('/api/leads/:id', { preHandler: guard('crm:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zLead.parse(req.body) as Record<string, unknown>;
    if (!b.phone && !b.email) throw new HttpError(400, 'informe telefone ou e-mail para contato');
    return withScope(req.ctx.scope, async (c) => {
      await staff(c, b.owner_id as string | null);
      const l = (await c.query(`update leads set ${LEAD_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`, [id, ...LEAD_COLS.map((k) => b[k])])).rows[0];
      if (!l) throw new HttpError(404, 'prospecto não encontrado');
      await audit(c, req.ctx, 'lead.update', 'lead', id);
      return l;
    });
  });

  // Etapas do funil. "Ganho" só acontece pela conversão em assinante.
  app.post('/api/leads/:id/stage', { preHandler: guard('crm:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ stage: z.enum(['new', 'contacted', 'proposal', 'lost']), lost_reason: zText(300).nullish() }).parse(req.body);
    if (b.stage === 'lost' && !b.lost_reason) throw new HttpError(400, 'informe o motivo da perda');
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query('select stage from leads where id = $1 for update', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'prospecto não encontrado');
      if (cur.stage === 'won') throw new HttpError(400, 'prospecto já convertido em assinante');
      const l = (await c.query(`update leads set stage = $2, lost_reason = $3, updated_at = now() where id = $1 returning *`, [id, b.stage, b.stage === 'lost' ? b.lost_reason : null])).rows[0];
      await leadEvent(c, req.ctx, id, 'stage', { from: cur.stage, to: b.stage, reason: b.lost_reason ?? undefined });
      await audit(c, req.ctx, 'lead.stage', 'lead', id, { to: b.stage });
      return l;
    });
  });

  app.post('/api/leads/:id/notes', { preHandler: guard('crm:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ note: zText(2000) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('update leads set updated_at = now() where id = $1', [id])).rowCount) throw new HttpError(404, 'prospecto não encontrado');
      await leadEvent(c, req.ctx, id, 'note', { note: b.note });
      return { ok: true };
    });
  });

  /** Converte em assinante (cadastro novo com os dados do prospecto) ou vincula a um assinante existente. Não cria contrato. */
  app.post('/api/leads/:id/convert', { preHandler: guard('crm:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ subscriber_id: zUuid.nullish() }).parse(req.body ?? {});
    if (!req.ctx.perms.includes('subscribers:write')) throw new HttpError(403, 'sem permissão para cadastrar assinantes');
    return withScope(req.ctx.scope, async (c) => {
      const l = (await c.query('select * from leads where id = $1 for update', [id])).rows[0];
      if (!l) throw new HttpError(404, 'prospecto não encontrado');
      if (l.stage === 'won') throw new HttpError(400, 'prospecto já convertido em assinante');
      let subscriberId = b.subscriber_id ?? null;
      if (subscriberId) {
        if (!(await c.query('select 1 from subscribers where id = $1', [subscriberId])).rowCount) throw new HttpError(400, 'assinante não encontrado');
      } else {
        const s = zSubscriber.parse({ ...l, notes: l.notes, status: 'active' }) as Record<string, unknown>;
        if (s.document && (await c.query('select 1 from subscribers where document = $1', [s.document])).rowCount)
          throw new HttpError(409, 'já existe um assinante com este CPF/CNPJ: vincule o prospecto a ele');
        const cols = ['name', 'document', 'email', 'phone', 'address_street', 'address_number', 'address_district', 'address_city', 'address_state', 'address_zip', 'notes'];
        subscriberId = (await c.query(`insert into subscribers (tenant_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning id`,
          [req.ctx.tenantId, ...cols.map((k) => s[k])])).rows[0].id;
        await audit(c, req.ctx, 'subscriber.create', 'subscriber', subscriberId, { from_lead: id });
      }
      await c.query(`update leads set stage = 'won', subscriber_id = $2, lost_reason = null, updated_at = now() where id = $1`, [id, subscriberId]);
      await leadEvent(c, req.ctx, id, 'converted', { subscriber_id: subscriberId, linked_existing: !!b.subscriber_id });
      await audit(c, req.ctx, 'lead.convert', 'lead', id, { subscriber_id: subscriberId });
      return { subscriber_id: subscriberId };
    });
  });

  // ---- Atendimentos ----
  app.get('/api/tickets', { preHandler: guard('crm:read') }, async (req, reply) => {
    const q = z.object({ status: z.enum(['open', 'waiting', 'closed', 'pending']).optional(), q: z.string().trim().max(100).optional(),
      subscriber_id: zUuid.optional(), mine: z.enum(['1']).optional(), ...zPage }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      paged(c, reply,
        `${TICKET_SELECT} where ($1::text is null or (case when $1 = 'pending' then t.status <> 'closed' else t.status = $1 end))
           and ($2::text is null or s.name ilike '%'||$2||'%' or t.subject ilike '%'||$2||'%' or t.number::text = $2)
           and ($3::uuid is null or t.subscriber_id = $3) and ($4::uuid is null or t.assignee_id = $4)
         order by (t.status = 'closed'), t.updated_at desc, t.id`, [q.status ?? null, q.q || null, q.subscriber_id ?? null, q.mine ? req.ctx.userId : null], q));
  });

  app.get('/api/tickets/:id', { preHandler: guard('crm:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const t = (await c.query(`${TICKET_SELECT} where t.id = $1`, [id])).rows[0];
      if (!t) throw new HttpError(404, 'atendimento não encontrado');
      t.thread = (await c.query(MESSAGES, [id])).rows;
      t.work_orders = (await c.query('select id, number, kind, status, scheduled_for from work_orders where ticket_id = $1 order by number', [id])).rows;
      return t;
    });
  });

  app.post('/api/tickets', { preHandler: guard('crm:write') }, async (req) => {
    const b = z.object({ subscriber_id: zUuid, contract_id: zUuid.nullish(), subject: zText(200), category: zCategory,
      priority: z.enum(['low', 'normal', 'high']).default('normal'), body: zText(4000) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from subscribers where id = $1', [b.subscriber_id])).rowCount) throw new HttpError(400, 'assinante não encontrado');
      if (b.contract_id && !(await c.query('select 1 from contracts where id = $1 and subscriber_id = $2', [b.contract_id, b.subscriber_id])).rowCount)
        throw new HttpError(400, 'o contrato não pertence a este assinante');
      const t = await openTicket(c, req.ctx, { ...b, contract_id: b.contract_id ?? null, origin: 'staff' });
      await audit(c, req.ctx, 'ticket.create', 'ticket', t.id, { number: t.number, category: b.category });
      return t;
    });
  });

  app.patch('/api/tickets/:id', { preHandler: guard('crm:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ assignee_id: zUuid.nullish(), priority: z.enum(['low', 'normal', 'high']).optional(), category: zCategory.optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (b.assignee_id) await staff(c, b.assignee_id);
      const t = (await c.query(
        `update tickets set assignee_id = case when $2 then $3 else assignee_id end, priority = coalesce($4, priority), category = coalesce($5, category), updated_at = now() where id = $1 returning *`,
        [id, b.assignee_id !== undefined, b.assignee_id ?? null, b.priority ?? null, b.category ?? null])).rows[0];
      if (!t) throw new HttpError(404, 'atendimento não encontrado');
      await audit(c, req.ctx, 'ticket.update', 'ticket', id, b);
      return t;
    });
  });

  // Resposta ao assinante deixa o atendimento "aguardando o assinante"; nota interna não muda a situação.
  app.post('/api/tickets/:id/messages', { preHandler: guard('crm:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ body: zText(4000), internal: z.boolean().default(false) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const t = (await c.query('select status from tickets where id = $1 for update', [id])).rows[0];
      if (!t) throw new HttpError(404, 'atendimento não encontrado');
      if (t.status === 'closed') throw new HttpError(400, 'atendimento encerrado: reabra para responder');
      await c.query(`insert into ticket_messages (tenant_id, ticket_id, author_id, author_kind, body, internal) values ($1,$2,$3,'staff',$4,$5)`, [req.ctx.tenantId, id, req.ctx.userId, b.body, b.internal]);
      await c.query(`update tickets set status = case when $2 then status else 'waiting' end, updated_at = now() where id = $1`, [id, b.internal]);
      return { ok: true };
    });
  });

  app.post('/api/tickets/:id/status', { preHandler: guard('crm:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ status: z.enum(['open', 'waiting', 'closed']) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const t = (await c.query(`update tickets set status = $2, closed_at = case when $2 = 'closed' then now() end, updated_at = now() where id = $1 returning *`, [id, b.status])).rows[0];
      if (!t) throw new HttpError(404, 'atendimento não encontrado');
      await audit(c, req.ctx, `ticket.${b.status}`, 'ticket', id);
      return t;
    });
  });

  // ---- Avisos ao provedor (webhook) ----
  app.get('/api/notifications', { preHandler: guard('settings:manage') }, async (req) =>
    withScope(req.ctx.scope, async (c) => ({
      webhook_url: (await c.query('select notify_webhook_url from tenant_settings where tenant_id = $1', [req.ctx.tenantId])).rows[0]?.notify_webhook_url ?? null,
      recent: (await c.query(`select id, event, payload->>'text' as text, status, attempts, last_error, created_at, sent_at from notifications order by id desc limit 50`)).rows,
    })));

  app.put('/api/notifications/settings', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({ webhook_url: z.string().trim().max(500).nullable().transform((v) => v || null) }).parse(req.body);
    if (b.webhook_url) await assertSafeWebhookUrl(b.webhook_url);
    return withScope(req.ctx.scope, async (c) => {
      await c.query(`insert into tenant_settings (tenant_id, notify_webhook_url, updated_by) values ($1,$2,$3)
                     on conflict (tenant_id) do update set notify_webhook_url = excluded.notify_webhook_url, updated_by = excluded.updated_by, updated_at = now()`, [req.ctx.tenantId, b.webhook_url, req.ctx.userId]);
      await audit(c, req.ctx, 'notifications.settings_update', 'tenant_settings', req.ctx.tenantId, { configured: !!b.webhook_url });   // o endereço pode conter um token: não vai para a auditoria
      return { webhook_url: b.webhook_url };
    });
  });

  /** Envia um aviso de teste agora e devolve o erro do destino, se houver. */
  app.post('/api/notifications/test', { preHandler: guard('settings:manage') }, async (req) => {
    const url = await withScope(req.ctx.scope, async (c) => (await c.query('select notify_webhook_url from tenant_settings where tenant_id = $1', [req.ctx.tenantId])).rows[0]?.notify_webhook_url);
    if (!url) throw new HttpError(400, 'configure o endereço do webhook primeiro');
    try { await sendTestNotice(url); } catch (e) { throw new HttpError(502, `o aviso de teste não foi entregue: ${(e as Error).message}`); }
    return { ok: true };
  });

  app.post('/api/notifications/deliver', { preHandler: guard('settings:manage') }, async (req) => deliverNotifications(() => {}, req.ctx.tenantId!));

  /** Relatório do período (datas no fuso do provedor): conversão por origem, atendimentos por categoria e OS por tipo. */
  app.get('/api/crm/report', { preHandler: guard('crm:read') }, async (req) => {
    const q = z.object({ from: zDate, to: zDate }).parse(req.query);
    if (q.to < q.from) throw new HttpError(400, 'período inválido');
    return withScope(req.ctx.scope, async (c) => {
      const tz = (await c.query('select timezone from tenant_settings where tenant_id = $1', [req.ctx.tenantId])).rows[0]?.timezone ?? 'America/Sao_Paulo';
      const p = [q.from, q.to, tz];
      const within = (col: string) => `(${col} at time zone $3)::date between $1::date and $2::date`;
      const hours = (expr: string) => `round((extract(epoch from avg(${expr})) / 3600)::numeric, 1)::float`;
      const leads = (await c.query(
        `select coalesce(nullif(l.source, ''), '(não informada)') as source, count(*)::int as created,
                count(*) filter (where l.stage = 'won')::int as won, count(*) filter (where l.stage = 'lost')::int as lost,
                count(*) filter (where l.stage in ('new','contacted','proposal'))::int as open
         from leads l where ${within('l.created_at')} group by 1 order by 2 desc, 1`, p)).rows;
      const tickets = (await c.query(
        `select t.category, count(*)::int as opened, count(*) filter (where t.status = 'closed')::int as closed, count(*) filter (where t.origin = 'portal')::int as from_portal,
                ${hours(`(select min(m.at) from ticket_messages m where m.ticket_id = t.id and m.author_kind = 'staff' and not m.internal) - t.created_at`)} as first_response_h,
                ${hours('t.closed_at - t.created_at')} as resolution_h
         from tickets t where ${within('t.created_at')} group by 1 order by 2 desc, 1`, p)).rows;
      const workOrders = req.ctx.perms.includes('os:read') ? (await c.query(
        `select w.kind, count(*)::int as opened, count(*) filter (where w.status = 'done')::int as done, count(*) filter (where w.status = 'canceled')::int as canceled,
                ${hours(`case when w.status = 'done' then w.finished_at - w.created_at end`)} as completion_h
         from work_orders w where ${within('w.created_at')} group by 1 order by 2 desc, 1`, p)).rows : null;
      return { from: q.from, to: q.to, timezone: tz, leads, tickets, work_orders: workOrders };
    });
  });

  // ---- Portal do assinante: só os próprios atendimentos e as mensagens não internas (garantido também por política no banco) ----
  const PORTAL_TICKET = `select t.id, t.number, t.subject, t.category, t.status, t.created_at, t.updated_at, t.closed_at from tickets t`;
  const portalSub = (ctx: Ctx) => { if (!ctx.subscriberId) throw new HttpError(403, 'sessão sem assinante'); return ctx.subscriberId; };

  app.get('/api/portal/tickets', { preHandler: guard('portal:self') }, async (req) => {
    const sid = portalSub(req.ctx);
    return withScope(req.ctx.scope, async (c) => (await c.query(`${PORTAL_TICKET} where t.subscriber_id = $1 order by (t.status = 'closed'), t.updated_at desc limit 50`, [sid])).rows);
  });

  app.get('/api/portal/tickets/:id', { preHandler: guard('portal:self') }, async (req) => {
    const sid = portalSub(req.ctx), id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const t = (await c.query(`${PORTAL_TICKET} where t.id = $1 and t.subscriber_id = $2`, [id, sid])).rows[0];
      if (!t) throw new HttpError(404, 'atendimento não encontrado');
      t.thread = (await c.query(`select m.id, m.at, m.author_kind, m.body from ticket_messages m where m.ticket_id = $1 and not m.internal order by m.id`, [id])).rows;
      return t;
    });
  });

  app.post('/api/portal/tickets', { preHandler: guard('portal:self') }, async (req) => {
    const sid = portalSub(req.ctx);
    const b = z.object({ subject: zText(200), category: zCategory, body: zText(4000) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const abertos = (await c.query(`select count(*) as n from tickets where subscriber_id = $1 and status <> 'closed'`, [sid])).rows[0].n;
      if (abertos >= 5) throw new HttpError(429, 'você já tem atendimentos em aberto: acompanhe ou responda um deles');
      const t = await openTicket(c, req.ctx, { ...b, subscriber_id: sid, contract_id: null, priority: 'normal', origin: 'portal' });
      await queueNotice(c, req.ctx.tenantId!, 'ticket.opened', `novo chamado pelo portal — protocolo ${t.number}: ${b.subject} (${req.ctx.name})`, { ticket_id: t.id, number: t.number });
      await audit(c, req.ctx, 'ticket.create', 'ticket', t.id, { number: t.number, origin: 'portal' });
      return { id: t.id, number: t.number };
    });
  });

  app.post('/api/portal/tickets/:id/messages', { preHandler: guard('portal:self') }, async (req) => {
    const sid = portalSub(req.ctx), id = zUuid.parse((req.params as any).id);
    const b = z.object({ body: zText(4000) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const t = (await c.query('select status from tickets where id = $1 and subscriber_id = $2 for update', [id, sid])).rows[0];
      if (!t) throw new HttpError(404, 'atendimento não encontrado');
      if (t.status === 'closed') throw new HttpError(400, 'atendimento encerrado: abra um novo');
      await c.query(`insert into ticket_messages (tenant_id, ticket_id, author_id, author_kind, body) values ($1,$2,$3,'subscriber',$4)`, [req.ctx.tenantId, id, req.ctx.userId, b.body]);
      const t2 = (await c.query(`update tickets set status = 'open', updated_at = now() where id = $1 returning number, subject`, [id])).rows[0];
      await queueNotice(c, req.ctx.tenantId!, 'ticket.subscriber_reply', `o assinante respondeu o protocolo ${t2.number}: ${t2.subject} (${req.ctx.name})`, { ticket_id: id, number: t2.number });
      return { ok: true };
    });
  });
}
