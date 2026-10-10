import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { paged, withScope } from '../db.js';
import { autoSuspend, currentCompetence, ensureCharges, generateMonthly, getSettings, manualPayment, processGatewayEvent, reconcile } from '../finance/core.js';
import { demoSign, getGateway } from '../finance/gateway.js';
import { zDate, zPage, zUuid } from '../validators.js';

const INVOICE_SELECT = `
  select i.*, s.name as subscriber_name, p.name as plan_name,
         (i.status = 'open' and i.due_date < (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date) as overdue,
         (select coalesce(sum(amount_cents),0)::int from payments x where x.invoice_id = i.id) as paid_cents
  from invoices i join subscribers s on s.id = i.subscriber_id join contracts k on k.id = i.contract_id
  join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id
  left join tenant_settings ts on ts.tenant_id = i.tenant_id`;

export async function financeRoutes(app: FastifyInstance) {
  // corpo bruto preservado para validar a assinatura do webhook
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(Object.assign(e as Error, { statusCode: 400 }), undefined); }
  });

  // ---- Política comercial e gateway (explícitos por provedor) ----
  app.get('/api/finance/settings', { preHandler: guard('finance:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => ({ ...(await getSettings(c, req.ctx.tenantId!)), demo_mode: process.env.NEXO_DEMO_MODE === '1' })));

  app.put('/api/finance/settings', { preHandler: guard('settings:manage') }, async (req) => {
    const b = z.object({
      gateway: z.enum(['none', 'demo']), billing_auto: z.boolean(), auto_suspend: z.boolean(),
      suspend_after_days: z.number().int().min(0).max(365).nullable(), auto_resume_on_payment: z.boolean(),
    }).parse(req.body);
    if (b.gateway === 'demo' && !getGateway('demo')) throw new HttpError(400, 'gateway de demonstração não é permitido fora do modo demonstração');
    if (b.auto_suspend && b.suspend_after_days == null) throw new HttpError(400, 'informe após quantos dias de atraso a suspensão ocorre');
    return withScope(req.ctx.scope, async (c) => {
      const s = (await c.query(
        `insert into tenant_settings (tenant_id, gateway, billing_auto, auto_suspend, suspend_after_days, auto_resume_on_payment, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (tenant_id) do update set gateway = excluded.gateway, billing_auto = excluded.billing_auto, auto_suspend = excluded.auto_suspend,
           suspend_after_days = excluded.suspend_after_days, auto_resume_on_payment = excluded.auto_resume_on_payment, updated_by = excluded.updated_by, updated_at = now()
         returning *`, [req.ctx.tenantId, b.gateway, b.billing_auto, b.auto_suspend, b.suspend_after_days, b.auto_resume_on_payment, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'finance.settings_update', 'tenant_settings', req.ctx.tenantId, b);
      return s;
    });
  });

  // ---- Faturas ----
  app.post('/api/finance/generate', { preHandler: guard('finance:write') }, async (req) => {
    const b = z.object({ competence: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).parse(req.body ?? {});
    return withScope(req.ctx.scope, async (c) => {
      const s = await getSettings(c, req.ctx.tenantId!);
      const comp = b.competence ? `${b.competence}-01` : await currentCompetence(c, s.timezone);
      const created = await generateMonthly(c, req.ctx.tenantId!, comp);
      const charged = await ensureCharges(c, req.ctx.tenantId!);
      const total = (await c.query(`select count(*) as n from invoices where competence = $1 and kind = 'monthly'`, [comp])).rows[0].n;
      await audit(c, req.ctx, 'finance.generate_monthly', 'invoice', null, { competence: comp, created });
      return { competence: comp, created, already_existing: total - created, charges_emitted: charged, gateway: s.gateway };
    });
  });

  app.get('/api/invoices', { preHandler: guard('finance:read') }, async (req, reply) => {
    const q = z.object({ q: z.string().trim().optional(), status: z.enum(['open', 'paid', 'reconciling', 'canceled', 'overdue']).optional(), contract_id: zUuid.optional(), ...zPage }).parse(req.query);
    return withScope(req.ctx.scope, async (c) =>
      paged(c, reply,
        `select * from (${INVOICE_SELECT}) y
         where ($1::text is null or y.subscriber_name ilike '%'||$1||'%') and ($3::uuid is null or y.contract_id = $3)
           and ($2::text is null or ($2 = 'overdue' and y.overdue) or y.status = $2)
         order by y.due_date desc, y.created_at desc, y.id`, [q.q || null, q.status ?? null, q.contract_id ?? null], q));
  });

  app.get('/api/invoices/:id', { preHandler: guard('finance:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const i = (await c.query(`${INVOICE_SELECT} where i.id = $1`, [id])).rows[0];
      if (!i) throw new HttpError(404, 'fatura não encontrada');
      i.items = (await c.query('select description, amount_cents from invoice_items where invoice_id = $1 order by id', [id])).rows;
      i.payments = (await c.query(
        `select p.id, p.amount_cents, p.paid_at, p.method, p.source, p.gateway_payment_id, p.note, u.name as created_by_name
         from payments p left join users u on u.id = p.created_by where p.invoice_id = $1 order by p.created_at`, [id])).rows;
      i.events = i.gateway_charge_id
        ? (await c.query('select id, event_id, type, status, note, received_at from gateway_events where gateway = $1 and charge_id = $2 order by id', [i.gateway, i.gateway_charge_id])).rows : [];
      return i;
    });
  });

  app.post('/api/invoices', { preHandler: guard('finance:write') }, async (req) => {
    const b = z.object({ contract_id: zUuid, description: z.string().trim().min(2).max(200), amount_cents: z.number().int().positive().max(100_000_000), due_date: zDate }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query('select subscriber_id from contracts where id = $1', [b.contract_id])).rows[0];
      if (!k) throw new HttpError(400, 'contrato não encontrado');
      const i = (await c.query(
        `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents) values ($1,$2,$3,'manual',$4,$5) returning *`,
        [req.ctx.tenantId, b.contract_id, k.subscriber_id, b.due_date, b.amount_cents])).rows[0];
      await c.query('insert into invoice_items (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)', [req.ctx.tenantId, i.id, b.description, b.amount_cents]);
      await ensureCharges(c, req.ctx.tenantId!);
      await audit(c, req.ctx, 'invoice.create', 'invoice', i.id, { amount_cents: b.amount_cents });
      return i;
    });
  });

  app.post('/api/invoices/:id/cancel', { preHandler: guard('finance:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ reason: z.string().trim().min(3, 'informe o motivo') }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query(`update invoices set status = 'canceled', canceled_at = now(), status_note = $2 where id = $1 and status = 'open' returning id`, [id, b.reason]);
      if (!r.rowCount) throw new HttpError(400, 'somente faturas em aberto podem ser canceladas');
      await audit(c, req.ctx, 'invoice.cancel', 'invoice', id, b);
      return { ok: true };
    });
  });

  app.post('/api/invoices/:id/manual-payment', { preHandler: guard('finance:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ amount_cents: z.number().int().positive(), paid_at: zDate, method: z.string().trim().max(40).nullish(), note: z.string().trim().min(3, 'informe uma observação') }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const status = await manualPayment(c, id, req.ctx.userId, { ...b, paid_at: `${b.paid_at}T12:00:00Z` });
      await audit(c, req.ctx, 'invoice.manual_payment', 'invoice', id, { amount_cents: b.amount_cents, status });
      return { status };
    });
  });

  // Decisão humana sobre fatura em conciliação (valor divergente, estorno etc.)
  app.post('/api/invoices/:id/resolve', { preHandler: guard('finance:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ decision: z.enum(['paid', 'open']), note: z.string().trim().min(5, 'descreva a decisão') }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const inv = (await c.query(`select * from invoices where id = $1 and status = 'reconciling' for update`, [id])).rows[0];
      if (!inv) throw new HttpError(400, 'fatura não está em conciliação');
      await c.query(`update invoices set status = $2, status_note = $3, paid_at = case when $2 = 'paid' then now() else null end where id = $1`,
        [id, b.decision, `conciliação manual: ${b.note}`]);
      await audit(c, req.ctx, 'invoice.resolve', 'invoice', id, b);
      if (b.decision === 'paid') await (await import('../finance/core.js')).onInvoicePaid(c, inv);
      return { status: b.decision };
    });
  });

  app.get('/api/contracts/:id/finance', { preHandler: guard('finance:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const invoices = (await c.query(`${INVOICE_SELECT} where i.contract_id = $1 order by i.due_date desc limit 24`, [id])).rows;
      return { invoices, open: invoices.filter((i) => i.status === 'open').length, overdue: invoices.filter((i) => i.overdue).length,
        reconciling: invoices.filter((i) => i.status === 'reconciling').length,
        open_cents: invoices.filter((i) => i.status === 'open').reduce((a, i) => a + i.amount_cents, 0) };
    });
  });

  app.get('/api/finance/summary', { preHandler: guard('finance:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select count(*) filter (where status = 'open') as open, coalesce(sum(amount_cents) filter (where status = 'open'),0)::int as open_cents,
                count(*) filter (where overdue) as overdue, coalesce(sum(amount_cents) filter (where overdue),0)::int as overdue_cents,
                count(*) filter (where status = 'reconciling') as reconciling,
                (select coalesce(sum(amount_cents),0)::int from payments where paid_at >= date_trunc('month', now())) as received_month_cents
         from (${INVOICE_SELECT}) x`)).rows[0]));

  /** Exportação para a contabilidade (CSV): recebimentos por data de pagamento ou faturas por vencimento. Não é documento fiscal. */
  app.get('/api/finance/export', { preHandler: guard('finance:read') }, async (req, reply) => {
    const q = z.object({ kind: z.enum(['payments', 'invoices']).default('payments'), from: zDate, to: zDate }).parse(req.query);
    if (q.to < q.from) throw new HttpError(400, 'período inválido');
    const rows = await withScope(req.ctx.scope, async (c) => {
      const tz = (await getSettings(c, req.ctx.tenantId!)).timezone;
      await audit(c, req.ctx, 'finance.export', 'finance', null, q);
      return (await c.query(q.kind === 'payments'
        ? `select to_char(p.paid_at at time zone $3, 'YYYY-MM-DD') as data_pagamento, s.name as assinante, s.document as cpf_cnpj, i.kind as tipo,
                  to_char(i.competence, 'YYYY-MM') as competencia, i.due_date as vencimento, i.amount_cents as valor_fatura, p.amount_cents as valor_pago,
                  p.method as meio, p.source as origem, coalesce(p.gateway, '') as gateway, coalesce(p.gateway_payment_id, '') as id_pagamento, i.id as fatura
           from payments p join invoices i on i.id = p.invoice_id join subscribers s on s.id = i.subscriber_id
           where (p.paid_at at time zone $3)::date between $1::date and $2::date order by p.paid_at, p.id`
        : `select i.due_date as vencimento, s.name as assinante, s.document as cpf_cnpj, i.kind as tipo, to_char(i.competence, 'YYYY-MM') as competencia,
                  i.amount_cents as valor_fatura, (select coalesce(sum(x.amount_cents),0)::int from payments x where x.invoice_id = i.id) as valor_pago,
                  i.status as situacao, to_char(i.paid_at at time zone $3, 'YYYY-MM-DD') as data_pagamento, i.id as fatura
           from invoices i join subscribers s on s.id = i.subscriber_id
           where i.due_date between $1::date and $2::date order by i.due_date, i.id`, [q.from, q.to, tz])).rows;
    });
    const money = new Set(['valor_fatura', 'valor_pago']);
    const cell = (k: string, v: unknown) => {
      if (v == null) return '';
      if (money.has(k)) return (Number(v) / 100).toFixed(2).replace('.', ',');
      const t = String(v);
      // texto que começa com = + - @ seria interpretado como fórmula pela planilha
      return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
    };
    const cols = q.kind === 'payments'
      ? ['data_pagamento', 'assinante', 'cpf_cnpj', 'tipo', 'competencia', 'vencimento', 'valor_fatura', 'valor_pago', 'meio', 'origem', 'gateway', 'id_pagamento', 'fatura']
      : ['vencimento', 'assinante', 'cpf_cnpj', 'tipo', 'competencia', 'valor_fatura', 'valor_pago', 'situacao', 'data_pagamento', 'fatura'];
    const csv = [cols.join(';'), ...rows.map((r) => cols.map((k) => cell(k, r[k])).join(';'))].join('\r\n') + '\r\n';
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="nexoisp-${q.kind}-${q.from}_${q.to}.csv"`).send('\uFEFF' + csv);
  });

  /** Recebido por mês nos últimos 6 meses (fuso do provedor), para o gráfico de Faturas. */
  app.get('/api/finance/monthly', { preHandler: guard('finance:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const tz = (await getSettings(c, req.ctx.tenantId!)).timezone;
      return (await c.query(
        `select to_char(m, 'YYYY-MM') as month,
                coalesce((select sum(p.amount_cents) from payments p where date_trunc('month', p.paid_at at time zone $1) = m), 0)::int as received_cents
         from generate_series(date_trunc('month', now() at time zone $1) - interval '5 months', date_trunc('month', now() at time zone $1), interval '1 month') m order by m`, [tz])).rows;
    }));

  // ---- Conciliação ----
  app.get('/api/finance/reconciliation', { preHandler: guard('finance:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => ({
      invoices: (await c.query(`${INVOICE_SELECT} where i.status = 'reconciling' order by i.due_date`)).rows,
      events: (await c.query(
        `select e.id, e.gateway, e.event_id, e.type, e.charge_id, e.status, e.note, e.received_at, i.id as invoice_id, s.name as subscriber_name
         from gateway_events e left join invoices i on i.gateway = e.gateway and i.gateway_charge_id = e.charge_id left join subscribers s on s.id = i.subscriber_id
         order by e.id desc limit 100`)).rows,
    })));

  app.post('/api/finance/reconcile', { preHandler: guard('finance:write') }, async (req) => {
    const r = await reconcile(req.ctx.tenantId!);
    await audit(null, req.ctx, 'finance.reconcile', null, null, r);
    return r;
  });

  app.post('/api/finance/run-auto-suspend', { preHandler: guard('settings:manage') }, async (req) => {
    const n = await autoSuspend(req.ctx.tenantId!);
    await audit(null, req.ctx, 'finance.run_auto_suspend', null, null, { requested: n });
    return { requested: n };
  });

  // ---- Webhook do gateway: autenticado por assinatura; sem sessão de usuário ----
  app.post('/api/webhooks/gateway/:gateway', async (req, reply) => {
    const gw = getGateway((req.params as any).gateway);
    if (!gw) return reply.status(404).send({ error: 'gateway não habilitado' });
    const raw = (req as any).rawBody as string;
    if (!gw.verifyWebhook(raw, req.headers as any)) return reply.status(401).send({ error: 'assinatura inválida' });
    const ev = gw.parseWebhook(req.body);
    if (!ev.eventId || !ev.type) return reply.status(400).send({ error: 'evento inválido' });
    return processGatewayEvent(gw.name, ev, req.body);
  });

  // ---- Somente DEMONSTRAÇÃO: simula o pagador e o envio (ou a perda) do webhook ----
  app.post('/api/demo-gateway/pay', { preHandler: guard('finance:write') }, async (req) => {
    if (!getGateway('demo')) throw new HttpError(404, 'disponível apenas no modo demonstração');
    const b = z.object({ invoice_id: zUuid, mode: z.enum(['webhook', 'lost', 'duplicate', 'divergent']) }).parse(req.body);
    const pay = await withScope(req.ctx.scope, async (c) => {
      const inv = (await c.query(`select * from invoices where id = $1 and gateway = 'demo'`, [b.invoice_id])).rows[0];
      if (!inv) throw new HttpError(400, 'fatura sem cobrança no gateway de demonstração');
      const payment = { id: `demo_pay_${randomUUID()}`, amount_cents: b.mode === 'divergent' ? Math.max(1, inv.amount_cents - 1000) : inv.amount_cents, paid_at: new Date().toISOString(), method: 'pix' };
      await c.query(`update demo_gateway_charges set payments = payments || $2::jsonb where charge_id = $1`, [inv.gateway_charge_id, JSON.stringify([payment])]);
      return { charge_id: inv.gateway_charge_id as string, payment };
    });
    if (b.mode === 'lost') return { simulated: true, webhook: 'não enviado (perda simulada); use a conciliação para recuperar' };
    const body = JSON.stringify({ id: `demo_evt_${randomUUID()}`, type: 'payment.confirmed', charge_id: pay.charge_id, payment: pay.payment });
    const send = async () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const r = await app.inject({ method: 'POST', url: '/api/webhooks/gateway/demo', payload: body, headers: { 'content-type': 'application/json', 'x-nexo-timestamp': ts, 'x-nexo-signature': demoSign(body, ts) } });
      return r.json();
    };
    const first = await send();
    return { simulated: true, webhook: first, ...(b.mode === 'duplicate' ? { webhook_repeated: await send() } : {}) };
  });
}
