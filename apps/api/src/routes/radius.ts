import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { withScope, type Tx } from '../db.js';
import { requestOperation } from '../network/engine.js';
import { ensureInternalAgent, radiusConfigured, radiusKey } from '../radius/executor.js';
import { setupCommands, VENDOR_VALIDATED, VENDORS, type Vendor } from '../radius/vendor.js';
import { zUuid } from '../validators.js';

/**
 * RADIUS integrado: o provedor cadastra o concentrador (fabricante + endereço de onde os pacotes saem) e aponta o equipamento
 * para o NexoISP. Não há nada para instalar. O segredo compartilhado é gerado aqui e mostrado uma única vez.
 */
const zIp = z.string().trim().ip({ message: 'endereço IP inválido' });
const newSecret = () => randomBytes(18).toString('base64url');
const server = () => ({
  host: process.env.NEXO_RADIUS_PUBLIC_HOST || '<endereço do NexoISP>',
  authPort: Number(process.env.NEXO_RADIUS_PORT ?? 1812), acctPort: Number(process.env.NEXO_RADIUS_PORT ?? 1812) + 1,
});
const setup = (vendor: Vendor, coaPort: number, secret: string) => {
  const s = server();
  return { server_host: s.host, auth_port: s.authPort, acct_port: s.acctPort, coa_port: coaPort, vendor, validated: VENDOR_VALIDATED[vendor],
    host_configured: !!process.env.NEXO_RADIUS_PUBLIC_HOST, commands: setupCommands(vendor, { ...s, coaPort, secret }) };
};
async function nasOf(c: Tx, deviceId: string) {
  const r = (await c.query(
    `select d.id, d.name, d.vendor, host(n.nas_ip) as nas_ip, n.coa_host, n.coa_port, n.last_packet_at from devices d join radius_nas n on n.device_id = d.id where d.id = $1`, [deviceId])).rows[0];
  if (!r) throw new HttpError(404, 'concentrador do RADIUS integrado não encontrado');
  return r;
}
/** O endereço do concentrador identifica o provedor dos pacotes: não pode se repetir em toda a plataforma. A mensagem não revela de quem é. */
const ipTaken = (e: any) => (e?.code === '23505' && String(e.constraint).includes('nas_ip')
  ? new HttpError(409, 'este endereço já está cadastrado como concentrador; cada concentrador precisa de um endereço de origem próprio') : e);

