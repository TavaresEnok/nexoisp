import { HttpError } from './auth.js';
import { withScope, type Tx } from './db.js';
import { queueNotice } from './notify.js';
import { emitEvent } from './webhooks.js';

/** Estados de uma OS que ainda não foi encerrada. */
export const OPEN_WO = ['open', 'analysis', 'awaiting_schedule', 'scheduled', 'en_route', 'in_progress'] as const;
export const OPEN_WO_SQL = OPEN_WO.map((s) => `'${s}'`).join(',');

const SYS = (tenantId: string) => ({ tenantId, operator: false });
const TABLE = { ticket: 'tickets', work_order: 'work_orders' } as const;
type Entity = keyof typeof TABLE;

/** O item do catálogo precisa existir neste provedor, estar ativo e ser do tipo certo. */
export async function assertCatalog(c: Tx, id: string | null | undefined, kind: string, label: string) {
  if (!id) return;
  const r = (await c.query('select kind, active from catalog_items where id = $1', [id])).rows[0];
  if (!r || r.kind !== kind) throw new HttpError(400, `${label}: item de catálogo inválido`);
  if (!r.active) throw new HttpError(400, `${label}: o item está inativo`);
}

/**
 * Vincula a ocorrência à política de SLA mais específica e calcula o prazo (minutos corridos desde a abertura).
 * Sem política que se aplique, limpa o prazo. Chamar de novo ao mudar prioridade, tipo ou natureza.
 */
export async function applySla(c: Tx, entity: Entity, id: string) {
  const t = TABLE[entity];
  const row = (await c.query(`select * from ${t} where id = $1`, [id])).rows[0];
  if (!row) return null;
  const p = (await c.query(
    entity === 'ticket'
      ? `select id, resolution_minutes from sla_policies
         where active and applies_to = 'ticket' and (priority is null or priority = $1) and (type_id is null or type_id = $2)
         order by ((priority is not null)::int + (type_id is not null)::int) desc, resolution_minutes limit 1`
      : `select id, resolution_minutes from sla_policies
         where active and applies_to = 'work_order' and (kind is null or kind = $1)
         order by (kind is not null)::int desc, resolution_minutes limit 1`,
    entity === 'ticket' ? [row.priority, row.type_id ?? null] : [row.kind])).rows[0];
  await c.query(
    `update ${t} set sla_policy_id = $2, sla_due_at = case when $2::uuid is null then null else created_at + make_interval(mins => $3::int) end, sla_breached_at = null where id = $1`,
    [id, p?.id ?? null, p?.resolution_minutes ?? null]);
  return p ?? null;
}

/** Marca prazos vencidos (uma vez), avisa a equipe e, se a política pedir, passa a ocorrência ao responsável de escalonamento. */
export async function runSla(tenantId: string): Promise<{ tickets: number; work_orders: number }> {
  return withScope(SYS(tenantId), async (c) => {
    const out = { tickets: 0, work_orders: 0 };
    const tk = (await c.query(
      `update tickets t set sla_breached_at = now()
       where t.tenant_id = $1 and t.status <> 'closed' and t.sla_breached_at is null and t.sla_due_at is not null and t.sla_due_at < now()
       returning t.id, t.number, t.subject, t.assignee_id, t.sla_policy_id`, [tenantId])).rows;
    for (const t of tk) {
      out.tickets++;
      const esc = t.sla_policy_id ? (await c.query('select p.name, p.escalate_to, u.name as to_name from sla_policies p left join users u on u.id = p.escalate_to where p.id = $1', [t.sla_policy_id])).rows[0] : null;
      let note = `Prazo de SLA vencido (${esc?.name ?? 'política'}).`;
      if (esc?.escalate_to && esc.escalate_to !== t.assignee_id) {
        await c.query('update tickets set assignee_id = $2, updated_at = now() where id = $1', [t.id, esc.escalate_to]);
        note += ` Escalonado para ${esc.to_name}.`;
      }
      await c.query(`insert into ticket_messages (tenant_id, ticket_id, author_kind, body, internal) values ($1,$2,'staff',$3,true)`, [tenantId, t.id, note]);
      await queueNotice(c, tenantId, 'sla.breached', `SLA vencido no atendimento ${t.number}: ${t.subject}`, { ticket_id: t.id, number: t.number });
      await emitEvent(c, tenantId, 'sla.breached', { entity: 'ticket', id: t.id, number: t.number });
    }
    const wo = (await c.query(
      `update work_orders w set sla_breached_at = now()
       where w.tenant_id = $1 and w.status in (${OPEN_WO_SQL}) and w.sla_breached_at is null and w.sla_due_at is not null and w.sla_due_at < now()
       returning w.id, w.number, w.assignee_id, w.sla_policy_id`, [tenantId])).rows;
    for (const w of wo) {
      out.work_orders++;
      const esc = w.sla_policy_id ? (await c.query('select p.name, p.escalate_to, u.name as to_name from sla_policies p left join users u on u.id = p.escalate_to where p.id = $1', [w.sla_policy_id])).rows[0] : null;
      const detail: Record<string, unknown> = { policy: esc?.name ?? null };
      if (esc?.escalate_to && esc.escalate_to !== w.assignee_id) {
        await c.query('update work_orders set assignee_id = $2, updated_at = now() where id = $1', [w.id, esc.escalate_to]);
        detail.escalated_to = esc.to_name;
      }
      await c.query(`insert into work_order_events (tenant_id, work_order_id, event, detail) values ($1,$2,'sla_breached',$3)`, [tenantId, w.id, JSON.stringify(detail)]);
      await queueNotice(c, tenantId, 'sla.breached', `SLA vencido na OS ${w.number}`, { work_order_id: w.id, number: w.number });
      await emitEvent(c, tenantId, 'sla.breached', { entity: 'work_order', id: w.id, number: w.number });
    }
    return out;
  });
}
