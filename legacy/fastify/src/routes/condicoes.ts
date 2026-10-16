import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { assertCatalog } from '../sla.js';
import { zDate, zUuid } from '../validators.js';
import { currentVersion, terminationQuote } from './cadastro.js';

/**
 * Lote 7: fidelidade com multa (C8), mudança agendada e aditivos (C9), desconto temporário e indicação (C10).
 * Combos de produtos (TV, telefonia) não entram: dependem de um catálogo de produtos além do plano de internet.
 */
const zLoyalty = z.object({
  months: z.number().int().min(1).max(60).nullable(),
  penalty_model: z.enum(['fixed', 'monthly']).nullish(),
  penalty_cents: z.number().int().min(0).max(100_000_000).nullish(),
}).superRefine((v, ctx) => {
  if (v.months !== null && (!v.penalty_model || v.penalty_cents == null)) ctx.addIssue({ code: 'custom', message: 'informe o modelo e o valor da multa' });
});

export async function condicoesRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- fidelidade
  app.put('/api/plans/:id/loyalty', { preHandler: guard('plans:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zLoyalty.parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const p = (await c.query(
        `update plans set loyalty_months = $2, penalty_model = $3, penalty_cents = $4 where id = $1 returning id, name, loyalty_months, penalty_model, penalty_cents`,
        [id, b.months, b.months === null ? null : b.penalty_model, b.months === null ? null : b.penalty_cents])).rows[0];
      if (!p) throw new HttpError(404, 'plano não encontrado');
      await audit(c, req.ctx, 'plan.loyalty', 'plan', id, b);
      return p;      // vale para contratos novos; os existentes mantêm o que contrataram
    });
  });

  app.put('/api/contracts/:id/loyalty', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zLoyalty.and(z.object({ from: zDate.optional() })).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(
        `update contracts set
           loyalty_until = case when $2::int is null then null else coalesce($3::date, start_date) + make_interval(months => $2::int) end,
           penalty_model = $4, penalty_cents = $5, updated_at = now()
         where id = $1 and status = 'active' returning loyalty_until, penalty_model, penalty_cents`,
        [id, b.months, b.from ?? null, b.months === null ? null : b.penalty_model, b.months === null ? null : b.penalty_cents])).rows[0];
      if (!r) throw new HttpError(404, 'contrato ativo não encontrado');
      await c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,'loyalty_set',$4)`,
        [req.ctx.tenantId, id, req.ctx.userId, JSON.stringify({ months: b.months, until: r.loyalty_until, model: r.penalty_model, cents: r.penalty_cents })]);
      await audit(c, req.ctx, 'contract.loyalty', 'contract', id, b);
      return r;
    });
  });

  app.get('/api/contracts/:id/termination-quote', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const q = z.object({ date: zDate.optional() }).parse(req.query);
    return withScope(req.ctx.scope, (c) => terminationQuote(c, id, q.date));
  });

  // ---------------------------------------------------------------- descontos e indicação
  app.get('/api/contracts/:id/discounts', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select d.id, d.kind, d.value, d.reason, d.from_competence, d.months, d.created_at, d.canceled_at, u.name as created_by_name,
                (d.canceled_at is null and (d.months is null or current_date < (d.from_competence + make_interval(months => d.months))::date)) as current
         from contract_discounts d left join users u on u.id = d.created_by where d.contract_id = $1 order by d.created_at desc`, [id])).rows);
  });

  app.post('/api/contracts/:id/discounts', { preHandler: guard('finance:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      kind: z.enum(['percent', 'fixed']), value: z.number().int().positive().max(100_000_000), reason: z.string().trim().min(3).max(120),
      from_competence: zDate.optional(), months: z.number().int().min(1).max(120).nullish(),
    }).superRefine((v, ctx) => { if (v.kind === 'percent' && v.value > 100) ctx.addIssue({ code: 'custom', message: 'percentual de 1 a 100' }); }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query(`select status from contracts where id = $1`, [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      if (k.status !== 'active') throw new HttpError(400, 'contrato encerrado não recebe desconto');
      // sempre o dia 1º do mês; sem data, vale a partir do mês seguinte (a fatura do mês corrente já foi gerada)
      const r = (await c.query(
        `insert into contract_discounts (tenant_id, contract_id, kind, value, reason, from_competence, months, created_by)
         values ($1,$2,$3,$4,$5, date_trunc('month', coalesce($6::date, (current_date + interval '1 month')::date))::date, $7, $8) returning *`,
        [req.ctx.tenantId, id, b.kind, b.value, b.reason, b.from_competence ?? null, b.months ?? null, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'contract.discount', 'contract', id, { discount_id: r.id, kind: b.kind, value: b.value, months: b.months ?? null });
      return r;
    });
  });

  app.delete('/api/discounts/:id', { preHandler: guard('finance:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query(`update contract_discounts set canceled_at = now() where id = $1 and canceled_at is null returning contract_id`, [id]);
      if (!r.rowCount) throw new HttpError(404, 'desconto não encontrado');
      await audit(c, req.ctx, 'contract.discount_cancel', 'contract', r.rows[0].contract_id, { discount_id: id });
      return { ok: true };       // faturas já geradas não mudam; vale para as próximas
    });
  });

  app.put('/api/contracts/:id/referral', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ referrer_subscriber_id: zUuid.nullable() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (b.referrer_subscriber_id && !(await c.query('select 1 from subscribers where id = $1', [b.referrer_subscriber_id])).rowCount)
        throw new HttpError(400, 'assinante indicador não encontrado');
      const r = (await c.query(
        `update contracts set referred_by_subscriber_id = $2 where id = $1 and ($2::uuid is null or subscriber_id <> $2) returning referred_by_subscriber_id`,
        [id, b.referrer_subscriber_id])).rows[0];
      if (!r) throw new HttpError(400, 'contrato não encontrado ou o indicador é o próprio assinante');
      await audit(c, req.ctx, 'contract.referral', 'contract', id, b);
      return r;
    });
  });

  // Quem indicou quem, com o contrato e a situação (a recompensa é um desconto comum, lançado pela equipe).
  app.get('/api/reports/referrals', { preHandler: guard('finance:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select r.id as referrer_id, r.name as referrer_name, count(*)::int as referred,
                count(*) filter (where k.status = 'active')::int as active
         from contracts k join subscribers r on r.id = k.referred_by_subscriber_id group by r.id, r.name order by 3 desc, 2 limit 200`)).rows));

  // ---------------------------------------------------------------- mudança agendada
  app.get('/api/contracts/:id/scheduled-changes', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select s.id, s.kind, s.effective_date, s.status, s.error, s.note, s.penalty, s.created_at, s.applied_at, p.name as plan_name, s.due_day, u.name as created_by_name
         from scheduled_changes s left join plans p on p.id = s.plan_id left join users u on u.id = s.created_by
         where s.contract_id = $1 order by s.effective_date desc, s.created_at desc limit 50`, [id])).rows);
  });

  app.post('/api/contracts/:id/scheduled-changes', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      kind: z.enum(['plan_change', 'due_day', 'end']), effective_date: zDate,
      plan_id: zUuid.nullish(), due_day: z.number().int().min(1).max(28).nullish(),
      end_reason_id: zUuid.nullish(), penalty: z.enum(['charge', 'waive']).nullish(), penalty_waive_reason: z.string().trim().min(5).max(200).nullish(),
      note: z.string().trim().max(300).nullish(),
    }).superRefine((v, ctx) => {
      if (v.kind === 'plan_change' && !v.plan_id) ctx.addIssue({ code: 'custom', message: 'escolha o plano' });
      if (v.kind === 'due_day' && !v.due_day) ctx.addIssue({ code: 'custom', message: 'informe o dia de vencimento' });
      if (v.penalty === 'waive' && !v.penalty_waive_reason) ctx.addIssue({ code: 'custom', message: 'informe o motivo para dispensar a multa' });
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query('select status from contracts where id = $1', [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      if (k.status !== 'active') throw new HttpError(400, 'contrato encerrado não aceita mudança agendada');
      // "hoje" é o do fuso do provedor (o mesmo critério da rotina que aplica a mudança), não o do servidor
      const d = (await c.query(
        `select ($2::date > t.today) as future, ($2::date <= t.today + 730) as near
         from (select (now() at time zone coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo'))::date as today) t`, [req.ctx.tenantId, b.effective_date])).rows[0];
      if (!d.future) throw new HttpError(400, 'a data precisa ser futura; para mudar agora use a alteração do contrato');
      if (!d.near) throw new HttpError(400, 'a data está muito distante (máximo de 2 anos)');
      if (b.kind === 'plan_change') await currentVersion(c, b.plan_id!);         // plano existe e está ativo
      if (b.kind === 'end') await assertCatalog(c, b.end_reason_id, 'end_reason', 'motivo de encerramento');
      if ((await c.query(`select 1 from scheduled_changes where contract_id = $1 and kind = $2 and status = 'pending' and effective_date = $3`, [id, b.kind, b.effective_date])).rowCount)
        throw new HttpError(409, 'já existe uma mudança igual agendada para esta data');
      const r = (await c.query(
        `insert into scheduled_changes (tenant_id, contract_id, kind, effective_date, plan_id, due_day, end_reason_id, penalty, penalty_waive_reason, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [req.ctx.tenantId, id, b.kind, b.effective_date, b.kind === 'plan_change' ? b.plan_id : null, b.kind === 'due_day' ? b.due_day : null,
          b.kind === 'end' ? b.end_reason_id ?? null : null, b.kind === 'end' ? b.penalty ?? null : null, b.kind === 'end' ? b.penalty_waive_reason ?? null : null,
          b.note ?? null, req.ctx.userId])).rows[0];
      await audit(c, req.ctx, 'contract.schedule', 'contract', id, { change_id: r.id, kind: b.kind, effective_date: b.effective_date });
      return r;
    });
  });

  app.delete('/api/scheduled-changes/:id', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query(`update scheduled_changes set status = 'canceled' where id = $1 and status = 'pending' returning contract_id`, [id]);
      if (!r.rowCount) throw new HttpError(404, 'mudança pendente não encontrada');
      await audit(c, req.ctx, 'contract.schedule_cancel', 'contract', r.rows[0].contract_id, { change_id: id });
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- aditivos
  app.get('/api/contracts/:id/amendments', { preHandler: guard('contracts:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select a.id, a.kind, a.title, a.body, a.effective_date, a.created_at, u.name as created_by_name
         from contract_amendments a left join users u on u.id = a.created_by where a.contract_id = $1 order by a.effective_date desc, a.created_at desc`, [id])).rows);
  });

  app.post('/api/contracts/:id/amendments', { preHandler: guard('contracts:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      kind: z.enum(['address', 'holder', 'plan', 'condition', 'other']), title: z.string().trim().min(3).max(120),
      body: z.string().trim().min(1).max(4000), effective_date: zDate.optional(),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from contracts where id = $1', [id])).rowCount) throw new HttpError(404, 'contrato não encontrado');
      const r = (await c.query(
        `insert into contract_amendments (tenant_id, contract_id, kind, title, body, effective_date, created_by) values ($1,$2,$3,$4,$5,coalesce($6::date, current_date),$7) returning *`,
        [req.ctx.tenantId, id, b.kind, b.title, b.body, b.effective_date ?? null, req.ctx.userId])).rows[0];
      await c.query(`insert into contract_history (tenant_id, contract_id, actor_id, event, detail) values ($1,$2,$3,'amendment',$4)`,
        [req.ctx.tenantId, id, req.ctx.userId, JSON.stringify({ title: b.title, kind: b.kind })]);
      await audit(c, req.ctx, 'contract.amendment', 'contract', id, { amendment_id: r.id, kind: b.kind });
      return r;
    });
  });
}
