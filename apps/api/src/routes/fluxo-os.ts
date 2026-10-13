import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { paged, withScope } from '../db.js';
import { getSettings } from '../finance/core.js';
import { OPEN_WO_SQL } from '../sla.js';
import { zPage, zUuid } from '../validators.js';

/**
 * Lote 4 de paridade: catálogos (F2), SLA (F3), agenda (F4), endereço de instalação por serviço (F6) e pesquisa
 * de satisfação (C7). Atendimento é por ocorrência e OS; nenhuma rota aqui recebe mensagem do assinante.
 */
const KINDS = ['ticket_type', 'classification', 'root_cause', 'origin', 'os_reason'] as const;
const zName = z.string().trim().min(2).max(80);
const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD');

export async function fluxoOsRoutes(app: FastifyInstance) {
  // ---- Catálogos ----
  app.get('/api/catalogs', { preHandler: guard('subscribers:read') }, async (req) => {
    const q = z.object({ kind: z.enum(KINDS).optional(), all: z.enum(['1']).optional() }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select id, kind, name, active, created_at from catalog_items
         where ($1::text is null or kind = $1) and ($2::boolean or active) order by kind, name`, [q.kind ?? null, !!q.all])).rows);
  });
  app.post('/api/catalogs', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({ kind: z.enum(KINDS), name: zName }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(`insert into catalog_items (tenant_id, kind, name) values ($1,$2,$3) returning *`, [req.ctx.tenantId, b.kind, b.name])).rows[0];
      await audit(c, req.ctx, 'catalog.create', 'catalog_item', r.id, b);
      return r;
    });
  });
  app.patch('/api/catalogs/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ name: zName.optional(), active: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(`update catalog_items set name = coalesce($2, name), active = coalesce($3, active) where id = $1 returning *`, [id, b.name ?? null, b.active ?? null])).rows[0];
      if (!r) throw new HttpError(404, 'item não encontrado');
      await audit(c, req.ctx, 'catalog.update', 'catalog_item', id, b);
      return r;
    });
  });

  // ---- Políticas de SLA ----
  const zPolicy = z.object({
    name: zName, applies_to: z.enum(['ticket', 'work_order']), priority: z.enum(['low', 'normal', 'high']).nullish(),
    kind: z.enum(['install', 'repair', 'address_change', 'removal', 'other']).nullish(), type_id: zUuid.nullish(),
    resolution_minutes: z.number().int().min(5).max(525600), escalate_to: zUuid.nullish(), active: z.boolean().default(true),
  }).superRefine((v, ctx) => {
    if (v.applies_to === 'work_order' && (v.priority || v.type_id)) ctx.addIssue({ code: 'custom', message: 'política de OS só filtra por natureza da OS' });
    if (v.applies_to === 'ticket' && v.kind) ctx.addIssue({ code: 'custom', message: 'política de atendimento não filtra por natureza da OS' });
  });
  app.get('/api/sla-policies', { preHandler: guard('subscribers:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select p.*, u.name as escalate_to_name, t.name as type_name,
                (select count(*) from tickets x where x.sla_policy_id = p.id)::int + (select count(*) from work_orders x where x.sla_policy_id = p.id)::int as in_use
         from sla_policies p left join users u on u.id = p.escalate_to left join catalog_items t on t.id = p.type_id order by p.applies_to, p.name`)).rows));
  app.post('/api/sla-policies', { preHandler: guard('settings:manage') }, async (req) => {
    const b = zPolicy.parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (b.escalate_to && !(await c.query(`select 1 from users where id = $1 and active and role <> 'subscriber'`, [b.escalate_to])).rowCount)
        throw new HttpError(400, 'responsável de escalonamento não encontrado neste provedor');
      if (b.type_id && (await c.query(`select kind from catalog_items where id = $1`, [b.type_id])).rows[0]?.kind !== 'ticket_type') throw new HttpError(400, 'tipo de ocorrência inválido');
      const r = (await c.query(
        `insert into sla_policies (tenant_id, name, applies_to, priority, kind, type_id, resolution_minutes, escalate_to, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [req.ctx.tenantId, b.name, b.applies_to, b.priority ?? null, b.kind ?? null, b.type_id ?? null, b.resolution_minutes, b.escalate_to ?? null, b.active])).rows[0];
      await audit(c, req.ctx, 'sla.create', 'sla_policy', r.id, b);
      return r;
    });
  });
  app.patch('/api/sla-policies/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ name: zName.optional(), resolution_minutes: z.number().int().min(5).max(525600).optional(), escalate_to: zUuid.nullish(), active: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (b.escalate_to && !(await c.query(`select 1 from users where id = $1 and active and role <> 'subscriber'`, [b.escalate_to])).rowCount)
        throw new HttpError(400, 'responsável de escalonamento não encontrado neste provedor');
      const r = (await c.query(
        `update sla_policies set name = coalesce($2, name), resolution_minutes = coalesce($3, resolution_minutes),
           escalate_to = case when $4 then $5 else escalate_to end, active = coalesce($6, active) where id = $1 returning *`,
        [id, b.name ?? null, b.resolution_minutes ?? null, b.escalate_to !== undefined, b.escalate_to ?? null, b.active ?? null])).rows[0];
      if (!r) throw new HttpError(404, 'política não encontrada');
      await audit(c, req.ctx, 'sla.update', 'sla_policy', id, b);
      return r;
    });
  });
  app.delete('/api/sla-policies/:id', { preHandler: guard('settings:manage') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const used = (await c.query(
        `select (select count(*) from tickets where sla_policy_id = $1) + (select count(*) from work_orders where sla_policy_id = $1) as n`, [id])).rows[0].n;
      if (Number(used) > 0) throw new HttpError(409, 'política já aplicada a ocorrências: desative em vez de excluir');
      if (!(await c.query('delete from sla_policies where id = $1', [id])).rowCount) throw new HttpError(404, 'política não encontrada');
      await audit(c, req.ctx, 'sla.delete', 'sla_policy', id);
      return { ok: true };
    });
  });

  // Cumprimento de SLA por política no período (data de abertura).
  app.get('/api/reports/sla', { preHandler: guard('subscribers:read') }, async (req) => {
    const q = z.object({ from: zDate.optional(), to: zDate.optional() }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const tz = (await getSettings(c, req.ctx.tenantId!)).timezone;
      const rng = `x.created_at >= coalesce($1::date::timestamp at time zone $3, '-infinity') and x.created_at < coalesce(($2::date + 1)::timestamp at time zone $3, 'infinity')`;
      const rows = (await c.query(
        `select p.id as policy_id, p.name, p.applies_to, count(*)::int as total,
                count(*) filter (where x.done_at is not null and x.done_at <= x.sla_due_at)::int as within,
                count(*) filter (where (x.done_at is not null and x.done_at > x.sla_due_at) or (x.done_at is null and x.sla_due_at < now()))::int as breached,
                count(*) filter (where x.done_at is null and x.sla_due_at >= now())::int as open_ok,
                coalesce(round(avg(extract(epoch from x.done_at - x.created_at) / 60) filter (where x.done_at is not null)), 0)::int as avg_minutes
         from (select id, tenant_id, created_at, sla_policy_id, sla_due_at, closed_at as done_at from tickets
               union all select id, tenant_id, created_at, sla_policy_id, sla_due_at, case when status = 'done' then finished_at end from work_orders where status <> 'canceled') x
         join sla_policies p on p.id = x.sla_policy_id
         where ${rng} group by p.id, p.name, p.applies_to order by p.applies_to, p.name`, [q.from ?? null, q.to ?? null, tz])).rows;
      return { timezone: tz, rows };
    });
  });

  // ---- Endereço de instalação por serviço ----
  app.get('/api/contracts/:id/install-address', { preHandler: guard('contracts:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `select install_street as street, install_number as number, install_district as district, install_city as city, install_state as state, install_zip as zip
         from contracts where id = $1`, [zUuid.parse((req.params as any).id)])).rows[0];
      if (!r) throw new HttpError(404, 'contrato não encontrado');
      return r;
    }));
  app.put('/api/contracts/:id/install-address', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const t = z.string().trim().max(120).nullish().transform((v) => v || null);
    const b = z.object({ street: t, number: t, district: t, city: t, state: z.string().trim().max(2).nullish().transform((v) => v || null), zip: t }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `update contracts set install_street=$2, install_number=$3, install_district=$4, install_city=$5, install_state=$6, install_zip=$7 where id = $1 returning id`,
        [id, b.street, b.number, b.district, b.city, b.state, b.zip])).rows[0];
      if (!r) throw new HttpError(404, 'contrato não encontrado');
      await audit(c, req.ctx, 'contract.install_address', 'contract', id, b);
      return b;
    });
  });

  // ---- Agenda ----
  // Dia local do provedor. Sobreposição = mesmo técnico com duas OS cujo intervalo (início + duração estimada) se cruza.
  app.get('/api/agenda', { preHandler: guard('os:read') }, async (req) => {
    const q = z.object({ date: zDate, days: z.coerce.number().int().min(1).max(14).default(1), assignee_id: zUuid.optional() }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const tz = (await getSettings(c, req.ctx.tenantId!)).timezone;
      const rows = (await c.query(
        `select w.id, w.number, w.kind, w.status, w.scheduled_for, w.estimated_minutes, w.assignee_id, a.name as assignee_name, s.name as subscriber_name,
                coalesce(w.address_text, concat_ws(', ', s.address_street, s.address_number, s.address_district, s.address_city)) as address,
                (w.sla_due_at is not null and w.sla_due_at < now()) as sla_overdue
         from work_orders w join subscribers s on s.id = w.subscriber_id left join users a on a.id = w.assignee_id
         where w.status in (${OPEN_WO_SQL}) and w.scheduled_for >= ($1::date)::timestamp at time zone $2
           and w.scheduled_for < (($1::date + $3::int))::timestamp at time zone $2 and ($4::uuid is null or w.assignee_id = $4)
         order by a.name nulls last, w.scheduled_for`, [q.date, tz, q.days, q.assignee_id ?? null])).rows;
      const waiting = (await c.query(
        `select w.id, w.number, w.kind, w.awaiting_reason, s.name as subscriber_name, w.created_at from work_orders w join subscribers s on s.id = w.subscriber_id
         where w.status = 'awaiting_schedule' order by w.created_at limit 100`)).rows;
      const byTech = new Map<string, any>();
      for (const r of rows) {
        const key = r.assignee_id ?? 'none';
        if (!byTech.has(key)) byTech.set(key, { assignee_id: r.assignee_id, name: r.assignee_name ?? 'Sem responsável', items: [] });
        byTech.get(key).items.push(r);
      }
      for (const t of byTech.values()) {
        let prevEnd = 0;
        for (const it of t.items) {
          const start = new Date(it.scheduled_for).getTime(), end = start + it.estimated_minutes * 60_000;
          it.conflict = t.assignee_id != null && start < prevEnd;
          prevEnd = Math.max(prevEnd, end);
        }
      }
      return { date: q.date, days: q.days, timezone: tz, technicians: [...byTech.values()], awaiting_schedule: waiting };
    });
  });

  // Melhor horário: janelas livres do técnico no dia, dentro do expediente informado.
  app.get('/api/agenda/free', { preHandler: guard('os:read') }, async (req) => {
    const q = z.object({ assignee_id: zUuid, date: zDate, minutes: z.coerce.number().int().min(5).max(480).default(60),
      from_hour: z.coerce.number().int().min(0).max(23).default(8), to_hour: z.coerce.number().int().min(1).max(24).default(18) }).parse(req.query);
    if (q.to_hour <= q.from_hour) throw new HttpError(400, 'o fim do expediente deve ser depois do início');
    return withScope(req.ctx.scope, async (c) => {
      const tz = (await getSettings(c, req.ctx.tenantId!)).timezone;
      const day = (await c.query(`select (($1::date)::timestamp at time zone $2) as t`, [q.date, tz])).rows[0].t as Date;
      const winStart = day.getTime() + q.from_hour * 3_600_000, winEnd = day.getTime() + q.to_hour * 3_600_000;
      const busy = (await c.query(
        `select scheduled_for, estimated_minutes from work_orders
         where assignee_id = $1 and status in (${OPEN_WO_SQL}) and scheduled_for >= $2 and scheduled_for < $3 order by scheduled_for`,
        [q.assignee_id, new Date(day.getTime() - 86_400_000), new Date(winEnd)])).rows
        .map((r: any) => [new Date(r.scheduled_for).getTime(), new Date(r.scheduled_for).getTime() + r.estimated_minutes * 60_000] as [number, number])
        .filter(([, e]) => e > winStart);
      const free: { from: string; to: string }[] = [];
      let cursor = winStart;
      for (const [s, e] of busy) {
        if (s - cursor >= q.minutes * 60_000) free.push({ from: new Date(cursor).toISOString(), to: new Date(s).toISOString() });
        cursor = Math.max(cursor, e);
      }
      if (winEnd - cursor >= q.minutes * 60_000) free.push({ from: new Date(cursor).toISOString(), to: new Date(winEnd).toISOString() });
      return { timezone: tz, minutes: q.minutes, free };
    });
  });

  // ---- Pesquisa de satisfação (C7) ----
  app.get('/api/surveys', { preHandler: guard('os:read') }, async (req, reply) => {
    const q = z.object({ status: z.enum(['answered', 'pending', 'expired']).optional(), ...zPage }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const summary = (await c.query(
        `select count(*)::int as sent, count(*) filter (where answered_at is not null)::int as answered,
                count(*) filter (where answered_at is null and expires_at <= now())::int as expired,
                coalesce(round(avg(score), 2), 0)::float as average,
                count(*) filter (where score >= 4)::int as satisfied
         from satisfaction_surveys`)).rows[0];
      const rows = await paged(c, reply,
        `select v.id, v.created_at, v.answered_at, v.score, v.comment, w.number as work_order_number, w.kind, s.name as subscriber_name, u.name as assignee_name,
                case when v.answered_at is not null then 'answered' when v.expires_at <= now() then 'expired' else 'pending' end as status
         from satisfaction_surveys v join work_orders w on w.id = v.work_order_id join subscribers s on s.id = v.subscriber_id left join users u on u.id = w.assignee_id
         where ($1::text is null or (case when v.answered_at is not null then 'answered' when v.expires_at <= now() then 'expired' else 'pending' end) = $1)
         order by coalesce(v.answered_at, v.created_at) desc, v.id`, [q.status ?? null], q);
      return { summary, rows };
    });
  });

  app.get('/api/portal/surveys', { preHandler: guard('portal:self') }, async (req) => {
    const sid = req.ctx.subscriberId;
    if (!sid) throw new HttpError(403, 'sessão sem assinante');
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select v.id, v.created_at, v.expires_at, v.work_order_number, v.kind
         from satisfaction_surveys v
         where v.subscriber_id = $1 and v.answered_at is null and v.expires_at > now() order by v.created_at desc`, [sid])).rows);
  });
  app.post('/api/portal/surveys/:id', { preHandler: guard('portal:self') }, async (req) => {
    const sid = req.ctx.subscriberId;
    if (!sid) throw new HttpError(403, 'sessão sem assinante');
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ score: z.number().int().min(1).max(5), comment: z.string().trim().max(500).nullish().transform((v) => v || null) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `update satisfaction_surveys set score = $3, comment = $4, answered_at = now()
         where id = $1 and subscriber_id = $2 and answered_at is null and expires_at > now() returning id, score`, [id, sid, b.score, b.comment])).rows[0];
      if (!r) throw new HttpError(409, 'pesquisa não encontrada, já respondida ou expirada');
      await audit(c, req.ctx, 'survey.answer', 'satisfaction_survey', id, { score: b.score });
      return r;
    });
  });
}
