import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope } from '../db.js';
import { requestOnuOperation, sweep, type OnuAction } from '../network/engine.js';
import { zUuid } from '../validators.js';
import { contractChangeHooks } from './cadastro.js';
import { AGENT_OFFLINE_S } from './network.js';

/** Expansão OLT/ONU: descoberta, autorização e leitura de estado. Reaproveita fila, agente, evidências e auditoria do MVP. */
const ONU_SELECT = `
  select n.*, d.name as device_name, d.driver, d.maintenance, s.id as subscriber_id, s.name as subscriber_name, k.status as contract_status,
         a.name as agent_name, (a.last_seen_at is not null and a.last_seen_at > now() - interval '${AGENT_OFFLINE_S} seconds') as agent_online,
         (n.observed_at is not null and n.desired_version > 0
           and ((n.desired_state = 'authorized') <> (n.observed_state = 'authorized'))
           and not exists (select 1 from operations o where o.onu_id = n.id and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN'))) as drift
  from onus n join devices d on d.id = n.device_id join contracts k on k.id = n.contract_id join subscribers s on s.id = k.subscriber_id
  left join agents a on a.id = d.agent_id`;
const OPS = `select o.id, o.action, o.status, o.desired_version, o.attempts, o.note, o.reason, o.created_at, o.updated_at, o.result, o.authorization_ref, u.name as requested_by
  from operations o left join users u on u.id::text = o.authorization_ref->>'id' and o.authorization_ref->>'type' = 'user'`;

// Encerramento do contrato: só desautoriza a ONU se o provedor ligou a regra (padrão: apenas avisar no painel).
contractChangeHooks.push(async (c, ctx, contractId) => {
  const n = (await c.query(
    `select n.id, d.agent_id from onus n join contracts k on k.id = n.contract_id join devices d on d.id = n.device_id
     join tenant_settings ts on ts.tenant_id = n.tenant_id
     where n.contract_id = $1 and k.status = 'ended' and n.desired_state = 'authorized' and n.desired_version > 0 and ts.onu_remove_on_contract_end`, [contractId])).rows[0];
  if (n?.agent_id) await requestOnuOperation(c, ctx.tenantId, n.id, 'onu.deauthorize', { type: 'user', id: ctx.userId, reason: 'contrato encerrado' });
});

