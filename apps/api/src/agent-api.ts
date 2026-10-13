import { readFileSync } from 'node:fs';
import type { TLSSocket } from 'node:tls';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { HttpError, sha256 } from './auth.js';
import { noScope, withScope, type DbScope } from './db.js';
import { signingPublicKey } from './network/crypto.js';
import { applyObservation, applyOnuObservation, begin, progress, reserve, result } from './network/engine.js';

interface AgentCtx { id: string; tenantId: string; name: string; scope: DbScope }
declare module 'fastify' {
  interface FastifyRequest { agent: AgentCtx }
}

const mtlsOff = () => process.env.NEXO_AGENT_MTLS === 'off' && process.env.NODE_ENV !== 'production';

/** Identidade individual: token do agente + certificado de cliente cujo CN é "agent:<id>" (ADR-006). */
async function authAgent(req: FastifyRequest) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'agente não autenticado');
  const a = await withScope(noScope, async (c) => (await c.query('select * from agent_auth($1)', [sha256(h.slice(7))])).rows[0]);
  if (!a || a.status !== 'active') throw new HttpError(401, 'agente desconhecido ou revogado');
  if (!mtlsOff()) {
    const sock = req.raw.socket as TLSSocket;
    const cert = sock.authorized ? sock.getPeerCertificate() : undefined;
    if (cert?.subject?.CN !== `agent:${a.id}`) throw new HttpError(401, 'certificado de cliente não corresponde ao agente');
    // Fixação: o primeiro certificado válido vira o único aceito. Trocar exige "aceitar novo certificado" no painel;
    // um certificado antigo/vazado deixa de valer mesmo estando dentro da validade e assinado pela CA.
    const fp = cert.fingerprint256;
    if (!a.cert_fingerprint) {
      await withScope({ tenantId: a.tenant_id, operator: false }, (c) =>
        c.query('update agents set cert_fingerprint = $2, cert_pinned_at = now() where id = $1 and cert_fingerprint is null', [a.id, fp]));
    } else if (a.cert_fingerprint !== fp) {
      await withScope({ tenantId: a.tenant_id, operator: false }, (c) =>
        c.query(`insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail) values ($1,'agent',$2,'agent.certificate_rejected','agent',$2,'denied',$3)`,
          [a.tenant_id, a.id, JSON.stringify({ presented: fp })])).catch(() => {});
      throw new HttpError(401, 'certificado de cliente diferente do fixado para este agente');
    }
  }
  req.agent = { id: a.id, tenantId: a.tenant_id, name: a.name, scope: { tenantId: a.tenant_id, operator: false } };
}

const zObs = z.object({
  resource_id: z.string().uuid(), policy: z.enum(['active', 'suspended', 'absent']), profile: z.string().nullish(),
  session: z.any().optional(), at: z.string().datetime({ offset: true }),
});
const zOnuObs = z.object({
  onu_id: z.string().uuid(), state: z.enum(['authorized', 'absent']), online: z.boolean().nullish(),
  rx_dbm: z.number().min(-60).max(20).nullish(), tx_dbm: z.number().min(-60).max(20).nullish(), detail: z.any().optional(), at: z.string().datetime({ offset: true }),
});
const zChecks = z.array(z.object({ device_id: z.string().uuid(), ok: z.boolean(), detail: z.string().max(500).optional(), at: z.string() })).optional();

