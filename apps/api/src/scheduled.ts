import { withScope } from './db.js';
import { changeContract } from './routes/cadastro.js';
import './routes/network.js';    // registram os contractChangeHooks usados por changeContract
import './routes/olt.js';
import { emitEvent } from './webhooks.js';

/**
 * Aplica as mudanças de contrato agendadas cuja data chegou (data no fuso do provedor). Cada mudança roda na própria
 * transação: se uma falhar, fica "failed" com o motivo e as demais seguem. Autoria: sistema.
 */
export async function applyScheduledChanges(tenantId: string): Promise<{ applied: number; failed: number }> {
  const scope = { tenantId, operator: false };
  const due = await withScope(scope, async (c) => (await c.query(
    `select s.* from scheduled_changes s
     where s.status = 'pending' and s.effective_date <= (now() at time zone coalesce((select timezone from tenant_settings where tenant_id = $1), 'America/Sao_Paulo'))::date
     order by s.effective_date, s.created_at limit 50`, [tenantId])).rows);
  let applied = 0, failed = 0;
  for (const s of due) {
    try {
      await withScope(scope, async (c) => {
        await changeContract(c, { tenantId, userId: null }, s.contract_id, {
          ...(s.kind === 'plan_change' ? { plan_id: s.plan_id } : {}),
          ...(s.kind === 'due_day' ? { due_day: s.due_day } : {}),
          ...(s.kind === 'end' ? { end: true, end_reason_id: s.end_reason_id, end_note: s.note ?? 'encerramento agendado', penalty: s.penalty ?? undefined, penalty_waive_reason: s.penalty_waive_reason ?? undefined } : {}),
          penalty_due_days: 10,
        }, 'mudanca-agendada');
        await c.query(`update scheduled_changes set status = 'applied', applied_at = now() where id = $1`, [s.id]);
        await emitEvent(c, tenantId, 'contract.changed', { contract_id: s.contract_id, kind: s.kind, scheduled: true });
      });
      applied++;
    } catch (e) {
      failed++;
      await withScope(scope, (c) => c.query(`update scheduled_changes set status = 'failed', error = $2 where id = $1`, [s.id, (e as Error).message.slice(0, 300)]));
    }
  }
  return { applied, failed };
}
