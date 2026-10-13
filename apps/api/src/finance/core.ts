import { HttpError } from '../auth.js';
import { noScope, withScope, type Tx } from '../db.js';
import { requestOperation } from '../network/engine.js';
import { getGateway, type GatewayEvent, type GatewayPayment } from './gateway.js';

export const NONPAYMENT = 'inadimplência';
const SYS = (tenantId: string) => ({ tenantId, operator: false });

export async function getSettings(c: Tx, tenantId: string) {
  return (await c.query('select * from tenant_settings where tenant_id = $1', [tenantId])).rows[0] ??
    { tenant_id: tenantId, timezone: 'America/Sao_Paulo', gateway: 'none', billing_auto: false, auto_suspend: false, suspend_after_days: null, auto_resume_on_payment: false,
      suspension_mode: 'reject', suspension_profile: null,
      trust_release_enabled: false, trust_release_days: 3, trust_release_gap_days: 30, late_fee_percent: 0, interest_monthly_percent: 0, prorate_first_month: false };
}
const sysAudit = (c: Tx, tenantId: string, action: string, entity: string, id: string | null, detail: object = {}, result = 'ok') =>
  c.query(`insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail) values ($1,'system','billing',$2,$3,$4,$5,$6)`,
    [tenantId, action, entity, id, result, JSON.stringify(detail)]);

/** Recorrência idempotente: reexecutar para a mesma competência não cria segunda fatura (índice único + ON CONFLICT).
 *  Com `prorate_first_month`, o primeiro mês de um contrato que começou depois do dia 1º é cobrado pelos dias de uso. */
export async function generateMonthly(c: Tx, tenantId: string, competence: string) {
  const prorate = !!(await getSettings(c, tenantId)).prorate_first_month;
  const created = (await c.query(
    `insert into invoices (tenant_id, contract_id, subscriber_id, kind, competence, due_date, amount_cents)
     select k.tenant_id, k.id, k.subscriber_id, 'monthly', $2::date, $2::date + (k.due_day - 1),
            case when $3::boolean and k.start_date > $2::date
                 then greatest(1, round(pv.price_cents::numeric * (($2::date + interval '1 month')::date - k.start_date) / (($2::date + interval '1 month')::date - $2::date))::int)
                 else pv.price_cents end
     from contracts k join plan_versions pv on pv.id = k.plan_version_id
     where k.tenant_id = $1 and k.status = 'active' and k.start_date < ($2::date + interval '1 month') and pv.price_cents > 0
     on conflict (tenant_id, contract_id, competence, kind) where competence is not null do nothing
     returning id, contract_id, amount_cents`, [tenantId, competence, prorate])).rows;
  for (const i of created)
    await c.query(
      `insert into invoice_items (tenant_id, invoice_id, description, amount_cents)
       select $1, $2, 'Mensalidade ' || p.name || ' — ' || to_char($4::date, 'MM/YYYY')
                       || case when $3 < pv.price_cents then ' (proporcional ao período de uso)' else '' end, $3
       from contracts k join plan_versions pv on pv.id = k.plan_version_id join plans p on p.id = pv.plan_id where k.id = $5`,
      [tenantId, i.id, i.amount_cents, competence, i.contract_id]);
  return created.length;
}

/** Emite a cobrança no gateway para faturas ainda sem cobrança (repetível). Títulos importados NÃO são cobrados automaticamente. */
export async function ensureCharges(c: Tx, tenantId: string) {
  const s = await getSettings(c, tenantId);
  const gw = getGateway(s.gateway);
  if (!gw) return 0;
  const pend = (await c.query(`select id, tenant_id, amount_cents, due_date from invoices where status = 'open' and gateway_charge_id is null and external_source is null for update skip locked`)).rows;
  for (const inv of pend) {
    const ch = await gw.createCharge(c, inv);
    await c.query('update invoices set gateway = $2, gateway_charge_id = $3, payment_methods = $4 where id = $1', [inv.id, gw.name, ch.chargeId, JSON.stringify(ch.methods)]);
  }
  return pend.length;
}

/**
 * Registra um pagamento informado pelo gateway. Deduplica por (gateway, payment_id).
 * Valor diferente do devido NÃO é baixado automaticamente: a fatura vai para conciliação.
 */
