import { HttpError } from '../auth.js';
import type { Tx } from '../db.js';
import { requestOperation } from '../network/engine.js';
import { dueBreakdown, ensureCharges, getSettings } from './core.js';

const fmtDate = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

// ---------------------------------------------------------------- liberação por confiança

export interface TrustState {
  enabled: boolean;
  eligible: boolean;
  reason: string | null;           // por que não é elegível agora
  max_days: number;
  active: { id: string; granted_at: string; expires_at: string; source: string; days: number } | null;
  next_allowed_at: string | null;
  history: { id: string; granted_at: string; expires_at: string; status: string; source: string; days: number; reason: string | null; requested_by_name: string | null }[];
}

/** Situação da liberação por confiança do contrato: o que o atendente e o portal mostram. */
export async function trustState(c: Tx, tenantId: string, contractId: string): Promise<TrustState> {
  const s = await getSettings(c, tenantId);
  const k = (await c.query(
    `select k.status, r.desired_policy from contracts k left join service_resources r on r.contract_id = k.id and r.desired_version > 0 where k.id = $1`, [contractId])).rows[0];
  if (!k) throw new HttpError(404, 'contrato não encontrado');
  const history = (await c.query(
    `select t.id, t.granted_at, t.expires_at, t.status, t.source, t.days, t.reason, u.name as requested_by_name
     from trust_releases t left join users u on u.id = t.requested_by where t.contract_id = $1 order by t.granted_at desc limit 12`, [contractId])).rows;
  const active = history.find((h) => h.status === 'active' && new Date(h.expires_at) > new Date()) ?? null;
  const lastGranted = history.find((h) => h.status !== 'canceled');
  const nextAllowed = lastGranted ? new Date(new Date(lastGranted.granted_at).getTime() + s.trust_release_gap_days * 86_400_000) : null;
  let reason: string | null = null;
  if (!s.trust_release_enabled) reason = 'a liberação por confiança não está habilitada para este provedor';
  else if (k.status !== 'active') reason = 'contrato encerrado';
  else if (!k.desired_policy) reason = 'o contrato não tem acesso provisionado';
  else if (k.desired_policy !== 'suspended') reason = 'o acesso não está suspenso';
  else if (active) reason = 'já existe uma liberação em curso';
  else if (nextAllowed && nextAllowed > new Date()) reason = `nova liberação a partir de ${fmtDate(nextAllowed)}`;
  return {
    enabled: !!s.trust_release_enabled, eligible: reason === null, reason, max_days: s.trust_release_days, active: active
      ? { id: active.id, granted_at: active.granted_at, expires_at: active.expires_at, source: active.source, days: active.days } : null,
    next_allowed_at: nextAllowed && nextAllowed > new Date() ? nextAllowed.toISOString() : null, history,
  };
}

export async function grantTrustRelease(c: Tx, ctx: { tenantId: string; userId: string }, contractId: string,
  b: { days?: number; reason?: string | null; source: 'operator' | 'portal' }) {
  const st = await trustState(c, ctx.tenantId, contractId);
  if (!st.eligible) throw new HttpError(409, st.reason!);
  const days = b.days ?? st.max_days;
  if (days < 1 || days > st.max_days) throw new HttpError(400, `o prazo máximo da liberação é de ${st.max_days} dia(s)`);
  const res = (await c.query('select id from service_resources where contract_id = $1 and desired_version > 0 for update', [contractId])).rows[0];
  const t = (await c.query(
    `insert into trust_releases (tenant_id, contract_id, source, requested_by, reason, days, expires_at)
     values ($1,$2,$3,$4,$5,$6::int, now() + make_interval(days => $6::int)) returning id, expires_at`,
    [ctx.tenantId, contractId, b.source, ctx.userId, b.reason ?? null, days])).rows[0];
  // o mesmo caminho das demais operações: intenção versionada + tarefa na mesma transação
  const op = await requestOperation(c, ctx.tenantId, res.id, 'subscriber.resume', {
    type: 'user', id: ctx.userId,
    reason: `liberação por confiança até ${fmtDate(new Date(t.expires_at))}${b.source === 'portal' ? ' (pedida pelo assinante)' : ''}`,
  });
  return { id: t.id as string, expires_at: t.expires_at as string, days, operation_id: op.id as string };
}