export function agentRoutes(app: FastifyInstance) {
  app.decorateRequest('agent', null as any);
  app.addHook('preHandler', authAgent);
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: err.message });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'erro interno' });
  });

  const saveChecks = (c: any, agentId: string, checks: z.infer<typeof zChecks>) =>
    Promise.all((checks ?? []).map((k) => c.query(
      `update devices set last_check_at = $3, last_check = $4 where id = $1 and agent_id = $2`,
      [k.device_id, agentId, k.at, JSON.stringify({ ok: k.ok, detail: k.detail ?? null })])));

  /** Início de conexão: devolve equipamentos autorizados e snapshot COMPLETO e versionado da intenção. */
  app.post('/agent/v1/hello', async (req) => {
    const b = z.object({ session_id: z.string().min(8).max(80), version: z.string().max(40), info: z.record(z.any()).optional() }).parse(req.body);
    return withScope(req.agent.scope, async (c) => {
      await c.query('update agents set last_seen_at = now(), version = $2, info = $3 where id = $1', [req.agent.id, b.version, JSON.stringify(b.info ?? {})]);
      const devices = (await c.query('select id, name, driver, host, api_port, credential_ref, maintenance from devices where agent_id = $1', [req.agent.id])).rows;
      const resources = (await c.query(
        `select r.id as resource_id, r.device_id, r.pppoe_username as username, r.desired_version, r.desired_policy as policy, r.desired_profile as profile
         from service_resources r join devices d on d.id = r.device_id where d.agent_id = $1 and r.desired_version > 0`, [req.agent.id])).rows;
      const onus = (await c.query(
        `select n.id as onu_id, n.device_id, n.serial, n.desired_version, n.desired_state as state
         from onus n join devices d on d.id = n.device_id where d.agent_id = $1 and n.desired_version > 0`, [req.agent.id])).rows;
      return { agent_id: req.agent.id, tenant_id: req.agent.tenantId, signing_public_key: signingPublicKey(), devices,
        snapshot: { complete: true, generated_at: new Date().toISOString(), resources, onus } };
    });
  });

  /** Sincronização concluída: só depois disso o agente recebe novas escritas. */
  app.post('/agent/v1/sync-done', async (req) => {
    const b = z.object({ session_id: z.string(), observations: z.array(zObs).max(20000), device_checks: zChecks }).parse(req.body);
    return withScope(req.agent.scope, async (c) => {
      for (const o of b.observations) await applyObservation(c, o);
      await saveChecks(c, req.agent.id, b.device_checks);
      await c.query('update agents set sync_session_id = $2, last_sync_at = now(), last_seen_at = now() where id = $1', [req.agent.id, b.session_id]);
      return { ok: true };
    });
  });

  app.post('/agent/v1/poll', async (req) => {
    const b = z.object({ session_id: z.string() }).parse(req.body);
    return withScope(req.agent.scope, async (c) => {
      const a = (await c.query('update agents set last_seen_at = now() where id = $1 returning sync_session_id', [req.agent.id])).rows[0];
      if (a.sync_session_id !== b.session_id) return { need_sync: true, operation: null };
      return { need_sync: false, operation: await reserve(c, req.agent.id) };
    });
  });

  app.post('/agent/v1/attempts/:id/begin', async (req) =>
    withScope(req.agent.scope, (c) => begin(c, req.agent.id, z.string().uuid().parse((req.params as any).id))));

  app.post('/agent/v1/attempts/:id/progress', async (req) => {
    const b = z.object({ status: z.enum(['EXECUTING', 'VERIFYING']), steps: z.array(z.any()).max(100) }).parse(req.body);
    return withScope(req.agent.scope, (c) => progress(c, req.agent.id, z.string().uuid().parse((req.params as any).id), b.status, b.steps));
  });

  app.post('/agent/v1/attempts/:id/result', async (req) => {
    const b = z.object({
      outcome: z.enum(['SUCCEEDED', 'FAILED', 'NOT_APPLIED']), steps: z.array(z.any()).max(100),
      observed: zObs.omit({ resource_id: true }).optional(), onu_observed: zOnuObs.omit({ onu_id: true }).optional(), error: z.string().max(1000).optional(), recovered: z.boolean().optional(),
    }).parse(req.body);
    return withScope(req.agent.scope, async (c) => {
      const r = await result(c, req.agent.id, z.string().uuid().parse((req.params as any).id), b);
      await c.query(
        `insert into audit_events (tenant_id, actor_type, actor_id, action, entity_type, entity_id, result, detail) values ($1,'agent',$2,'operation.result','operation_attempt',$3,$4,$5)`,
        [req.agent.tenantId, req.agent.id, (req.params as any).id, b.outcome === 'SUCCEEDED' ? 'ok' : b.outcome.toLowerCase(), JSON.stringify({ status: r.status, duplicate: (r as any).duplicate ?? false, recovered: !!b.recovered })]);
      return r;
    });
  });

  /** Relato periódico da OLT: ONUs ainda não autorizadas (descoberta) e estado/sinal das autorizadas. */
  app.post('/agent/v1/olt-report', async (req) => {
    const b = z.object({
      device_id: z.string().uuid(),
      complete: z.boolean(),   // só um relato completo remove descobertas que deixaram de aparecer
      unauthorized: z.array(z.object({ serial: z.string().regex(/^[A-Za-z0-9]{8,20}$/), pon_port: z.string().regex(/^[0-9]{1,3}(\/[0-9]{1,3}){0,3}$/),
        vendor: z.string().max(40).nullish(), model: z.string().max(60).nullish() })).max(5000),
      states: z.array(zOnuObs).max(20000),
    }).parse(req.body);
    return withScope(req.agent.scope, async (c) => {
      const dev = (await c.query('select id from devices where id = $1 and agent_id = $2', [b.device_id, req.agent.id])).rows[0];
      if (!dev) throw new HttpError(404, 'equipamento não pertence a este agente');
      for (const u of b.unauthorized)
        await c.query(
          `insert into onu_discoveries (tenant_id, device_id, serial, pon_port, vendor, model) values ($1,$2,$3,$4,$5,$6)
           on conflict (device_id, serial) do update set pon_port = excluded.pon_port, vendor = excluded.vendor, model = excluded.model, last_seen_at = now()`,
          [req.agent.tenantId, b.device_id, u.serial.toUpperCase(), u.pon_port, u.vendor ?? null, u.model ?? null]);
      if (b.complete)
        await c.query('delete from onu_discoveries where device_id = $1 and not (serial = any($2))', [b.device_id, b.unauthorized.map((u) => u.serial.toUpperCase())]);
      for (const o of b.states) {
        const own = await c.query('select 1 from onus where id = $1 and device_id = $2', [o.onu_id, b.device_id]);
        if (own.rowCount) await applyOnuObservation(c, o);
      }
      return { ok: true };
    });
  });

  /** Consumo mensal por conta (accounting do RADIUS local). Total do mês: o relato novo substitui o anterior. */
  app.post('/agent/v1/usage-report', async (req) => {
    const b = z.object({
      device_id: z.string().uuid(),
      items: z.array(z.object({
        resource_id: z.string().uuid(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        bytes_in: z.number().int().min(0), bytes_out: z.number().int().min(0), session_seconds: z.number().int().min(0), sessions: z.number().int().min(0),
      })).max(20000),
    }).parse(req.body);
    return withScope(req.agent.scope, async (c) => {
      if (!(await c.query('select 1 from devices where id = $1 and agent_id = $2', [b.device_id, req.agent.id])).rowCount) throw new HttpError(404, 'equipamento não pertence a este agente');
      let n = 0;
      for (const u of b.items) {
        const r = await c.query(
          `insert into usage_monthly (tenant_id, resource_id, month, bytes_in, bytes_out, session_seconds, sessions)
           select $1, r.id, ($3 || '-01')::date, $4, $5, $6, $7 from service_resources r where r.id = $2 and r.device_id = $8
           on conflict (resource_id, month) do update set bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out,
             session_seconds = excluded.session_seconds, sessions = excluded.sessions, reported_at = now()`,
          [req.agent.tenantId, u.resource_id, u.month, u.bytes_in, u.bytes_out, u.session_seconds, u.sessions, b.device_id]);
        n += r.rowCount ?? 0;
      }
      return { ok: true, accepted: n };
    });
  });

  /** Sessões do accounting local (início, fim, IP, MAC, volume, motivo de encerramento). Idempotente por (conta, sessão). */
  app.post('/agent/v1/sessions-report', async (req) => {
    const b = z.object({
      device_id: z.string().uuid(),
      items: z.array(z.object({
        resource_id: z.string().uuid(), session_key: z.string().min(1).max(80), started_at: z.string().datetime({ offset: true }),
        stopped_at: z.string().datetime({ offset: true }).nullish(), ip: z.string().max(45).nullish(), mac: z.string().max(40).nullish(), nas_ip: z.string().max(45).nullish(),
        bytes_in: z.number().int().min(0), bytes_out: z.number().int().min(0), seconds: z.number().int().min(0), terminate_cause: z.string().max(60).nullish(),
      })).max(5000),
    }).parse(req.body);
    return withScope(req.agent.scope, async (c) => {
      if (!(await c.query('select 1 from devices where id = $1 and agent_id = $2', [b.device_id, req.agent.id])).rowCount) throw new HttpError(404, 'equipamento não pertence a este agente');
      let n = 0;
      for (const s of b.items) {
        const r = await c.query(
          `insert into service_sessions (tenant_id, resource_id, session_key, started_at, stopped_at, ip, mac, nas_ip, bytes_in, bytes_out, seconds, terminate_cause)
           select $1, r.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 from service_resources r where r.id = $2 and r.device_id = $13
           on conflict (resource_id, session_key) do update set stopped_at = excluded.stopped_at, ip = excluded.ip, mac = excluded.mac, nas_ip = excluded.nas_ip,
             bytes_in = excluded.bytes_in, bytes_out = excluded.bytes_out, seconds = excluded.seconds, terminate_cause = excluded.terminate_cause, reported_at = now()`,
          [req.agent.tenantId, s.resource_id, s.session_key, s.started_at, s.stopped_at ?? null, s.ip ?? null, s.mac ?? null, s.nas_ip ?? null,
            s.bytes_in, s.bytes_out, s.seconds, s.terminate_cause ?? null, b.device_id]);
        n += r.rowCount ?? 0;
      }
      return { ok: true, accepted: n };
    });
  });

  /** Observações periódicas (sessões, política aplicada) e conectividade dos equipamentos. */
  app.post('/agent/v1/observations', async (req) => {
    const b = z.object({ items: z.array(zObs).max(20000), device_checks: zChecks }).parse(req.body);
    return withScope(req.agent.scope, async (c) => {
      for (const o of b.items) await applyObservation(c, o);
      await saveChecks(c, req.agent.id, b.device_checks);
      return { ok: true };
    });
  });
}

/** Listener dedicado aos agentes com mTLS. Sem certificados configurados, não inicia (exceto NEXO_AGENT_MTLS=off fora de produção). */
export async function buildAgentApp(opts: { logger?: boolean } = {}) {
  const dir = process.env.NEXO_AGENT_TLS_DIR;
  const https = !mtlsOff() && dir
    ? { key: readFileSync(`${dir}/server.key`), cert: readFileSync(`${dir}/server.crt`), ca: readFileSync(`${dir}/ca.crt`), requestCert: true, rejectUnauthorized: true }
    : null;
  if (!https && !mtlsOff()) return null;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024, ...(https ? { https } : {}) } as any) as unknown as FastifyInstance;
  await app.register(async (a) => agentRoutes(a));
  return app;
}