export async function applyGatewayPayment(c: Tx, invoiceId: string, gateway: string, p: GatewayPayment, source: 'gateway_event' | 'reconciliation') {
  const inv = (await c.query('select * from invoices where id = $1 for update', [invoiceId])).rows[0];
  const ins = await c.query(
    `insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, gateway, gateway_payment_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (gateway, gateway_payment_id) where gateway_payment_id is not null do nothing`,
    [inv.tenant_id, inv.id, p.amountCents, p.paidAt, p.method ?? null, source, gateway, p.paymentId]);
  if (!ins.rowCount) return { duplicate: true, status: inv.status as string };
  return { duplicate: false, status: await settle(c, inv) };
}

/** Valor devido hoje: o da cobrança + multa/juros já aplicados − desconto − o que já foi pago (estornos descontados). */
export interface Due { amount_cents: number; fee_cents: number; discount_cents: number; paid_cents: number; remaining_cents: number; days_late: number;
  fine_cents: number; interest_cents: number; fee_if_applied_cents: number }
export async function dueBreakdown(c: Tx, invoiceId: string): Promise<Due & { status: string; due_date: string }> {
  const r = (await c.query(
    `select i.status, i.due_date::text as due_date, i.amount_cents, i.fee_cents, i.discount_cents,
            case when i.status = 'open' then greatest(0, (now() at time zone coalesce(ts.timezone, 'America/Sao_Paulo'))::date - i.due_date)::int else 0 end as days_late,
            coalesce(ts.late_fee_percent, 0)::float as fine_pct, coalesce(ts.interest_monthly_percent, 0)::float as int_pct,
            (select coalesce(sum(signed_cents), 0)::int from payments p where p.invoice_id = i.id) as paid_cents
     from invoices i left join tenant_settings ts on ts.tenant_id = i.tenant_id where i.id = $1`, [invoiceId])).rows[0];
  if (!r) throw new HttpError(404, 'fatura não encontrada');
  const fine = r.days_late > 0 ? Math.round(r.amount_cents * r.fine_pct / 100) : 0;
  const interest = r.days_late > 0 ? Math.round(r.amount_cents * r.int_pct / 100 * r.days_late / 30) : 0;
  const feeIfApplied = Math.max(r.fee_cents, fine + interest);
  return { status: r.status, due_date: r.due_date, amount_cents: r.amount_cents, fee_cents: r.fee_cents, discount_cents: r.discount_cents, paid_cents: r.paid_cents,
    remaining_cents: Math.max(0, r.amount_cents + r.fee_cents - r.discount_cents - r.paid_cents), days_late: r.days_late,
    fine_cents: fine, interest_cents: interest, fee_if_applied_cents: feeIfApplied };
}

async function settle(c: Tx, inv: any, opts: { partial?: boolean } = {}): Promise<string> {
  const cur = (await c.query('select amount_cents, fee_cents, discount_cents from invoices where id = $1', [inv.id])).rows[0];
  const due = cur.amount_cents + cur.fee_cents - cur.discount_cents;
  const total = (await c.query('select coalesce(sum(signed_cents),0)::int as t from payments where invoice_id = $1', [inv.id])).rows[0].t;
  let status: string, note: string | null = null;
  if (inv.status === 'canceled') [status, note] = ['reconciling', 'pagamento recebido para fatura cancelada'];
  else if (inv.status === 'paid') [status, note] = ['reconciling', 'pagamento adicional recebido para fatura já paga'];
  else if (total === due) status = 'paid';
  else if (opts.partial && total > 0 && total < due) [status, note] = ['open', `pago parcialmente: ${total} de ${due} centavos`];
  else [status, note] = ['reconciling', `valor recebido (${total} centavos) difere do valor da fatura (${due} centavos)`];
  await c.query(`update invoices set status = $2, status_note = $3, paid_at = case when $2 = 'paid' then now() else paid_at end where id = $1`, [inv.id, status, note]);
  if (status === 'paid') await onInvoicePaid(c, inv);
  return status;
}

export interface ManualPaymentInput { amount_cents: number; paid_at: string; method?: string | null; note: string;
  apply_fees?: boolean; discount_cents?: number; discount_reason?: string; partial?: boolean }