// ---------------------------------------------------------------- acordo de pagamento

export interface AgreementInput {
  invoice_ids: string[]; installments: number; first_due_date: string; discount_cents?: number; reason: string;
  apply_fees?: boolean; release_service?: boolean;
}

/**
 * Renegociação: cancela as faturas em aberto escolhidas e gera as parcelas do acordo (uma fatura por parcela, com cobrança no gateway
 * quando houver). O saldo devido de cada fatura já desconta o que foi pago parcialmente. Tudo na mesma transação.
 */
export async function createAgreement(c: Tx, ctx: { tenantId: string; userId: string }, contractId: string, b: AgreementInput) {
  const k = (await c.query('select subscriber_id, status from contracts where id = $1', [contractId])).rows[0];
  if (!k) throw new HttpError(404, 'contrato não encontrado');
  if (k.status !== 'active') throw new HttpError(400, 'contrato encerrado');
  const ids = [...new Set(b.invoice_ids)];
  const locked = (await c.query(
    `select id, status from invoices where id = any($1::uuid[]) and contract_id = $2 for update`, [ids, contractId])).rows;
  if (locked.length !== ids.length) throw new HttpError(400, 'alguma fatura não pertence a este contrato');
  if (locked.some((i) => i.status !== 'open')) throw new HttpError(400, 'o acordo só reúne faturas em aberto');
  let original = 0;
  const applied: { id: string; fee: number }[] = [];
  for (const id of ids) {
    const d = await dueBreakdown(c, id);
    const fee = b.apply_fees ? d.fee_if_applied_cents : d.fee_cents;
    const remaining = Math.max(0, d.amount_cents + fee - d.discount_cents - d.paid_cents);
    if (remaining === 0) throw new HttpError(400, 'uma das faturas já está quitada');
    original += remaining;
    applied.push({ id, fee });
  }
  const discount = b.discount_cents ?? 0;
  const total = original - discount;
  if (discount < 0 || total < b.installments) throw new HttpError(400, 'desconto inválido para o valor do acordo');
  const a = (await c.query(
    `insert into agreements (tenant_id, contract_id, subscriber_id, total_cents, original_cents, discount_cents, installments, reason, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, contractId, k.subscriber_id, total, original, discount, b.installments, b.reason, ctx.userId])).rows[0];
  for (const f of applied) {
    await c.query(`update invoices set status = 'canceled', canceled_at = now(), fee_cents = $2, status_note = $3 where id = $1`,
      [f.id, f.fee, `renegociada no acordo ${a.id.slice(0, 8)}`]);
  }
  const base = Math.floor(total / b.installments);
  const out: { id: string; due_date: string; amount_cents: number }[] = [];
  for (let n = 1; n <= b.installments; n++) {
    const amount = n === b.installments ? total - base * (b.installments - 1) : base;
    const inv = (await c.query(
      `insert into invoices (tenant_id, contract_id, subscriber_id, kind, due_date, amount_cents, agreement_id)
       values ($1,$2,$3,'agreement', ($4::date + make_interval(months => $5::int - 1))::date, $6, $7) returning id, due_date::text as due_date, amount_cents`,
      [ctx.tenantId, contractId, k.subscriber_id, b.first_due_date, n, amount, a.id])).rows[0];
    await c.query('insert into invoice_items (tenant_id, invoice_id, description, amount_cents) values ($1,$2,$3,$4)',
      [ctx.tenantId, inv.id, `Acordo de pagamento — parcela ${n}/${b.installments}`, amount]);
    out.push(inv);
  }
  await ensureCharges(c, ctx.tenantId);
  let operationId: string | null = null;
  if (b.release_service) {
    const r = (await c.query(`select id, desired_policy from service_resources where contract_id = $1 and desired_version > 0 for update`, [contractId])).rows[0];
    if (r?.desired_policy === 'suspended')
      operationId = (await requestOperation(c, ctx.tenantId, r.id, 'subscriber.resume', { type: 'user', id: ctx.userId, reason: 'acordo de pagamento' })).id;
  }
  return { id: a.id as string, total_cents: total, original_cents: original, installments: out, operation_id: operationId };
}