export async function oltRoutes(app: FastifyInstance) {
  // ONUs vistas nas OLTs e ainda não autorizadas
  app.get('/api/olt/discoveries', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) =>
      (await c.query(
        `select x.id, x.device_id, d.name as device_name, d.driver, x.serial, x.pon_port, x.vendor, x.model, x.first_seen_at, x.last_seen_at
         from onu_discoveries x join devices d on d.id = x.device_id
         where not exists (select 1 from onus n where n.serial = x.serial and n.desired_state = 'authorized')
         order by x.first_seen_at desc limit 500`)).rows));

  app.get('/api/onus', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => (await c.query(`${ONU_SELECT} order by n.created_at desc limit 500`)).rows));

  app.get('/api/contracts/:id/onu', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      await sweep(c);
      const onu = (await c.query(`${ONU_SELECT} where n.contract_id = $1`, [id])).rows[0];
      if (!onu) return { onu: null, operations: [] };
      return { onu, operations: (await c.query(`${OPS} where o.onu_id = $1 order by o.created_at desc, o.desired_version desc limit 15`, [onu.id])).rows };
    });
  });

  // Vincula uma ONU ao contrato e solicita a autorização na OLT
  app.post('/api/contracts/:id/onu', { preHandler: guard('network:operate') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({
      device_id: zUuid,
      serial: z.string().trim().regex(/^[A-Za-z0-9]{8,20}$/, 'serial: 8 a 20 letras/números').transform((v) => v.toUpperCase()),
      pon_port: z.string().trim().regex(/^[0-9]{1,3}(\/[0-9]{1,3}){0,3}$/, 'porta PON no formato 0/1/3'),
      line_profile: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,60}$/, 'perfil de linha: letras, números, _ . -'),
      service_vlan: z.number().int().min(1).max(4094),
      service_profile: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,60}$/, 'perfil de serviço: letras, números, _ . -').nullish().or(z.literal('')).transform((v) => v || null),
    }).parse(req.body);
    return withScope(req.ctx.scope, async (c) => {
      const k = (await c.query('select status from contracts where id = $1', [id])).rows[0];
      if (!k) throw new HttpError(404, 'contrato não encontrado');
      if (k.status !== 'active') throw new HttpError(400, 'contrato encerrado');
      const dev = (await c.query('select driver from devices where id = $1', [b.device_id])).rows[0];
      if (!dev || !dev.driver.startsWith('olt')) throw new HttpError(400, 'o equipamento escolhido não é uma OLT');
      if (dev.driver === 'olt_huawei') {
        if (!b.service_profile) throw new HttpError(400, 'OLT Huawei exige o perfil de serviço (ont-srvprofile) da ONU');
        // a CLI Huawei usa o serial em 16 hex; aceita a forma "HWTC1A2B3C4D" e guarda sempre a mesma, para o serial ser único
        if (/^[A-Z]{4}[0-9A-F]{8}$/.test(b.serial)) b.serial = Buffer.from(b.serial.slice(0, 4), 'ascii').toString('hex').toUpperCase() + b.serial.slice(4);
        if (!/^[0-9A-F]{16}$/.test(b.serial)) throw new HttpError(400, 'serial Huawei: 16 dígitos hexadecimais ou 4 letras do fabricante + 8 hexadecimais');
        if (!/^\d+\/\d+\/\d+$/.test(b.pon_port)) throw new HttpError(400, 'porta PON Huawei no formato frame/slot/porta, ex.: 0/1/3');
      }
      // Troca de ONU: se o contrato já tem uma ONU desautorizada e confirmada como ausente, o vínculo passa para o novo equipamento
      const prev = (await c.query('select * from onus where contract_id = $1 for update', [id])).rows[0];
      if (prev && !(prev.desired_state === 'removed' && prev.observed_state === 'absent' && prev.observed_version === prev.desired_version))
        throw new HttpError(409, 'o contrato já tem uma ONU; desautorize-a e aguarde a confirmação da OLT antes de vincular outra');
      const n = prev
        ? (await c.query(`update onus set device_id = $2, serial = $3, pon_port = $4, line_profile = $5, service_vlan = $6, service_profile = $7, observed_state = null, observed_online = null,
                          observed_rx_dbm = null, observed_tx_dbm = null, observed_detail = null, observed_at = null where id = $1 returning id`,
            [prev.id, b.device_id, b.serial, b.pon_port, b.line_profile, b.service_vlan, b.service_profile])).rows[0]
        : (await c.query(
            `insert into onus (tenant_id, contract_id, device_id, serial, pon_port, line_profile, service_vlan, service_profile) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
            [req.ctx.tenantId, id, b.device_id, b.serial, b.pon_port, b.line_profile, b.service_vlan, b.service_profile])).rows[0];
      if (prev) await audit(c, req.ctx, 'onu.replace', 'onu', n.id, { previous_serial: prev.serial, serial: b.serial });
      const op = await requestOnuOperation(c, req.ctx.tenantId!, n.id, 'onu.authorize', { type: 'user', id: req.ctx.userId, reason: prev ? `troca de ONU (anterior: ${prev.serial})` : 'autorização inicial' });
      await audit(c, req.ctx, 'onu.authorize', 'onu', n.id, { operation_id: op.id, serial: b.serial, pon_port: b.pon_port });
      return { onu_id: n.id, operation_id: op.id };
    });
  });

  app.post('/api/onus/:id/:action', { preHandler: guard('network:operate') }, async (req) => {
    const p = z.object({ id: zUuid, action: z.enum(['authorize', 'deauthorize']) }).parse(req.params);
    const b = z.object({ reason: z.string().trim().max(200).optional() }).parse(req.body ?? {});
    return withScope(req.ctx.scope, async (c) => {
      const op = await requestOnuOperation(c, req.ctx.tenantId!, p.id, `onu.${p.action}` as OnuAction,
        { type: 'user', id: req.ctx.userId, reason: b.reason || (p.action === 'authorize' ? 'reaplicar autorização' : 'desautorização manual') });
      await audit(c, req.ctx, `onu.${p.action}`, 'onu', p.id, { operation_id: op.id, reason: b.reason });
      return { operation_id: op.id, status: op.status, desired_version: op.desired_version };
    });
  });
}