/** Baixa manual (auditada por quem chama). Pode aplicar multa/juros pela política do provedor, conceder desconto e ser parcial. */
export async function manualPayment(c: Tx, invoiceId: string, userId: string, b: ManualPaymentInput) {
  const inv = (await c.query('select * from invoices where id = $1 for update', [invoiceId])).rows[0];
  if (!inv) throw new HttpError(404, 'fatura não encontrada');
  if (inv.status !== 'open' && inv.status !== 'reconciling') throw new HttpError(400, 'fatura não está em aberto');
  const d = await dueBreakdown(c, invoiceId);
  if (b.apply_fees && d.fee_if_applied_cents > inv.fee_cents) {
    const s = await getSettings(c, inv.tenant_id);
    const delta = d.fee_if_applied_cents - inv.fee_cents;
    await c.query('update invoices set fee_cents = $2 where id = $1', [invoiceId, d.fee_if_applied_cents]);
    await c.query('insert into invoice_items (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)',
      [inv.tenant_id, invoiceId, `Multa e juros por atraso (${d.days_late} dia(s); multa ${Number(s.late_fee_percent)}% + juros ${Number(s.interest_monthly_percent)}% a.m.)`, delta]);
  }
  if (b.discount_cents) {
    if (!b.discount_reason) throw new HttpError(400, 'informe o motivo do desconto');
    const cap = inv.amount_cents + Math.max(inv.fee_cents, b.apply_fees ? d.fee_if_applied_cents : 0) - inv.discount_cents;
    if (b.discount_cents > cap) throw new HttpError(400, 'o desconto não pode ser maior que o valor da fatura');
    await c.query('update invoices set discount_cents = discount_cents + $2 where id = $1', [invoiceId, b.discount_cents]);
    await c.query('insert into invoice_items (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)',
      [inv.tenant_id, invoiceId, `Desconto: ${b.discount_reason}`, -b.discount_cents]);
  }
  await c.query(`insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note, created_by) values ($1,$2,$3,$4,$5,'manual',$6,$7)`,
    [inv.tenant_id, inv.id, b.amount_cents, b.paid_at, b.method ?? null, b.note, userId]);
  return settle(c, { ...inv, status: 'open' }, { partial: b.partial });
}

/**
 * Estorno de uma baixa manual: grava uma linha de estorno (pagamentos são só de inserção) e reabre a fatura.
 * Não desfaz sozinho o que a baixa provocou na rede (reativação): a política de suspensão decide depois.
 * Baixa do gateway não é estornada aqui: o dinheiro só volta pelo gateway, que avisa por evento (fica em conciliação).
 */
export async function reversePayment(c: Tx, invoiceId: string, paymentId: string, userId: string, reason: string) {
  const inv = (await c.query('select * from invoices where id = $1 for update', [invoiceId])).rows[0];
  if (!inv) throw new HttpError(404, 'fatura não encontrada');
  const p = (await c.query('select * from payments where id = $1 and invoice_id = $2', [paymentId, invoiceId])).rows[0];
  if (!p) throw new HttpError(404, 'pagamento não encontrado nesta fatura');
  if (p.kind !== 'payment') throw new HttpError(400, 'este lançamento já é um estorno');
  if (p.source !== 'manual') throw new HttpError(400, 'somente baixas manuais são estornadas aqui; pagamentos do gateway voltam pelo gateway');
  if (inv.status === 'canceled') throw new HttpError(400, 'fatura cancelada');
  try {
    await c.query(`insert into payments (tenant_id, invoice_id, amount_cents, paid_at, method, source, note, created_by, kind, reversal_of)
                   values ($1,$2,$3,now(),$4,'manual',$5,$6,'reversal',$7)`, [inv.tenant_id, invoiceId, p.amount_cents, p.method, `estorno: ${reason}`, userId, paymentId]);
  } catch (e: any) {
    if (e?.code === '23505') throw new HttpError(409, 'esta baixa já foi estornada');
    throw e;
  }
  const total = (await c.query('select coalesce(sum(signed_cents),0)::int as t from payments where invoice_id = $1', [invoiceId])).rows[0].t;
  const note = total > 0 ? `baixa estornada (${reason}); restam ${total} centavos pagos` : `baixa estornada: ${reason}`;
  await c.query(`update invoices set status = 'open', status_note = $2, paid_at = null where id = $1`, [invoiceId, note]);
  return { status: 'open', paid_cents: total };
}

/**
 * Pagamento confirmado atualiza a INTENÇÃO do serviço conforme a política vigente; a rede só aparece
 * restaurada depois da confirmação técnica do agente. Suspensão pendente fica SUPERSEDED pelo motor.
 */
