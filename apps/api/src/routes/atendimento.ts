import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { zUuid } from '../validators.js';

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const t = String(v);
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;   // texto que começa com = + - @ viraria fórmula na planilha
};
const toCsv = (cols: string[], rows: Record<string, unknown>[]) =>
  '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(';'))].join('\r\n') + '\r\n';

export async function atendimentoRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- busca única
  /** Uma caixa para tudo: nome, documento, e-mail, telefone, login PPPoE, MAC, IP, serial de ONU e nº de OS. Já devolve o contexto. */
  app.get('/api/search', { preHandler: guard('subscribers:read') }, async (req) => {
    const q = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query).q;
    const digits = q.replace(/\D/g, '');
    const mac = q.toUpperCase().replace(/[-.]/g, ':');
    const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
    const finance = req.ctx.perms.includes('finance:read');
    return withScope(req.ctx.scope, async (c) => {
      const found = new Map<string, any>();
      const add = (r: any, matched: string) => {
        const cur = found.get(r.contract_id ?? `s:${r.subscriber_id}`);
        if (cur) { cur.matched.push(matched); return; }
        found.set(r.contract_id ?? `s:${r.subscriber_id}`, { ...r, matched: [matched] });
      };
      const base = `select s.id as subscriber_id, s.name as subscriber_name, s.document, s.status as subscriber_status,
                           k.id as contract_id, k.status as contract_status, p.name as plan_name,
                           r.pppoe_username, r.desired_policy, r.observed_policy,
                           (r.observed_session->>'online')::boolean as online, r.observed_session->>'ip' as ip, r.mac,
                           ${finance ? `(select count(*)::int from invoices i where i.contract_id = k.id and i.status = 'open' and i.due_date < current_date)` : 'null::int'} as overdue
                    from subscribers s
                    left join contracts k on k.subscriber_id = s.id
                    left join plan_versions pv on pv.id = k.plan_version_id left join plans p on p.id = pv.plan_id
                    left join service_resources r on r.contract_id = k.id`;
      const lim = 'order by s.name, k.created_at desc limit 25';
      for (const r of (await c.query(
        `${base} where s.name ilike $1 or s.email ilike $1 or ($2 <> '' and (s.document like '%'||$2||'%' or s.phone like '%'||$2||'%')) ${lim}`, [like, digits])).rows)
        add(r, 'cliente');
      for (const r of (await c.query(`${base} where r.pppoe_username ilike $1 ${lim}`, [like])).rows) add(r, 'login');
      if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac))
        for (const r of (await c.query(`${base} where r.mac = $1 or r.observed_session->>'caller_id' ilike $1 ${lim}`, [mac])).rows) add(r, 'MAC');
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(q)) {
        for (const r of (await c.query(
          `${base} where r.observed_session->>'ip' = $1 or exists (select 1 from ip_allocations a where a.contract_id = k.id and host(a.address) = $1) ${lim}`, [q])).rows)
          add(r, 'IP');
        for (const r of (await c.query(
          `${base} join service_sessions ss on ss.resource_id = r.id where ss.ip = $1 ${lim.replace('order by s.name, k.created_at desc', 'order by s.name')}`, [q])).rows)
          add(r, 'IP (sessão anterior)');
      }
      if (req.ctx.modules.includes('olt'))
        for (const r of (await c.query(`${base} join onus n on n.contract_id = k.id where n.serial ilike $1 ${lim}`, [like])).rows) add(r, 'ONU');
      if (req.ctx.modules.includes('field') && /^\d{1,9}$/.test(q))
        for (const r of (await c.query(
          `${base} join work_orders w on w.contract_id = k.id or (w.contract_id is null and w.subscriber_id = s.id) where w.number = $1 ${lim}`, [Number(q)])).rows)
          add(r, 'OS');
      if (req.ctx.modules.includes('crm') && /^\d{1,9}$/.test(q))
        for (const r of (await c.query(
          `${base} join tickets t on t.subscriber_id = s.id and (t.contract_id is null or t.contract_id = k.id) where t.number = $1 ${lim}`, [Number(q)])).rows)
          add(r, 'atendimento');
      return { q, results: [...found.values()].slice(0, 50) };
    });
  });

  // ---------------------------------------------------------------- linha do tempo do assinante
  app.get('/api/subscribers/:id/timeline', { preHandler: guard('subscribers:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const lim = z.coerce.number().int().min(10).max(500).default(150).parse((req.query as any).limit);
    const finance = req.ctx.perms.includes('finance:read');
    const network = req.ctx.perms.includes('network:read');
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from subscribers where id = $1', [id])).rowCount) throw new HttpError(404, 'assinante não encontrado');
      const ev: { at: string; kind: string; title: string; detail?: string | null; contract_id?: string | null; ref?: string | null; by?: string | null }[] = [];
      const push = (rows: any[], map: (r: any) => any) => rows.forEach((r) => ev.push(map(r)));
      push((await c.query(
        `select h.at, h.event, h.detail, h.contract_id, u.name as by from contract_history h join contracts k on k.id = h.contract_id left join users u on u.id = h.actor_id
         where k.subscriber_id = $1 order by h.at desc limit $2`, [id, lim])).rows,
      (r) => ({ at: r.at, kind: 'contract', contract_id: r.contract_id, by: r.by,
        title: ({ created: 'Contrato criado', plan_changed: 'Troca de plano', ended: 'Contrato encerrado', due_day_changed: 'Vencimento alterado', credit_restricted: 'Restrição de crédito', credit_released: 'Restrição de crédito retirada', loyalty_set: 'Fidelidade definida', penalty_charged: 'Multa rescisória cobrada', penalty_waived: 'Multa rescisória dispensada', amendment: 'Aditivo registrado' } as any)[r.event] ?? r.event,
        detail: r.detail?.from !== undefined ? `${r.detail.from} → ${r.detail.to}` : (r.detail?.plan ?? null) }));
      if (finance) {
        push((await c.query(
          `select i.id, i.created_at, i.paid_at, i.canceled_at, i.kind, i.amount_cents, i.status, i.due_date, i.contract_id from invoices i
           where i.subscriber_id = $1 order by i.created_at desc limit $2`, [id, lim])).rows,
        (r) => ({ at: r.created_at, kind: 'invoice', contract_id: r.contract_id, ref: r.id,
          title: r.kind === 'agreement' ? 'Parcela de acordo gerada' : r.kind === 'manual' ? 'Fatura avulsa gerada' : 'Mensalidade gerada',
          detail: `R$ ${(r.amount_cents / 100).toFixed(2).replace('.', ',')} · vence ${String(r.due_date).slice(0, 10).split('-').reverse().join('/')}` }));
        push((await c.query(
          `select p.id, p.paid_at, p.amount_cents, p.kind, p.source, p.invoice_id, i.contract_id from payments p join invoices i on i.id = p.invoice_id
           where i.subscriber_id = $1 order by p.paid_at desc limit $2`, [id, lim])).rows,
        (r) => ({ at: r.paid_at, kind: 'payment', contract_id: r.contract_id, ref: r.invoice_id,
          title: r.kind === 'reversal' ? 'Baixa estornada' : 'Pagamento registrado',
          detail: `R$ ${(r.amount_cents / 100).toFixed(2).replace('.', ',')} · ${r.source === 'manual' ? 'baixa manual' : 'gateway'}` }));
      }
      if (network) {
        push((await c.query(
          `select o.id, o.created_at, o.action, o.status, o.reason, k.id as contract_id, u.name as by
           from operations o join service_resources r on r.id = o.resource_id join contracts k on k.id = r.contract_id
           left join users u on u.id::text = o.authorization_ref->>'id' and o.authorization_ref->>'type' = 'user'
           where k.subscriber_id = $1 order by o.created_at desc limit $2`, [id, lim])).rows,
        (r) => ({ at: r.created_at, kind: 'network', contract_id: r.contract_id, by: r.by, ref: r.id,
          title: ({ 'subscriber.provision': 'Acesso provisionado/atualizado', 'subscriber.suspend': 'Acesso suspenso', 'subscriber.resume': 'Acesso reativado' } as any)[r.action] ?? r.action,
          detail: [r.reason, ({ SUCCEEDED: 'concluída', FAILED: 'falhou', PENDING: 'pendente', UNCERTAIN: 'incerta', SUPERSEDED: 'substituída', EXPIRED: 'expirada' } as any)[r.status]].filter(Boolean).join(' · ') }));
        push((await c.query(
          `select t.id, t.granted_at, t.days, t.status, t.source, t.contract_id, u.name as by from trust_releases t join contracts k on k.id = t.contract_id
           left join users u on u.id = t.requested_by where k.subscriber_id = $1 order by t.granted_at desc limit $2`, [id, lim])).rows,
        (r) => ({ at: r.granted_at, kind: 'network', contract_id: r.contract_id, by: r.by, title: 'Liberação por confiança',
          detail: `${r.days} dia(s) · ${r.source === 'portal' ? 'pedida pelo assinante' : 'concedida pela equipe'}` }));
      }
      if (req.ctx.modules.includes('field'))
        push((await c.query(
          `select w.id, w.number, w.kind, w.status, w.description, w.created_at, w.contract_id from work_orders w where w.subscriber_id = $1 order by w.created_at desc limit $2`, [id, lim])).rows,
        (r) => ({ at: r.created_at, kind: 'work_order', contract_id: r.contract_id, ref: r.id,
          title: `OS ${r.number}: ${({ install: 'instalação', repair: 'reparo', address_change: 'mudança de endereço', removal: 'retirada', other: 'outro' } as any)[r.kind]}`,
          detail: String(r.description).slice(0, 140) }));
      if (req.ctx.modules.includes('crm'))
        push((await c.query(
          `select t.id, t.number, t.subject, t.status, t.created_at, t.contract_id from tickets t where t.subscriber_id = $1 order by t.created_at desc limit $2`, [id, lim])).rows,
        (r) => ({ at: r.created_at, kind: 'ticket', contract_id: r.contract_id, ref: r.id, title: `Atendimento ${r.number}: ${r.subject}`, detail: r.status }));
      push((await c.query(
        `select n.id, n.created_at, n.body, n.alert, n.contract_id, u.name as by from subscriber_notes n left join users u on u.id = n.created_by
         where n.subscriber_id = $1 order by n.created_at desc limit $2`, [id, lim])).rows,
      (r) => ({ at: r.created_at, kind: 'note', contract_id: r.contract_id, by: r.by, ref: r.id, title: r.alert ? 'Anotação com alerta' : 'Anotação', detail: String(r.body).slice(0, 200) }));
      ev.sort((a, b) => +new Date(b.at) - +new Date(a.at));
      return ev.slice(0, lim);
    });
  });

  // ---------------------------------------------------------------- sessões do contrato
  app.get('/api/contracts/:id/sessions', { preHandler: guard('network:read') }, async (req, reply) => {
    const id = zUuid.parse((req.params as any).id);
    const q = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const rows = (await c.query(
        `select s.session_key, s.started_at, s.stopped_at, s.ip, s.mac, s.nas_ip, s.bytes_in::float as bytes_in, s.bytes_out::float as bytes_out,
                s.seconds::float as seconds, s.terminate_cause
         from service_sessions s join service_resources r on r.id = s.resource_id
         where r.contract_id = $1 and ($2::date is null or s.started_at >= $2::date) and ($3::date is null or s.started_at < $3::date + 1)
         order by s.started_at desc limit 1000`, [id, q.from ?? null, q.to ?? null])).rows;
      if (q.format === 'csv') {
        await audit(c, req.ctx, 'contract.sessions_export', 'contract', id, q);
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="sessoes-${id.slice(0, 8)}.csv"`)
          .send(toCsv(['started_at', 'stopped_at', 'ip', 'mac', 'nas_ip', 'seconds', 'bytes_in', 'bytes_out', 'terminate_cause'], rows));
      }
      const totals = rows.reduce((a, r) => ({ sessions: a.sessions + 1, seconds: a.seconds + r.seconds, bytes_in: a.bytes_in + r.bytes_in, bytes_out: a.bytes_out + r.bytes_out }),
        { sessions: 0, seconds: 0, bytes_in: 0, bytes_out: 0 });
      // por dia (para o gráfico de consumo): início da sessão no dia, fuso do provedor
      const tz = (await c.query(`select coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo') as tz`, [req.ctx.tenantId])).rows[0].tz;
      const daily = (await c.query(
        `select to_char((s.started_at at time zone $2)::date, 'YYYY-MM-DD') as day, sum(s.bytes_in)::float as bytes_in, sum(s.bytes_out)::float as bytes_out, count(*)::int as sessions
         from service_sessions s join service_resources r on r.id = s.resource_id
         where r.contract_id = $1 and ($3::date is null or s.started_at >= $3::date) and ($4::date is null or s.started_at < $4::date + 1)
         group by 1 order by 1 desc limit 400`, [id, tz, q.from ?? null, q.to ?? null])).rows;
      return { rows, totals, daily, truncated: rows.length === 1000 };
    });
  });

  // ---------------------------------------------------------------- usuários online
  app.get('/api/network/online', { preHandler: guard('network:read') }, async (req, reply) => {
    const q = z.object({ q: z.string().trim().max(80).optional(), format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const like = q.q ? `%${q.q.replace(/[%_\\]/g, '\\$&')}%` : null;
      const rows = (await c.query(
        `select s.name as subscriber_name, r.pppoe_username as login, r.observed_session->>'ip' as ip, r.observed_session->>'caller_id' as mac,
                r.observed_session->>'uptime' as uptime, d.name as nas, po.name as pop, r.contract_id, r.desired_policy, r.observed_at
         from service_resources r join contracts k on k.id = r.contract_id join subscribers s on s.id = k.subscriber_id
         join devices d on d.id = r.device_id left join pops po on po.id = k.pop_id
         where (r.observed_session->>'online')::boolean is true and ($1::text is null or s.name ilike $1 or r.pppoe_username ilike $1 or r.observed_session->>'ip' like $1)
         order by s.name limit 5000`, [like])).rows;
      if (q.format === 'csv') {
        await audit(c, req.ctx, 'network.online_export', 'network', null, { rows: rows.length });
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="usuarios-online.csv"')
          .send(toCsv(['subscriber_name', 'login', 'ip', 'mac', 'uptime', 'nas', 'pop'], rows));
      }
      return { total: rows.length, rows };
    });
  });

  // ---------------------------------------------------------------- contatos
  const zContact = z.object({
    kind: z.enum(['mobile', 'whatsapp', 'landline', 'email', 'responsible']),
    value: z.string().trim().min(3).max(200), label: z.string().trim().max(60).nullish(),
    purpose: z.enum(['general', 'billing', 'technical']).default('general'), allow_notices: z.boolean().default(false),
  });
  app.get('/api/subscribers/:id/contacts', { preHandler: guard('subscribers:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query('select id, kind, value, label, purpose, allow_notices, created_at from subscriber_contacts where subscriber_id = $1 order by created_at', [zUuid.parse((req.params as any).id)])).rows));

  app.put('/api/subscribers/:id/contacts', { preHandler: guard('subscribers:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ contacts: z.array(zContact).max(20) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from subscribers where id = $1', [id])).rowCount) throw new HttpError(404, 'assinante não encontrado');
      await c.query('delete from subscriber_contacts where subscriber_id = $1', [id]);
      for (const k of b.contacts)
        await c.query(`insert into subscriber_contacts (tenant_id, subscriber_id, kind, value, label, purpose, allow_notices) values ($1,$2,$3,$4,$5,$6,$7)`,
          [req.ctx.tenantId, id, k.kind, k.value, k.label ?? null, k.purpose, k.allow_notices]);
      await audit(c, req.ctx, 'subscriber.contacts', 'subscriber', id, { count: b.contacts.length, notices: b.contacts.filter((k) => k.allow_notices).length });
      return (await c.query('select id, kind, value, label, purpose, allow_notices from subscriber_contacts where subscriber_id = $1 order by created_at', [id])).rows;
    });
  });

  // ---------------------------------------------------------------- POP
  app.get('/api/pops', { preHandler: guard('contracts:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select p.id, p.name, p.city, p.state, p.active,
                count(k.id) filter (where k.status = 'active')::int as active_contracts, count(k.id) filter (where k.status = 'ended')::int as ended_contracts,
                count(k.id) filter (where k.status = 'active' and r.desired_policy = 'suspended')::int as suspended_contracts
         from pops p left join contracts k on k.pop_id = p.id left join service_resources r on r.contract_id = k.id and r.desired_version > 0
         group by p.id order by p.name`)).rows));

  app.post('/api/pops', { preHandler: guard('network:write') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), city: z.string().trim().max(80).nullish(), state: z.string().trim().length(2).nullish() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query(`insert into pops (tenant_id, name, city, state) values ($1,$2,$3,$4) on conflict (tenant_id, name) do nothing returning id, name`,
        [req.ctx.tenantId, b.name, b.city ?? null, b.state?.toUpperCase() ?? null])).rows[0];
      if (!p) throw new HttpError(409, 'já existe um POP com este nome');
      await audit(c, req.ctx, 'pop.create', 'pop', p.id, { name: b.name });
      return p;
    });
  });

  app.patch('/api/pops/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), city: z.string().trim().max(80).nullish(), state: z.string().trim().length(2).nullish(), active: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query(
        `update pops set name = coalesce($2, name), city = coalesce($3, city), state = coalesce($4, state), active = coalesce($5, active) where id = $1 returning id, name, active`,
        [id, b.name ?? null, b.city ?? null, b.state?.toUpperCase() ?? null, b.active ?? null]);
      if (!r.rowCount) throw new HttpError(404, 'POP não encontrado');
      await audit(c, req.ctx, 'pop.update', 'pop', id, b);
      return r.rows[0];
    });
  });

  /** Contrato num POP (ou sem POP). */
  app.put('/api/contracts/:id/pop', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ pop_id: zUuid.nullable() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (b.pop_id && !(await c.query('select 1 from pops where id = $1 and active', [b.pop_id])).rowCount) throw new HttpError(400, 'POP não encontrado ou inativo');
      const r = await c.query('update contracts set pop_id = $2 where id = $1 returning id', [id, b.pop_id]);
      if (!r.rowCount) throw new HttpError(404, 'contrato não encontrado');
      await audit(c, req.ctx, 'contract.pop', 'contract', id, b);
      return { ok: true };
    });
  });
}
