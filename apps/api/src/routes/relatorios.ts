import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard } from '../auth.js';
import { withScope } from '../db.js';
import { zDate, zUuid } from '../validators.js';

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const t = String(v);
  return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`;
};
const toCsv = (cols: string[], rows: Record<string, unknown>[]) =>
  '﻿' + [cols.join(';'), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(';'))].join('\r\n') + '\r\n';
const brl = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

export async function relatoriosRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- cobrança
  const fmt = z.enum(['json', 'csv']).default('json');
  const TZ = `coalesce((select timezone from tenant_settings ts where ts.tenant_id = i.tenant_id), 'America/Sao_Paulo')`;

  /** Carteira em aberto por faixa de atraso. */
  app.get('/api/finance/reports/aging', { preHandler: guard('finance:read') }, async (req, reply) => {
    const q = z.object({ plan_id: zUuid.optional(), pop_id: zUuid.optional(), tag: zUuid.optional(), format: fmt }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const rows = (await c.query(
        `with base as (
           select i.amount_cents + i.fee_cents - i.discount_cents - coalesce((select sum(p.signed_cents) from payments p where p.invoice_id = i.id), 0) as due_cents,
                  ((now() at time zone ${TZ})::date - i.due_date) as late
           from invoices i join contracts k on k.id = i.contract_id join plan_versions pv on pv.id = k.plan_version_id
           where i.status = 'open' and ($1::uuid is null or pv.plan_id = $1) and ($2::uuid is null or k.pop_id = $2)
             and ($3::uuid is null or exists (select 1 from contract_tags x where x.contract_id = k.id and x.tag_id = $3)))
         select faixa, ordem, count(*)::int as faturas, coalesce(sum(due_cents),0)::bigint::float as cents from (
           select case when late <= 0 then 'A vencer' when late <= 30 then '1 a 30 dias' when late <= 60 then '31 a 60 dias'
                       when late <= 90 then '61 a 90 dias' else 'Mais de 90 dias' end as faixa,
                  case when late <= 0 then 1 when late <= 30 then 2 when late <= 60 then 3 when late <= 90 then 4 else 5 end as ordem, due_cents from base) x
         group by faixa, ordem order by ordem`, [q.plan_id ?? null, q.pop_id ?? null, q.tag ?? null])).rows;
      const total = rows.reduce((a, r) => ({ faturas: a.faturas + r.faturas, cents: a.cents + r.cents }), { faturas: 0, cents: 0 });
      if (q.format === 'csv') {
        await audit(c, req.ctx, 'finance.report_export', 'report', null, { name: 'aging' });
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="aging.csv"')
          .send(toCsv(['faixa', 'faturas', 'valor'], rows.map((r) => ({ faixa: r.faixa, faturas: r.faturas, valor: brl(r.cents) }))));
      }
      return { rows, total };
    });
  });

  /** Recebido por plano e por forma de pagamento, líquido de estornos. */
  app.get('/api/finance/reports/receipts', { preHandler: guard('finance:read') }, async (req, reply) => {
    const q = z.object({ from: zDate, to: zDate, format: fmt }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const tz = (await c.query(`select coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo') as tz`, [req.ctx.tenantId])).rows[0].tz;
      const by = async (expr: string) => (await c.query(
        `select ${expr} as grupo, count(*) filter (where p.kind = 'payment')::int as pagamentos, coalesce(sum(p.signed_cents),0)::bigint::float as cents
         from payments p join invoices i on i.id = p.invoice_id join contracts k on k.id = i.contract_id
         join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
         where (p.paid_at at time zone $3)::date between $1::date and $2::date
         group by 1 order by 3 desc`, [q.from, q.to, tz])).rows;
      const byPlan = await by('pl.name');
      const byMethod = await by(`coalesce(nullif(p.method, ''), case p.source when 'manual' then 'manual' else 'gateway' end)`);
      const total = byPlan.reduce((a, r) => a + r.cents, 0);
      if (q.format === 'csv') {
        await audit(c, req.ctx, 'finance.report_export', 'report', null, { name: 'receipts', from: q.from, to: q.to });
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="recebido-${q.from}_${q.to}.csv"`)
          .send(toCsv(['tipo', 'grupo', 'pagamentos', 'valor'], [
            ...byPlan.map((r) => ({ tipo: 'plano', grupo: r.grupo, pagamentos: r.pagamentos, valor: brl(r.cents) })),
            ...byMethod.map((r) => ({ tipo: 'forma', grupo: r.grupo, pagamentos: r.pagamentos, valor: brl(r.cents) }))]));
      }
      return { by_plan: byPlan, by_method: byMethod, total_cents: total };
    });
  });

  /** Contratos vigentes, com mensalidade, sem fatura (não cancelada) no mês corrente. */
  app.get('/api/finance/reports/without-invoice', { preHandler: guard('finance:read') }, async (req, reply) => {
    const q = z.object({ format: fmt }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const rows = (await c.query(
        `select k.id as contract_id, s.name as subscriber_name, pl.name as plan_name, pv.price_cents::float as price_cents, k.due_day, k.start_date::text as start_date
         from contracts k join subscribers s on s.id = k.subscriber_id join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
         where k.status = 'active' and pv.price_cents > 0
           and not exists (select 1 from invoices i where i.contract_id = k.id and i.status <> 'canceled'
                           and date_trunc('month', i.due_date) = date_trunc('month', now() at time zone ${TZ.replace(/i\.tenant_id/, 'k.tenant_id')}))
         order by s.name limit 2000`)).rows;
      if (q.format === 'csv') {
        await audit(c, req.ctx, 'finance.report_export', 'report', null, { name: 'without-invoice' });
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="sem-fatura.csv"')
          .send(toCsv(['subscriber_name', 'plan_name', 'valor', 'due_day', 'start_date'], rows.map((r) => ({ ...r, valor: brl(r.price_cents) }))));
      }
      return { rows };
    });
  });

  /** Contratos vigentes com fatura em aberto há mais de N dias: candidatos a cancelamento. Não cancela nada. */
  app.get('/api/finance/reports/to-cancel', { preHandler: guard('finance:read') }, async (req, reply) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(730).default(90), format: fmt }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      const rows = (await c.query(
        `select k.id as contract_id, s.name as subscriber_name, pl.name as plan_name, count(i.id)::int as faturas,
                coalesce(sum(i.amount_cents + i.fee_cents - i.discount_cents),0)::bigint::float as cents,
                max((now() at time zone ${TZ})::date - i.due_date)::int as dias_atraso
         from contracts k join subscribers s on s.id = k.subscriber_id join plan_versions pv on pv.id = k.plan_version_id join plans pl on pl.id = pv.plan_id
         join invoices i on i.contract_id = k.id and i.status = 'open'
         where k.status = 'active'
         group by k.id, s.name, pl.name
         having max((now() at time zone ${TZ.replace(/i\.tenant_id/, 'k.tenant_id')})::date - i.due_date) > $1
         order by dias_atraso desc limit 1000`.replace(/\$\{TZ\}/g, TZ), [q.days])).rows;
      if (q.format === 'csv') {
        await audit(c, req.ctx, 'finance.report_export', 'report', null, { name: 'to-cancel', days: q.days });
        return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="a-cancelar.csv"')
          .send(toCsv(['subscriber_name', 'plan_name', 'faturas', 'valor', 'dias_atraso'], rows.map((r) => ({ ...r, valor: brl(r.cents) }))));
      }
      return { days: q.days, rows };
    });
  });

  // ---------------------------------------------------------------- painéis
  app.get('/api/dashboard/panels', { preHandler: guard('network:read') }, async (req) => {
    const finance = req.ctx.perms.includes('finance:read');
    return withScope(req.ctx.scope, async (c) => {
      const tz = (await c.query(`select coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo') as tz`, [req.ctx.tenantId])).rows[0].tz;
      // conexões offline por faixa: contas observadas como offline, com o tempo desde o fim da última sessão conhecida
      const off = (await c.query(
        `select width_bucket(extract(epoch from (now() - last_end))/3600, array[2,4,6,12,24,48,96,144,360,720]) as faixa, count(*)::int as n
         from (select r.id, max(s.stopped_at) as last_end from service_resources r left join service_sessions s on s.resource_id = r.id
               join contracts k on k.id = r.contract_id
               where k.status = 'active' and r.desired_policy = 'active' and r.desired_version > 0 and (r.observed_session->>'online')::boolean is false
               group by r.id) x where last_end is not null group by 1 order by 1`)).rows;
      const labels = ['< 2 h', '≥ 2 h', '≥ 4 h', '≥ 6 h', '≥ 12 h', '≥ 24 h', '≥ 2 dias', '≥ 4 dias', '≥ 6 dias', '≥ 15 dias', '≥ 30 dias'];
      const offline = off.map((r: any) => ({ label: labels[r.faixa] ?? String(r.faixa), n: r.n }));
      let signal: { label: string; n: number }[] = [];
      if (req.ctx.modules.includes('olt'))
        signal = (await c.query(
          `select case when observed_rx_dbm > -7 then '> -7 dBm' when observed_rx_dbm > -16 then '-7 a -16' when observed_rx_dbm > -20 then '-16 a -20'
                       when observed_rx_dbm > -24 then '-20 a -24' when observed_rx_dbm > -28 then '-24 a -28' when observed_rx_dbm > -30 then '-28 a -30' else '< -30 dBm' end as label,
                  count(*)::int as n
           from onus where observed_state = 'authorized' and observed_rx_dbm is not null group by 1 order by min(observed_rx_dbm) desc`)).rows;
      const months = (await c.query(
        `select to_char(m, 'YYYY-MM') as month,
                (select count(*) from contracts k where date_trunc('month', k.start_date) = m)::int as ativacoes,
                (select count(*) from contracts k where k.status = 'ended' and date_trunc('month', k.end_date) = m)::int as encerramentos
         from generate_series(date_trunc('month', (now() at time zone $1)::date) - interval '11 months', date_trunc('month', (now() at time zone $1)::date), interval '1 month') m order by m`, [tz])).rows;
      const out: any = { offline, signal, contracts_by_month: months };
      if (finance) {
        out.cash_today = (await c.query(
          `select count(*) filter (where p.kind = 'payment')::int as pagamentos, coalesce(sum(p.signed_cents),0)::bigint::float as cents
           from payments p where (p.paid_at at time zone $1)::date = (now() at time zone $1)::date`, [tz])).rows[0];
        out.without_invoice = (await c.query(
          `select count(*)::int as n from contracts k join plan_versions pv on pv.id = k.plan_version_id
           where k.status = 'active' and pv.price_cents > 0 and not exists (select 1 from invoices i where i.contract_id = k.id and i.status <> 'canceled'
             and date_trunc('month', i.due_date) = date_trunc('month', (now() at time zone $1)::date))`, [tz])).rows[0].n;
      }
      out.recent_operations = (await c.query(
        `select o.created_at, o.action, o.status, o.reason, s.name as subscriber_name, k.id as contract_id
         from operations o join service_resources r on r.id = o.resource_id join contracts k on k.id = r.contract_id join subscribers s on s.id = k.subscriber_id
         order by o.created_at desc limit 8`)).rows;
      return out;
    });
  });
}