export async function onInvoicePaid(c: Tx, inv: { tenant_id: string; contract_id: string; id: string }) {
  const s = await getSettings(c, inv.tenant_id);
  // pagamento que zera o atraso encerra a liberação por confiança em curso
  const left = (await c.query(
    `select 1 from invoices where contract_id = $1 and status = 'open' and id <> $2 and due_date + coalesce($3::int, 0) < (now() at time zone $4)::date limit 1`,
    [inv.contract_id, inv.id, s.suspend_after_days, s.timezone])).rowCount;
  if (!left) await c.query(`update trust_releases set status = 'settled', closed_at = now() where contract_id = $1 and status = 'active'`, [inv.contract_id]);
  if (!s.auto_resume_on_payment) return;
  const r = (await c.query(
    `select r.id, r.desired_policy, r.desired_reason, k.status from service_resources r join contracts k on k.id = r.contract_id where r.contract_id = $1 for update of r`, [inv.contract_id])).rows[0];
  if (!r || r.desired_policy !== 'suspended' || !String(r.desired_reason ?? '').startsWith(NONPAYMENT) || r.status !== 'active') return;
  const still = (await c.query(
    `select 1 from invoices where contract_id = $1 and status = 'open' and id <> $2
       and due_date + coalesce($3::int, 0) < (now() at time zone $4)::date limit 1`, [inv.contract_id, inv.id, s.suspend_after_days, s.timezone])).rowCount;
  if (still) return;
  const op = await requestOperation(c, inv.tenant_id, r.id, 'subscriber.resume', { type: 'system', id: 'billing.payment', reason: 'pagamento confirmado' });
  await sysAudit(c, inv.tenant_id, 'service.auto_resume', 'service_resource', r.id, { invoice_id: inv.id, operation_id: op.id });
}

/** Suspensão automática: SOMENTE com política explicitamente configurada pelo provedor. */
export async function autoSuspend(tenantId: string, contractId?: string): Promise<number> {
  return withScope(SYS(tenantId), async (c) => {
    const s = await getSettings(c, tenantId);
    if (!s.auto_suspend || s.suspend_after_days == null) return 0;
    const cands = (await c.query(
      `select r.id as resource_id, min(i.due_date) as due, min(i.id::text) as invoice_id
       from invoices i join service_resources r on r.contract_id = i.contract_id join contracts k on k.id = i.contract_id
       where i.status = 'open' and i.due_date + $1::int < (now() at time zone $2)::date and r.desired_policy = 'active' and r.desired_version > 0 and k.status = 'active'
         and not exists (select 1 from trust_releases t where t.contract_id = i.contract_id and t.status = 'active' and t.expires_at > now())
         and ($3::uuid is null or i.contract_id = $3)
       group by r.id`, [s.suspend_after_days, s.timezone, contractId ?? null])).rows;
    let n = 0;
    for (const k of cands) {
      // revalida sob lock: a fatura pode ter sido paga entre a consulta e agora
      const inv = (await c.query(`select id, gateway, gateway_charge_id from invoices where id = $1 and status = 'open' for update`, [k.invoice_id])).rows[0];
      if (!inv) continue;
      // antes de suspender, consulta o gateway: o evento de pagamento pode ter se perdido
      const gw = inv.gateway ? getGateway(inv.gateway) : null;
      if (gw && inv.gateway_charge_id) {
        for (const p of (await gw.getCharge(c, inv.gateway_charge_id))?.payments ?? []) await applyGatewayPayment(c, inv.id, inv.gateway, p, 'reconciliation');
        if ((await c.query('select status from invoices where id = $1', [inv.id])).rows[0].status !== 'open') continue;
      }
      const op = await requestOperation(c, tenantId, k.resource_id, 'subscriber.suspend',
        { type: 'system', id: 'billing.auto_suspend', reason: `${NONPAYMENT}: fatura vencida em ${String(k.due).split('-').reverse().join('/')}` });
      await sysAudit(c, tenantId, 'service.auto_suspend', 'service_resource', k.resource_id, { invoice_id: k.invoice_id, operation_id: op.id, after_days: s.suspend_after_days });
      n++;
    }
    return n;
  });
}