export async function radiusRoutes(app: FastifyInstance) {
  app.get('/api/radius/status', { preHandler: guard('network:read') }, async () =>
    ({ enabled: radiusConfigured(), ...server(), host_configured: !!process.env.NEXO_RADIUS_PUBLIC_HOST,
      vendors: VENDORS.map((v) => ({ id: v, validated: VENDOR_VALIDATED[v] })) }));

  app.post('/api/radius/devices', { preHandler: guard('network:write') }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(80), vendor: z.enum(VENDORS), nas_ip: zIp,
      coa_host: z.string().trim().max(200).nullish().transform((v) => v || null), coa_port: z.number().int().min(1).max(65535).default(3799),
    }).parse(req.body);
    radiusKey();
    const secret = newSecret();
    try {
      return await withScope(req.ctx.scope, async (c) => {
        const agentId = await ensureInternalAgent(c, req.ctx.tenantId!);
        const d = (await c.query(
          `insert into devices (tenant_id, name, driver, vendor, host, agent_id) values ($1,$2,'radius',$3,$4,$5) returning id, name, driver, vendor`,
          [req.ctx.tenantId, b.name, b.vendor, b.nas_ip, agentId])).rows[0];
        await c.query('insert into radius_nas (device_id, tenant_id, nas_ip, secret, coa_host, coa_port) values ($1,$2,$3,$4,$5,$6)', [d.id, req.ctx.tenantId, b.nas_ip, secret, b.coa_host, b.coa_port]);
        await audit(c, req.ctx, 'radius.device_create', 'device', d.id, { vendor: b.vendor, nas_ip: b.nas_ip });     // o segredo nunca vai para a auditoria
        return { ...d, nas_ip: b.nas_ip, secret, setup: setup(b.vendor, b.coa_port, secret) };
      });
    } catch (e) { throw ipTaken(e); }
  });

  app.patch('/api/radius/devices/:id', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ vendor: z.enum(VENDORS).optional(), nas_ip: zIp.optional(),
      coa_host: z.string().trim().max(200).nullish(), coa_port: z.number().int().min(1).max(65535).optional() }).parse(req.body);
    try {
      return await withScope(req.ctx.scope, async (c) => {
        const cur = await nasOf(c, id);
        if (b.vendor) await c.query('update devices set vendor = $2 where id = $1', [id, b.vendor]);
        await c.query(
          `update radius_nas set nas_ip = coalesce($2::inet, nas_ip), coa_host = case when $3 then $4 else coa_host end, coa_port = coalesce($5, coa_port) where device_id = $1`,
          [id, b.nas_ip ?? null, b.coa_host !== undefined, b.coa_host || null, b.coa_port ?? null]);
        if (b.nas_ip) await c.query('update devices set host = $2 where id = $1', [id, b.nas_ip]);
        await audit(c, req.ctx, 'radius.device_update', 'device', id, b);
        // trocar o fabricante muda os atributos: as contas precisam ser reaplicadas (ação explícita no painel)
        return { ...(await nasOf(c, id)), reapply_needed: !!b.vendor && b.vendor !== cur.vendor };
      });
    } catch (e) { throw ipTaken(e); }
  });

  // Instruções para o concentrador. O segredo não é devolvido de novo: vai um marcador.
  app.get('/api/radius/devices/:id/setup', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const n = await nasOf(c, zUuid.parse((req.params as any).id));
      return { ...n, setup: setup(n.vendor, n.coa_port, '<SEGREDO>') };
    }));

  app.post('/api/radius/devices/:id/secret', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const secret = newSecret();
    return withScope(req.ctx.scope, async (c) => {
      const n = await nasOf(c, id);
      await c.query('update radius_nas set secret = $2 where device_id = $1', [id, secret]);
      await audit(c, req.ctx, 'radius.secret_rotate', 'device', id);
      return { secret, setup: setup(n.vendor, n.coa_port, secret), note: 'O servidor passa a aceitar o segredo novo em até 2 minutos. Troque no concentrador em seguida: enquanto diferirem, ninguém autentica.' };
    });
  });

  /**
   * Passa um equipamento que usava agente local para o RADIUS integrado e pede a reaplicação de todas as contas (as senhas já
   * estão no NexoISP, cifradas). Os assinantes continuam conectados; só passam a autenticar aqui quando o concentrador for apontado.
   */
  app.post('/api/devices/:id/convert-to-integrated', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ vendor: z.enum(VENDORS), nas_ip: zIp, coa_host: z.string().trim().max(200).nullish().transform((v) => v || null),
      coa_port: z.number().int().min(1).max(65535).default(3799) }).parse(req.body);
    radiusKey();
    const secret = newSecret();
    try {
      return await withScope(req.ctx.scope, async (c) => {
        const d = (await c.query('select id, driver, name from devices where id = $1 for update', [id])).rows[0];
        if (!d) throw new HttpError(404, 'equipamento não encontrado');
        if (d.driver !== 'mikrotik_radius' && d.driver !== 'demo') throw new HttpError(400, 'só concentradores PPPoE podem passar ao RADIUS integrado');
        if ((await c.query(`select 1 from operations o where o.device_id = $1 and o.status in ('PENDING','RESERVED','EXECUTING','VERIFYING','UNCERTAIN')`, [id])).rowCount)
          throw new HttpError(409, 'há operações em andamento neste equipamento; aguarde concluírem');
        const agentId = await ensureInternalAgent(c, req.ctx.tenantId!);
        await c.query(`update devices set driver = 'radius', vendor = $2, agent_id = $3, host = $4, api_port = null, credential_ref = null where id = $1`, [id, b.vendor, agentId, b.nas_ip]);
        await c.query('insert into radius_nas (device_id, tenant_id, nas_ip, secret, coa_host, coa_port) values ($1,$2,$3,$4,$5,$6)', [id, req.ctx.tenantId, b.nas_ip, secret, b.coa_host, b.coa_port]);
        const rows = (await c.query(
          `select r.id from service_resources r join contracts k on k.id = r.contract_id
           where r.device_id = $1 and r.desired_version > 0 and r.secret_enc is not null and k.status = 'active'`, [id])).rows;
        for (const r of rows) await requestOperation(c, req.ctx.tenantId!, r.id, 'subscriber.provision', { type: 'user', id: req.ctx.userId, reason: 'passagem para o RADIUS integrado' });
        const semSenha = (await c.query(`select count(*)::int as n from service_resources where device_id = $1 and desired_version > 0 and secret_enc is null`, [id])).rows[0].n;
        await audit(c, req.ctx, 'radius.device_convert', 'device', id, { vendor: b.vendor, nas_ip: b.nas_ip, accounts: rows.length });
        return { id, accounts_requested: rows.length, accounts_without_secret: semSenha, secret, setup: setup(b.vendor, b.coa_port, secret) };
      });
    } catch (e) { throw ipTaken(e); }
  });

  // Log de autenticação do contrato: últimas tentativas aceitas e recusadas, como o concentrador as apresentou.
  app.get('/api/contracts/:id/radius-log', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = (await c.query(`select r.pppoe_username, d.driver from service_resources r join devices d on d.id = r.device_id where r.contract_id = $1`, [id])).rows[0];
      if (!r) return { integrated: false, rows: [] };
      if (r.driver !== 'radius') return { integrated: false, rows: [] };
      const rows = (await c.query(
        `select at, reply, calling_station, host(nas_ip) as nas_ip from radius_postauth where username = $1 order by id desc limit 50`, [r.pppoe_username])).rows;
      return { integrated: true, username: r.pppoe_username, rows };
    });
  });
}
