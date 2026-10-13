import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError, newToken, sha256 } from '../auth.js';
import { paged, withScope, type Tx } from '../db.js';
import { encryptSecret, signingPublicKey } from '../network/crypto.js';
import { OPEN, requestOperation, sweep, type Action } from '../network/engine.js';
import { zPage, zUuid } from '../validators.js';
import { contractChangeHooks } from '../hooks.js';

export const AGENT_OFFLINE_S = 30;
export const RESOURCE_SELECT = `
  select r.id, r.contract_id, r.device_id, r.pppoe_username, (r.secret_enc is not null) as has_secret,
         r.desired_version, r.desired_policy, r.desired_stage, r.desired_profile, r.desired_reason, r.desired_at,
         r.observed_policy, r.observed_profile, r.observed_session, r.observed_version, r.observed_at, r.mac,
         d.name as device_name, d.driver, d.maintenance, a.id as agent_id, a.name as agent_name, a.last_seen_at as agent_last_seen,
         (a.last_seen_at is not null and a.last_seen_at > now() - interval '${AGENT_OFFLINE_S} seconds') as agent_online,
         (r.observed_at is not null and (r.observed_policy <> r.desired_policy or (r.observed_policy = 'active' and r.observed_profile is distinct from r.desired_profile))
           and not exists (select 1 from operations o where o.resource_id = r.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))) as drift
  from service_resources r join devices d on d.id = r.device_id left join agents a on a.id = d.agent_id`;

// Mudança de contrato reflete na intenção de rede, na mesma transação.
contractChangeHooks.push(async (c: Tx, ctx, contractId) => {
  const r = (await c.query(
    `select r.id, r.desired_policy, r.desired_profile, k.status, pv.profile_name from service_resources r
     join contracts k on k.id = r.contract_id join plan_versions pv on pv.id = k.plan_version_id where r.contract_id = $1`, [contractId])).rows[0];
  if (!r) return;
  // mudança agendada roda sem usuário: a autoria é do sistema
  const authz = ctx.userId ? { type: 'user' as const, id: ctx.userId as string } : { type: 'system' as const, id: 'mudanca-agendada' };
  if (r.status === 'ended' && r.desired_policy !== 'suspended')
    await requestOperation(c, ctx.tenantId, r.id, 'subscriber.suspend', { ...authz, reason: 'contrato encerrado' });
  else if (r.status === 'active' && r.profile_name !== r.desired_profile) {
    if (r.desired_policy === 'active') await requestOperation(c, ctx.tenantId, r.id, 'subscriber.provision', { ...authz, reason: 'troca de plano' });
    else await c.query('update service_resources set desired_profile = $2 where id = $1', [r.id, r.profile_name]);
  }
});