/** Evento autenticado do gateway: deduplica, correlaciona pela cobrança e processa. */
export async function processGatewayEvent(gateway: string, ev: GatewayEvent, payload: unknown) {
  const tenantId = ev.chargeId
    ? await withScope(noScope, async (c) => (await c.query('select gateway_charge_tenant($1,$2) as t', [gateway, ev.chargeId])).rows[0].t as string | null)
    : null;
  if (!tenantId) {
    await withScope(noScope, (c) => c.query('select gateway_event_unmatched($1,$2,$3,$4,$5)', [gateway, ev.eventId, ev.type, ev.chargeId, JSON.stringify(payload)]));
    return { status: 'unmatched' };
  }
  return withScope(SYS(tenantId), async (c) => {
    const ins = await c.query(
      `insert into gateway_events (tenant_id, gateway, event_id, type, charge_id, payload) values ($1,$2,$3,$4,$5,$6) on conflict (gateway, event_id) do nothing returning id`,
      [tenantId, gateway, ev.eventId, ev.type, ev.chargeId, JSON.stringify(payload)]);
    if (!ins.rowCount) return { status: 'duplicate' };
    const inv = (await c.query('select id from invoices where gateway = $1 and gateway_charge_id = $2', [gateway, ev.chargeId])).rows[0];
    let status = 'ignored', note: string | null = `tipo de evento sem tratamento: ${ev.type}`;
    if (ev.type === 'payment.confirmed' && ev.payment && Number.isInteger(ev.payment.amountCents) && ev.payment.amountCents > 0) {
      const r = await applyGatewayPayment(c, inv.id, gateway, ev.payment, 'gateway_event');
      status = r.status === 'reconciling' ? 'divergent' : 'processed';
      note = r.duplicate ? 'pagamento já registrado anteriormente' : r.status === 'reconciling' ? 'fatura encaminhada à conciliação' : null;
    } else if (ev.type === 'payment.refunded' || ev.type === 'payment.chargeback') {
      // regra de estorno não definida pelo provedor: nada é desfeito automaticamente
      await c.query(`update invoices set status = 'reconciling', status_note = $2 where id = $1`, [inv.id, `gateway informou ${ev.type}; tratar manualmente`]);
      [status, note] = ['divergent', 'estorno/contestação exige decisão manual'];
    }
    await c.query('update gateway_events set status = $2, note = $3, processed_at = now() where id = $1', [ins.rows[0].id, status, note]);
    return { status };
  });
}

/** Conciliação: consulta o gateway e recupera pagamentos cujo evento se perdeu. Não inventa baixa. */
export async function reconcile(tenantId: string) {
  return withScope(SYS(tenantId), async (c) => {
    const invs = (await c.query(`select id, gateway, gateway_charge_id from invoices where status in ('open','reconciling') and gateway_charge_id is not null`)).rows;
    const out = { checked: 0, recovered: 0, divergent: 0, unavailable: 0 };
    for (const inv of invs) {
      const gw = getGateway(inv.gateway);
      const ch = gw ? await gw.getCharge(c, inv.gateway_charge_id) : null;
      if (!ch) { out.unavailable++; continue; }
      out.checked++;
      for (const p of ch.payments) {
        const r = await applyGatewayPayment(c, inv.id, inv.gateway, p, 'reconciliation');
        if (r.duplicate) continue;
        if (r.status === 'paid') out.recovered++; else out.divergent++;
        await sysAudit(c, tenantId, 'finance.reconcile_payment', 'invoice', inv.id, { payment_id: p.paymentId, status: r.status });
      }
    }
    return out;
  });
}

export const currentCompetence = async (c: Tx, tz: string) =>
  (await c.query(`select to_char(date_trunc('month', now() at time zone $1), 'YYYY-MM-DD') as d`, [tz])).rows[0].d as string;

/** Rotina periódica. Cada automação só roda para tenants que a configuraram. */
export async function runWorkerOnce(log: (m: string) => void = () => {}, opts: { reconcile?: boolean } = {}) {
  const tenants = await withScope(noScope, async (c) => (await c.query('select * from worker_tenants()')).rows);
  for (const t of tenants) {
    try {
      if (t.billing_auto) {
        const n = await withScope(SYS(t.tenant_id), async (c) => {
          const created = await generateMonthly(c, t.tenant_id, await currentCompetence(c, t.timezone));
          await ensureCharges(c, t.tenant_id);
          if (created) await sysAudit(c, t.tenant_id, 'finance.generate_monthly', 'invoice', null, { created });
          return created;
        });
        if (n) log(`faturamento: ${n} fatura(s) geradas para ${t.tenant_id}`);
      }
      if (opts.reconcile && t.gateway !== 'none') await reconcile(t.tenant_id);
      await withScope(SYS(t.tenant_id), (c) => c.query(`update trust_releases set status = 'expired', closed_at = now() where status = 'active' and expires_at <= now()`));
      if (t.auto_suspend) {
        const n = await autoSuspend(t.tenant_id);
        if (n) log(`suspensão automática: ${n} solicitação(ões) para ${t.tenant_id}`);
      }
    } catch (e) {
      log(`rotina financeira falhou para ${t.tenant_id}: ${(e as Error).message}`);
    }
  }
}
