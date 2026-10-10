import { HttpError } from '../auth.js';
import type { Tx } from '../db.js';
import { decryptSecret, signEnvelope } from './crypto.js';

export type Action = 'subscriber.provision' | 'subscriber.suspend' | 'subscriber.resume';
export type OnuAction = 'onu.authorize' | 'onu.deauthorize';
export const OPEN = ['PENDING', 'RESERVED', 'EXECUTING', 'VERIFYING', 'UNCERTAIN'];
const RESERVE_LEASE_S = 45; // tempo para o agente chamar begin
const EXEC_LEASE_S = 120; // tempo de execução sem sinal antes de considerar incerto
const VALID_HOURS = 24;
const MAX_ATTEMPTS = 5;
/** Modalidade de suspensão de DEMONSTRAÇÃO (negar autenticação + derrubar sessão). A política comercial real é pendência do piloto. */
export const DEMO_SUSPENSION = { mode: 'reject', session: 'disconnect' } as const;

export interface Authz { type: 'user' | 'system'; id: string; reason?: string }

/**
 * Grava a nova intenção (versão crescente) e a tarefa correspondente na MESMA transação.
 * Tarefas ainda não iniciadas da intenção anterior são marcadas SUPERSEDED.
 */
export async function requestOperation(c: Tx, tenantId: string, resourceId: string, action: Action, authz: Authz, idempotencyKey?: string) {
  const r = (await c.query(
    `select r.*, k.status as contract_status, pv.profile_name, d.agent_id, d.name as device_name
     from service_resources r join contracts k on k.id = r.contract_id join plan_versions pv on pv.id = k.plan_version_id
     join devices d on d.id = r.device_id where r.id = $1 for update of r`, [resourceId])).rows[0];
  if (!r) throw new HttpError(404, 'conta PPPoE não encontrada');
  if (idempotencyKey) {
    const dup = (await c.query('select * from operations where idempotency_key = $1', [idempotencyKey])).rows[0];
    if (dup) return dup;
  }
  if (!r.agent_id) throw new HttpError(400, `equipamento "${r.device_name}" não tem agente associado`);
  if (action !== 'subscriber.suspend' && r.contract_status !== 'active') throw new HttpError(400, 'contrato encerrado não pode ser provisionado ou reativado');
  if (action === 'subscriber.provision' && !r.secret_enc) throw new HttpError(400, 'credencial PPPoE indisponível: defina a senha antes de provisionar');

  const policy = action === 'subscriber.suspend' ? 'suspended' : action === 'subscriber.resume' ? 'active' : r.desired_policy;
  const version = r.desired_version + 1;
  await c.query(
    `update service_resources set desired_version = $2, desired_policy = $3, desired_profile = $4, desired_reason = $5, desired_at = now() where id = $1`,
    [resourceId, version, policy, r.profile_name, authz.reason ?? null]);
  await c.query(
    `update operations set status = 'SUPERSEDED', finished_at = now(), updated_at = now(), note = 'substituída pela versão ' || $2 || ' antes de iniciar'
     where resource_id = $1 and status = 'PENDING'`, [resourceId, version]);

  const id = (await c.query('select gen_random_uuid() as id')).rows[0].id as string;
  const validUntil = new Date(Date.now() + VALID_HOURS * 3600_000).toISOString();
  // IP fixo do contrato (IPAM). A chave só entra no envelope quando existe: agentes anteriores à 0.3.0 recusam campo desconhecido.
  const fixed = (await c.query(`select host(address) as ip from ip_allocations where contract_id = $1 and family(address) = 4 order by address limit 1`, [r.contract_id])).rows[0];
  const parameters = {
    username: r.pppoe_username, profile: r.profile_name, policy,
    secret_ref: action === 'subscriber.provision' ? `resource:${resourceId}` : null, // segredo nunca vai no envelope
    suspension: policy === 'suspended' ? DEMO_SUSPENSION : null,
    ...(fixed ? { framed_ip: fixed.ip as string } : {}),
  };
  const key = idempotencyKey ?? `${resourceId}:v${version}`;
  const authorization = { type: authz.type, id: authz.id };
  const envelope = JSON.stringify({
    operation_id: id, tenant_id: tenantId, resource_id: resourceId, device_id: r.device_id, agent_id: r.agent_id,
    action, schema_version: 1, desired_version: version, parameters, idempotency_key: key, valid_until: validUntil, authorization,
  });
  return (await c.query(
    `insert into operations (id, tenant_id, resource_id, device_id, agent_id, action, desired_version, parameters, idempotency_key, valid_until, authorization_ref, envelope, signature, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [id, tenantId, resourceId, r.device_id, r.agent_id, action, version, JSON.stringify(parameters), key, validUntil,
      JSON.stringify(authorization), envelope, signEnvelope(envelope), authz.reason ?? null])).rows[0];
}

/** Posse expirada: reservada sem iniciar volta à fila; iniciada vira UNCERTAIN (efeito pode ter ocorrido). */
export async function sweep(c: Tx) {
  await c.query(
    `update operations set status = 'PENDING', current_attempt_id = null, lease_until = null, updated_at = now(), note = 'reserva expirou antes de iniciar'
     where status = 'RESERVED' and lease_until < now()`);
  await c.query(
    `update operations set status = 'UNCERTAIN', lease_until = null, updated_at = now(), note = 'posse expirou durante a execução; verificar antes de repetir'
     where status in ('EXECUTING','VERIFYING') and lease_until < now()`);
  await c.query(
    `update operations set status = 'EXPIRED', finished_at = now(), updated_at = now(), note = 'prazo de validade vencido sem execução'
     where status = 'PENDING' and valid_until < now()`);
}

/** Reserva curta com SKIP LOCKED. Um executor de escrita por equipamento: nada é entregue se outra tarefa do equipamento está em curso/incerta. */
export async function reserve(c: Tx, agentId: string) {
  await sweep(c);
  // incertas primeiro (precisam ser verificadas antes de qualquer nova escrita); depois a pendente mais antiga
  const pick = (status: string) => c.query(
    `select o.* from operations o join devices d on d.id = o.device_id
     where o.agent_id = $1 and o.status = $2 and (o.next_attempt_at is null or o.next_attempt_at <= now())
       and not d.maintenance
       and not exists (select 1 from operations x where x.device_id = o.device_id and x.id <> o.id and x.status in ('RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))
     order by o.created_at, o.desired_version limit 1 for update of o skip locked`, [agentId, status]);
  const o = (await pick('UNCERTAIN')).rows[0] ?? (await pick('PENDING')).rows[0];
  if (!o) return null;
  const recover = o.status === 'UNCERTAIN';
  const att = (await c.query(
    `insert into operation_attempts (tenant_id, operation_id, agent_id, recover) values ($1,$2,$3,$4) returning id`,
    [o.tenant_id, o.id, agentId, recover])).rows[0];
  await c.query(
    `update operations set status = 'RESERVED', attempts = attempts + 1, current_attempt_id = $2, lease_until = now() + interval '${RESERVE_LEASE_S} seconds', updated_at = now() where id = $1`,
    [o.id, att.id]);
  return { attempt_id: att.id as string, recover, envelope: o.envelope as string, signature: o.signature as string };
}

async function lockAttempt(c: Tx, agentId: string, attemptId: string) {
  const a = (await c.query(
    `select a.id as attempt_id, a.status as attempt_status, o.* from operation_attempts a join operations o on o.id = a.operation_id
     where a.id = $1 and a.agent_id = $2 for update of o`, [attemptId, agentId])).rows[0];
  if (!a) throw new HttpError(404, 'tentativa não encontrada');
  return a;
}
const finishAttempt = (c: Tx, id: string, status: string, steps?: unknown) =>
  c.query(`update operation_attempts set status = $2, finished_at = now(), steps = coalesce($3::jsonb, steps) where id = $1`, [id, status, steps ? JSON.stringify(steps) : null]);

/** Revalidação imediatamente antes da escrita: posse, prazo, intenção atual e precondições. */
export async function begin(c: Tx, agentId: string, attemptId: string): Promise<{ go: boolean; reason?: string; secret?: string }> {
  const o = await lockAttempt(c, agentId, attemptId);
  if (o.status !== 'RESERVED' || o.current_attempt_id !== attemptId) return { go: false, reason: 'not_owner' };
  const r = (o.onu_id
    ? await c.query(
      `select n.desired_version, null as secret_enc, k.status as contract_status, d.maintenance from onus n join contracts k on k.id = n.contract_id
       join devices d on d.id = n.device_id where n.id = $1 for update of n`, [o.onu_id])
    : await c.query(
      `select r.*, k.status as contract_status, d.maintenance from service_resources r join contracts k on k.id = r.contract_id
       join devices d on d.id = r.device_id where r.id = $1 for update of r`, [o.resource_id])).rows[0];
  const stop = async (status: string, note: string, reason: string) => {
    await c.query(`update operations set status = $2, note = $3, finished_at = now(), updated_at = now(), lease_until = null where id = $1`, [o.id, status, note]);
    await finishAttempt(c, attemptId, status);
    return { go: false, reason };
  };
  if (r.desired_version !== o.desired_version)
    return stop('SUPERSEDED', `intenção atual é a versão ${r.desired_version}; esta tarefa (v${o.desired_version}) não foi aplicada`, 'superseded');
  if (new Date(o.valid_until) < new Date()) return stop('EXPIRED', 'prazo de validade vencido', 'expired');
  // ações que liberam serviço exigem contrato vigente; suspender/desautorizar não
  if (!['subscriber.suspend', 'onu.deauthorize'].includes(o.action) && r.contract_status !== 'active') return stop('CANCELED', 'contrato não está mais vigente', 'contract_ineligible');
  if (r.maintenance) {
    await c.query(`update operations set status = 'PENDING', current_attempt_id = null, lease_until = null, next_attempt_at = now() + interval '30 seconds', note = 'equipamento em manutenção', updated_at = now() where id = $1`, [o.id]);
    await finishAttempt(c, attemptId, 'ABANDONED');
    return { go: false, reason: 'maintenance' };
  }
  await c.query(`update operations set status = 'EXECUTING', lease_until = now() + interval '${EXEC_LEASE_S} seconds', updated_at = now() where id = $1`, [o.id]);
  await c.query(`update operation_attempts set status = 'EXECUTING' where id = $1`, [attemptId]);
  const secret = o.action === 'subscriber.provision' && r.secret_enc ? decryptSecret(r.secret_enc) : undefined;
  return { go: true, secret };
}

export async function progress(c: Tx, agentId: string, attemptId: string, status: 'EXECUTING' | 'VERIFYING', steps: unknown) {
  const o = await lockAttempt(c, agentId, attemptId);
  if (!['EXECUTING', 'VERIFYING'].includes(o.status) || o.current_attempt_id !== attemptId) return { ok: false };
  await c.query(`update operations set status = $2, lease_until = now() + interval '${EXEC_LEASE_S} seconds', updated_at = now() where id = $1`, [o.id, status]);
  await c.query(`update operation_attempts set status = $2, steps = $3 where id = $1`, [attemptId, status, JSON.stringify(steps ?? [])]);
  return { ok: true };
}

export interface Observation { resource_id: string; policy: 'active' | 'suspended' | 'absent'; profile?: string | null; session?: unknown; at: string }

/** Observação datada; nunca altera o estado desejado, e observação mais antiga não sobrescreve a mais nova. */
export async function applyObservation(c: Tx, obs: Observation, confirmedVersion?: number) {
  await c.query(
    `update service_resources set observed_policy = $2, observed_profile = $3, observed_session = $4, observed_at = $5,
            observed_version = coalesce($6, observed_version)
     where id = $1 and (observed_at is null or observed_at <= $5)`,
    [obs.resource_id, obs.policy, obs.profile ?? null, obs.session ? JSON.stringify(obs.session) : null, obs.at, confirmedVersion ?? null]);
}

export interface ResultBody { outcome: 'SUCCEEDED' | 'FAILED' | 'NOT_APPLIED'; steps: unknown[]; observed?: Omit<Observation, 'resource_id'>; onu_observed?: Omit<OnuObservation, 'onu_id'>; error?: string; recovered?: boolean }

/** Resultado da tentativa. Idempotente: reentrega devolve o que já foi registrado. Resultado antigo não altera a intenção atual. */
export async function result(c: Tx, agentId: string, attemptId: string, b: ResultBody) {
  const o = await lockAttempt(c, agentId, attemptId);
  if (!OPEN.includes(o.status)) return { ack: true, duplicate: true, status: o.status };
  if (o.status === 'PENDING' && o.current_attempt_id !== attemptId && b.outcome !== 'SUCCEEDED') return { ack: true, duplicate: true, status: o.status };
  const res = { outcome: b.outcome, steps: b.steps, observed: b.observed ?? b.onu_observed ?? null, error: b.error ?? null, recovered: !!b.recovered, attempt_id: attemptId };
  if (b.observed && o.resource_id) await applyObservation(c, { ...b.observed, resource_id: o.resource_id }, b.outcome === 'SUCCEEDED' ? o.desired_version : undefined);
  if (b.onu_observed && o.onu_id) await applyOnuObservation(c, { ...b.onu_observed, onu_id: o.onu_id }, b.outcome === 'SUCCEEDED' ? o.desired_version : undefined);
  if (b.outcome === 'SUCCEEDED') {
    await c.query(`update operations set status = 'SUCCEEDED', result = $2, finished_at = now(), updated_at = now(), lease_until = null,
                   note = $3 where id = $1`, [o.id, JSON.stringify(res), b.recovered ? 'efeito confirmado por consulta, sem repetir o comando' : null]);
    await finishAttempt(c, attemptId, 'SUCCEEDED', b.steps);
    return { ack: true, status: 'SUCCEEDED' };
  }
  const current = (o.onu_id ? await c.query('select desired_version from onus where id = $1', [o.onu_id])
    : await c.query('select desired_version from service_resources where id = $1', [o.resource_id])).rows[0].desired_version;
  let status: string, note: string;
  if (current !== o.desired_version) [status, note] = ['SUPERSEDED', `não aplicada; intenção atual é a versão ${current}`];
  else if (b.outcome === 'NOT_APPLIED') [status, note] = ['PENDING', 'consulta confirmou que o efeito não ocorreu; nova tentativa liberada'];
  else if (o.attempts >= MAX_ATTEMPTS) [status, note] = ['FAILED', b.error ?? 'falha após tentativas'];
  else [status, note] = ['PENDING', `tentativa ${o.attempts} falhou: ${b.error ?? 'erro'}`];
  await c.query(
    `update operations set status = $2, note = $3, result = $4, lease_until = null, current_attempt_id = null, updated_at = now(),
            next_attempt_at = case when $2 = 'PENDING' and $5 then now() + (interval '5 seconds' * power(2, attempts)) else null end,
            finished_at = case when $2 = 'PENDING' then null else now() end where id = $1`,
    [o.id, status, note, JSON.stringify(res), b.outcome === 'FAILED']);
  await finishAttempt(c, attemptId, b.outcome, b.steps);
  return { ack: true, status };
}

// ---------------------------------------------------------------- ONU (expansão OLT/ONU)

export interface OnuObservation { onu_id: string; state: 'authorized' | 'absent'; online?: boolean | null; rx_dbm?: number | null; tx_dbm?: number | null; detail?: unknown; at: string }

/** Observação datada da ONU (estado na OLT e sinal óptico). Nunca altera a intenção. */
export async function applyOnuObservation(c: Tx, obs: OnuObservation, confirmedVersion?: number) {
  await c.query(
    `update onus set observed_state = $2, observed_online = $3, observed_rx_dbm = $4, observed_tx_dbm = $5, observed_detail = $6, observed_at = $7,
            observed_version = coalesce($8, observed_version)
     where id = $1 and (observed_at is null or observed_at <= $7)`,
    [obs.onu_id, obs.state, obs.online ?? null, obs.rx_dbm ?? null, obs.tx_dbm ?? null, obs.detail ? JSON.stringify(obs.detail) : null, obs.at, confirmedVersion ?? null]);
}

/** Mesma regra das contas PPPoE: nova intenção versionada + tarefa na mesma transação; pendentes antigas ficam SUPERSEDED. */
export async function requestOnuOperation(c: Tx, tenantId: string, onuId: string, action: OnuAction, authz: Authz) {
  const n = (await c.query(
    `select n.*, k.status as contract_status, d.agent_id, d.name as device_name from onus n join contracts k on k.id = n.contract_id
     join devices d on d.id = n.device_id where n.id = $1 for update of n`, [onuId])).rows[0];
  if (!n) throw new HttpError(404, 'ONU não encontrada');
  if (!n.agent_id) throw new HttpError(400, `OLT "${n.device_name}" não tem agente associado`);
  if (action === 'onu.authorize' && n.contract_status !== 'active') throw new HttpError(400, 'contrato encerrado: a ONU não pode ser autorizada');
  const state = action === 'onu.authorize' ? 'authorized' : 'removed';
  const version = n.desired_version + 1;
  await c.query(`update onus set desired_version = $2, desired_state = $3, desired_reason = $4, desired_at = now() where id = $1`, [onuId, version, state, authz.reason ?? null]);
  await c.query(
    `update operations set status = 'SUPERSEDED', finished_at = now(), updated_at = now(), note = 'substituída pela versão ' || $2 || ' antes de iniciar'
     where onu_id = $1 and status = 'PENDING'`, [onuId, version]);
  const id = (await c.query('select gen_random_uuid() as id')).rows[0].id as string;
  const validUntil = new Date(Date.now() + VALID_HOURS * 3600_000).toISOString();
  // o marcador na descrição da ONU permite distinguir, na leitura, o efeito desta versão
  const parameters = { serial: n.serial, pon_port: n.pon_port, line_profile: n.line_profile, service_profile: n.service_profile ?? null, service_vlan: n.service_vlan, state,
    description: `nexo:${onuId.slice(0, 8)}:v${version}` };
  const key = `onu:${onuId}:v${version}`;
  const authorization = { type: authz.type, id: authz.id };
  const envelope = JSON.stringify({
    operation_id: id, tenant_id: tenantId, resource_id: onuId, device_id: n.device_id, agent_id: n.agent_id,
    action, schema_version: 1, desired_version: version, parameters, idempotency_key: key, valid_until: validUntil, authorization,
  });
  return (await c.query(
    `insert into operations (id, tenant_id, onu_id, device_id, agent_id, action, desired_version, parameters, idempotency_key, valid_until, authorization_ref, envelope, signature, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
    [id, tenantId, onuId, n.device_id, n.agent_id, action, version, JSON.stringify(parameters), key, validUntil,
      JSON.stringify(authorization), envelope, signEnvelope(envelope), authz.reason ?? null])).rows[0];
}