export async function networkRoutes(app: FastifyInstance) {
  // ---- Agentes ----
  app.get('/api/agents', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select a.id, a.name, a.status, a.version, a.last_seen_at, a.last_sync_at, a.info, a.created_at, a.cert_fingerprint, a.cert_pinned_at,
                (a.last_seen_at is not null and a.last_seen_at > now() - interval '${AGENT_OFFLINE_S} seconds') as online,
                (select count(*) from devices d where d.agent_id = a.id) as devices,
                (select count(*) from operations o where o.agent_id = a.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN')) as open_operations,
                (select min(o.created_at) from operations o where o.agent_id = a.id and o.status in ('PENDING','UNCERTAIN')) as oldest_pending
         from agents a order by a.name`)).rows));

  app.post('/api/agents', { preHandler: guard('network:write') }, async (req) => {
    const b = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body);
    const token = newToken();
    return withScope(req.ctx.scope, async (c) => {
      const a = (await c.query('insert into agents (tenant_id, name, token_hash) values ($1,$2,$3) returning id, name', [req.ctx.tenantId, b.name, sha256(token)])).rows[0];
      await audit(c, req.ctx, 'agent.create', 'agent', a.id);
      // token exibido uma única vez; só o hash fica armazenado
      return { ...a, token, tenant_id: req.ctx.tenantId, signing_public_key: signingPublicKey() };
    });
  });

  app.patch('/api/agents/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ status: z.enum(['active', 'revoked']).optional(), rotate_token: z.boolean().optional(), reset_certificate: z.boolean().optional() }).parse(req.body);
    const token = b.rotate_token ? newToken() : null;
    return withScope(req.ctx.scope, async (c) => {
      // reset_certificate: descarta a impressão digital fixada; o próximo certificado válido apresentado passa a ser o único aceito
      const a = (await c.query(
        `update agents set status = coalesce($2,status), token_hash = coalesce($3,token_hash),
                cert_fingerprint = case when $4 then null else cert_fingerprint end, cert_pinned_at = case when $4 then null else cert_pinned_at end
         where id = $1 returning id, name, status`,
        [id, b.status ?? null, token ? sha256(token) : null, !!b.reset_certificate])).rows[0];
      if (!a) throw new HttpError(404, 'agente não encontrado');
      await audit(c, req.ctx, token ? 'agent.rotate_token' : b.reset_certificate ? 'agent.reset_certificate' : 'agent.update', 'agent', id, { status: b.status });
      return { ...a, token, signing_public_key: signingPublicKey() };
    });
  });

  // ---- Equipamentos (NAS) ----
  const zDevice = z.object({
    name: z.string().trim().min(2).max(80),
    driver: z.enum(['demo', 'mikrotik_radius', 'olt_demo', 'olt_huawei']),
    host: z.string().trim().max(200).nullish().transform((v) => v || null),
    api_port: z.number().int().min(1).max(65535).nullish(),
    credential_ref: z.string().trim().regex(/^[A-Za-z0-9_.-]{0,60}$/).nullish().transform((v) => v || null),
    agent_id: zUuid.nullish(),
  });
  app.get('/api/devices', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select d.*, a.name as agent_name, (a.last_seen_at is not null and a.last_seen_at > now() - interval '${AGENT_OFFLINE_S} seconds') as agent_online,
                (select count(*) from service_resources r where r.device_id = d.id) as accounts,
                (select count(*) from onus n where n.device_id = d.id and n.desired_state = 'authorized') as onus
         from devices d left join agents a on a.id = d.agent_id order by d.name`)).rows));

  app.post('/api/devices', { preHandler: guard('network:write') }, async (req) => {
    const b = zDevice.parse(req.body);
    if (b.driver.endsWith('demo') && process.env.NEXO_DEMO_MODE !== '1') throw new HttpError(400, 'driver de demonstração só é permitido em ambiente de demonstração');
    if (b.driver.startsWith('olt') && !req.ctx.modules.includes('olt')) throw new HttpError(403, 'a integração com OLT não está liberada para o provedor', 'module_disabled');
    return withScope(req.ctx.scope, async (c) => {
      const d = (await c.query(
        `insert into devices (tenant_id, name, driver, host, api_port, credential_ref, agent_id) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
        [req.ctx.tenantId, b.name, b.driver, b.host, b.api_port ?? null, b.credential_ref, b.agent_id ?? null])).rows[0];
      await audit(c, req.ctx, 'device.create', 'device', d.id, { driver: b.driver });
      return d;
    });
  });

  app.patch('/api/devices/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zDevice.partial().extend({ maintenance: z.boolean().optional() }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const cur = (await c.query('select * from devices where id = $1 for update', [id])).rows[0];
      if (!cur) throw new HttpError(404, 'equipamento não encontrado');
      const n = { ...cur, ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) };
      if (n.driver.endsWith('demo') && process.env.NEXO_DEMO_MODE !== '1') throw new HttpError(400, 'driver de demonstração só é permitido em ambiente de demonstração');
      if (n.driver.startsWith('olt') && !req.ctx.modules.includes('olt')) throw new HttpError(403, 'a integração com OLT não está liberada para o provedor', 'module_disabled');
      const d = (await c.query(
        `update devices set name=$2, driver=$3, host=$4, api_port=$5, credential_ref=$6, agent_id=$7, maintenance=$8 where id=$1 returning *`,
        [id, n.name, n.driver, n.host, n.api_port, n.credential_ref, n.agent_id, n.maintenance])).rows[0];
      await audit(c, req.ctx, 'device.update', 'device', id, b);
      return d;
    });
  });

  /** Reaplica a intenção atual de TODAS as contas do equipamento (ex.: site reinstalado, RADIUS local perdido). Explícito e auditado. */
  app.post('/api/devices/:id/reapply', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const rows = (await c.query(
        `select r.id, r.desired_policy, k.status from service_resources r join contracts k on k.id = r.contract_id
         where r.device_id = $1 and r.desired_version > 0 and r.secret_enc is not null
           and not exists (select 1 from operations o where o.resource_id = r.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))`, [id])).rows;
      let n = 0;
      for (const r of rows) {
        if (r.status !== 'active') continue;
        await requestOperation(c, req.ctx.tenantId!, r.id, 'subscriber.provision', // provision regrava credencial + política atual (liberada ou suspensa)
          { type: 'user', id: req.ctx.userId, reason: 'reaplicação em massa do equipamento' });
        n++;
      }
      await audit(c, req.ctx, 'device.reapply_all', 'device', id, { requested: n });
      return { requested: n };
    });
  });

  // ---- Serviço do contrato (conta PPPoE) ----
  app.get('/api/contracts/:id/service', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      await sweep(c);
      const r = (await c.query(`${RESOURCE_SELECT} where r.contract_id = $1`, [id])).rows[0];
      if (!r) return { resource: null, operations: [] };
      const operations = (await c.query(
        `select o.id, o.action, o.status, o.desired_version, o.attempts, o.note, o.reason, o.created_at, o.updated_at, o.finished_at, o.valid_until, o.result, o.authorization_ref,
                u.name as requested_by
         from operations o left join users u on u.id::text = o.authorization_ref->>'id' and o.authorization_ref->>'type' = 'user'
         where o.resource_id = $1 order by o.created_at desc, o.desired_version desc limit 15`, [r.id])).rows;
      return { resource: r, operations };
    });
  });

  /** Consumo mensal do contrato (a leitura é do accounting do RADIUS local; depende do agente 0.4.0+). */
  app.get('/api/contracts/:id/usage', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const id = zUuid.parse((req.params as any).id);
      return (await c.query(
        `select to_char(u.month, 'YYYY-MM') as month, u.bytes_in::float as bytes_in, u.bytes_out::float as bytes_out, u.session_seconds::float as session_seconds, u.sessions, u.reported_at
         from usage_monthly u join service_resources r on r.id = u.resource_id where r.contract_id = $1 order by u.month desc limit 12`, [id])).rows;
    }));

  app.post('/api/contracts/:id/service', { preHandler: guard('network:operate') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      device_id: zUuid,
      pppoe_username: z.string().trim().regex(/^[A-Za-z0-9_.@-]{3,64}$/, 'usuário PPPoE: 3 a 64 caracteres (letras, números, _ . @ -)'),
      password: z.string().min(6, 'senha PPPoE: mínimo de 6 caracteres').max(64).optional(),
    }).parse(req.body);
    const generated = b.password ? null : randomBytes(9).toString('base64url');
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query(`select k.status, pv.profile_name from contracts k join plan_versions pv on pv.id = k.plan_version_id where k.id = $1`, [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      if (k.status !== 'active') throw new HttpError(400, 'contrato encerrado');
      if ((await c.query('select driver from devices where id = $1', [b.device_id])).rows[0]?.driver?.startsWith('olt'))
        throw new HttpError(400, 'o equipamento escolhido é uma OLT; a conta PPPoE precisa de um concentrador (NAS)');
      const r = (await c.query(
        `insert into service_resources (tenant_id, contract_id, device_id, pppoe_username, secret_enc, desired_profile) values ($1,$2,$3,$4,$5,$6) returning id`,
        [req.ctx.tenantId, id, b.device_id, b.pppoe_username, encryptSecret(b.password ?? generated!), k.profile_name])).rows[0];
      const op = await requestOperation(c, req.ctx.tenantId!, r.id, 'subscriber.provision', { type: 'user', id: req.ctx.userId, reason: 'provisionamento inicial' });
      await audit(c, req.ctx, 'service.provision', 'service_resource', r.id, { operation_id: op.id, username: b.pppoe_username });
      // senha gerada é devolvida uma única vez para configurar o equipamento do assinante; não é registrada em log/auditoria
      return { resource_id: r.id, operation_id: op.id, generated_password: generated };
    });
  });

  app.post('/api/resources/:id/:action', { preHandler: guard('network:operate') }, async (req) => {
    const p = z.object({ id: zUuid, action: z.enum(['provision', 'suspend', 'resume']) }).parse(req.params);
    const b = z.object({ reason: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    const idem = req.headers['idempotency-key'];
    return withScope(req.ctx.scope, async (c) => {
      const op = await requestOperation(c, req.ctx.tenantId!, p.id, `subscriber.${p.action}` as Action,
        { type: 'user', id: req.ctx.userId, reason: b.reason || 'solicitação manual' }, typeof idem === 'string' && idem ? `user:${idem}` : undefined);
      await audit(c, req.ctx, `service.${p.action}`, 'service_resource', p.id, { operation_id: op.id, reason: b.reason });
      return { operation_id: op.id, status: op.status, desired_version: op.desired_version };
    });
  });

  /** Vincula (ou desvincula) o MAC do equipamento do assinante à conta; reaplica a autorização na rede. */
  app.patch('/api/resources/:id/mac', { preHandler: guard('network:operate') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      mac: z.string().trim().transform((v) => v.toUpperCase().replace(/[-.]/g, ':')).pipe(z.string().regex(/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/, 'MAC inválido (ex.: 02:4E:58:00:00:02)')).nullable(),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query('select desired_version, desired_policy, mac from service_resources where id = $1 for update', [id])).rows[0];
      if (!r) throw new HttpError(404, 'conta PPPoE não encontrada');
      if ((r.mac ?? null) === b.mac) return { operation_id: null, changed: false };
      await c.query('update service_resources set mac = $2 where id = $1', [id, b.mac]);
      // conta já provisionada: a nova autorização segue pela fila, com a política em vigor
      const op = r.desired_version > 0
        ? await requestOperation(c, req.ctx.tenantId!, id, r.desired_policy === 'suspended' ? 'subscriber.suspend' : 'subscriber.provision',
          { type: 'user', id: req.ctx.userId, reason: b.mac ? `vínculo do MAC ${b.mac}` : 'MAC desvinculado' })
        : null;
      await audit(c, req.ctx, 'service.mac_change', 'service_resource', id, { mac: b.mac, previous: r.mac, operation_id: op?.id ?? null });
      return { operation_id: op?.id ?? null, changed: true };
    });
  });

  app.patch('/api/resources/:id/secret', { preHandler: guard('network:operate') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ password: z.string().min(6).max(64) }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query('update service_resources set secret_enc = $2 where id = $1 returning desired_version, desired_policy', [id, encryptSecret(b.password)])).rows[0];
      if (!r) throw new HttpError(404, 'conta PPPoE não encontrada');
      // conta importada ainda não provisionada: só guarda a credencial; o provisionamento é ação separada
      const op = r.desired_version > 0 && r.desired_policy === 'active'
        ? await requestOperation(c, req.ctx.tenantId!, id, 'subscriber.provision', { type: 'user', id: req.ctx.userId, reason: 'troca de senha PPPoE' }) : null;
      await audit(c, req.ctx, 'service.secret_change', 'service_resource', id, { operation_id: op?.id ?? null });
      return { operation_id: op?.id ?? null };
    });
  });

  // ---- Operações ----
  app.get('/api/operations', { preHandler: guard('network:read') }, async (req, reply) => {
    const q = z.object({ filter: z.enum(['all', 'open', 'problem']).default('all'), ...zPage }).parse(req.query);
    return withScope(req.ctx.scope, async (c) => {
      await sweep(c);
      return paged(c, reply,
        `select o.id, o.action, o.status, o.desired_version, o.attempts, o.note, o.reason, o.created_at, o.updated_at, o.finished_at,
                coalesce(r.pppoe_username, 'ONU ' || n.serial) as pppoe_username, k.id as contract_id, s.name as subscriber_name, d.name as device_name
         from operations o left join service_resources r on r.id = o.resource_id left join onus n on n.id = o.onu_id
         join contracts k on k.id = coalesce(r.contract_id, n.contract_id)
         join subscribers s on s.id = k.subscriber_id join devices d on d.id = o.device_id
         where $1 = 'all' or ($1 = 'open' and o.status = any($2))
            or ($1 = 'problem' and (o.status in ('UNCERTAIN','FAILED','EXPIRED') or (o.status = any($2) and o.created_at < now() - interval '2 minutes')))
         order by o.created_at desc, o.id`, [q.filter, OPEN], q, 200);
    });
  });

  app.get('/api/operations/:id', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      await sweep(c);
      const o = (await c.query(
        `select id, action, status, desired_version, attempts, note, reason, parameters, idempotency_key, valid_until, authorization_ref, result, created_at, updated_at, finished_at
         from operations where id = $1`, [id])).rows[0];
      if (!o) throw new HttpError(404, 'operação não encontrada');
      o.attempt_list = (await c.query('select id, recover, status, steps, started_at, finished_at from operation_attempts where operation_id = $1 order by started_at', [id])).rows;
      return o;
    });
  });

  // MVP-13: saúde da operação de rede
  app.get('/api/network/health', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      await sweep(c);
      return (await c.query(
        `select (select count(*) from agents where status = 'active' and (last_seen_at is null or last_seen_at <= now() - interval '${AGENT_OFFLINE_S} seconds')) as agents_offline,
                (select count(*) from agents where status = 'active') as agents,
                (select count(*) from operations where status = 'UNCERTAIN') as uncertain,
                (select count(*) from operations where status in ('FAILED','EXPIRED') and finished_at > now() - interval '7 days') as failed_recent,
                (select count(*) from operations where status in ('PENDING','RESERVED','EXECUTING','VERIFYING')) as in_progress,
                (select extract(epoch from now() - min(created_at))::int from operations where status in ('PENDING','UNCERTAIN')) as oldest_pending_s,
                (select count(*) from devices where maintenance) as devices_maintenance,
                (select count(*) from (${RESOURCE_SELECT}) x where x.drift) as drift`)).rows[0];
    }));

  app.get('/api/network/drift', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(`select x.*, s.name as subscriber_name from (${RESOURCE_SELECT}) x join contracts k on k.id = x.contract_id join subscribers s on s.id = k.subscriber_id where x.drift`)).rows));
}
