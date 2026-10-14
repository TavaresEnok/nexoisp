import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, guard, HttpError } from '../auth.js';
import { noScope, withScope, type Tx } from '../db.js';
import { requestOperation } from '../network/engine.js';
import { ensureInternalAgent, radiusConfigured, radiusKey } from '../radius/executor.js';
import { setupCommands, TUNNEL_VENDORS, VENDOR_VALIDATED, VENDORS, type Tunnel, type Vendor } from '../radius/vendor.js';
import { newPeerKeys, TUNNEL_ACCT_PORT, TUNNEL_AUTH_PORT, VPN_SERVER_IP, vpnEndpoint } from '../radius/vpn-shared.js';
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
/** Com túnel, o RADIUS é o endereço interno do servidor, nas portas padrão; sem túnel, o endereço público e as portas publicadas. */
const setup = (vendor: Vendor, coaPort: number, secret: string, tunnel: Tunnel | null = null) => {
  const s = tunnel ? { host: tunnel.serverIp, authPort: TUNNEL_AUTH_PORT, acctPort: TUNNEL_ACCT_PORT } : server();
  const ep = vpnEndpoint();
  return { server_host: s.host, auth_port: s.authPort, acct_port: s.acctPort, coa_port: coaPort, vendor, validated: VENDOR_VALIDATED[vendor],
    connection: tunnel ? 'vpn' : 'direct', tunnel: tunnel ? { tunnel_ip: tunnel.tunnelIp, endpoint: `${tunnel.endpointHost}:${tunnel.endpointPort}` } : null,
    host_configured: tunnel ? !!(process.env.NEXO_VPN_PUBLIC_HOST || process.env.NEXO_RADIUS_PUBLIC_HOST) : !!process.env.NEXO_RADIUS_PUBLIC_HOST,
    endpoint_host: ep.host, commands: setupCommands(vendor, { ...s, coaPort, secret, tunnel }) };
};
/** Cria o par do túnel para o equipamento: endereço próprio e chaves novas. Devolve a privada, que não fica guardada. */
async function newTunnel(c: Tx, tenantId: string, deviceId: string, vendor: Vendor): Promise<Tunnel> {
  if (!TUNNEL_VENDORS.includes(vendor)) throw new HttpError(400, 'o túnel pelo painel está disponível para MikroTik (RouterOS 7) e equipamentos com WireGuard; para este fabricante use o acesso direto');
  const srv = (await c.query('select public_key from vpn_settings')).rows[0];
  if (!srv) throw new HttpError(503, 'o serviço do túnel não está no ar nesta instalação', 'vpn_unavailable');
  const keys = newPeerKeys();
  const ip = (await c.query('select host(vpn_free_ip()) as ip')).rows[0].ip;
  if (!ip) throw new HttpError(503, 'sem endereços livres no túnel');
  await c.query('delete from vpn_peers where device_id = $1', [deviceId]);
  await c.query('insert into vpn_peers (device_id, tenant_id, tunnel_ip, public_key) values ($1,$2,$3,$4)', [deviceId, tenantId, ip, keys.publicKey]);
  const ep = vpnEndpoint();
  return { privateKey: keys.privateKey, serverPublicKey: srv.public_key, endpointHost: ep.host, endpointPort: ep.port, tunnelIp: ip, serverIp: VPN_SERVER_IP };
}
/** Túnel já existente, para reexibir as instruções (sem a chave privada). */
async function tunnelOf(c: Tx, deviceId: string): Promise<Tunnel | null> {
  const p = (await c.query('select host(p.tunnel_ip) as ip, (select public_key from vpn_settings) as srv from vpn_peers p where p.device_id = $1', [deviceId])).rows[0];
  if (!p) return null;
  const ep = vpnEndpoint();
  return { privateKey: '<CHAVE PRIVADA DO TÚNEL>', serverPublicKey: p.srv ?? '<chave do servidor>', endpointHost: ep.host, endpointPort: ep.port, tunnelIp: p.ip, serverIp: VPN_SERVER_IP };
}
async function nasOf(c: Tx, deviceId: string) {
  const r = (await c.query(
    `select d.id, d.name, d.vendor, host(n.nas_ip) as nas_ip, n.coa_host, n.coa_port, n.last_packet_at,
            (select p.last_handshake_at from vpn_peers p where p.device_id = d.id) as tunnel_handshake_at
     from devices d join radius_nas n on n.device_id = d.id where d.id = $1`, [deviceId])).rows[0];
  if (!r) throw new HttpError(404, 'concentrador do RADIUS integrado não encontrado');
  return r;
}
/** O endereço do concentrador identifica o provedor dos pacotes: não pode se repetir em toda a plataforma. A mensagem não revela de quem é. */
const ipTaken = (e: any) => (e?.code === '23505' && String(e.constraint).includes('nas_ip')
  ? new HttpError(409, 'este endereço já está cadastrado como concentrador; cada concentrador precisa de um endereço de origem próprio') : e);

export async function radiusRoutes(app: FastifyInstance) {
  app.get('/api/radius/status', { preHandler: guard('network:read') }, async () =>
    ({ enabled: radiusConfigured(), ...server(), host_configured: !!process.env.NEXO_RADIUS_PUBLIC_HOST,
      vpn: await withScope(noScope, async (c) => ({ enabled: !!(await c.query('select 1 from vpn_settings')).rowCount, endpoint: vpnEndpoint() })),
      vendors: VENDORS.map((v) => ({ id: v, validated: VENDOR_VALIDATED[v], tunnel: TUNNEL_VENDORS.includes(v) })) }));

  // Para o provedor/operador montar a regra de firewall do acesso direto: só estes endereços precisam alcançar 1812/1813.
  app.get('/api/radius/allowed-sources', { preHandler: guard('network:read') }, async (req) =>
    withScope(req.ctx.scope, async (c) => {
      const rows = (await c.query(
        `select d.name, host(n.nas_ip) as ip, (p.device_id is not null) as via_tunnel from radius_nas n join devices d on d.id = n.device_id
         left join vpn_peers p on p.device_id = n.device_id order by d.name`)).rows;
      return { direct: rows.filter((r) => !r.via_tunnel), tunnel: rows.filter((r) => r.via_tunnel),
        note: 'Concentradores por túnel não precisam de regra: chegam pelo túnel. Para os diretos, libere UDP 1812 e 1813 só destes endereços.' };
    }));

  app.post('/api/radius/devices', { preHandler: guard('network:write') }, async (req) => {
    const b = z.object({
      name: z.string().trim().min(2).max(80), vendor: z.enum(VENDORS), connection: z.enum(['vpn', 'direct']).default('direct'), nas_ip: zIp.optional(),
      coa_host: z.string().trim().max(200).nullish().transform((v) => v || null), coa_port: z.number().int().min(1).max(65535).default(3799),
    }).parse(req.body);
    if (b.connection === 'direct' && !b.nas_ip) throw new HttpError(400, 'informe o endereço de origem do concentrador (ou use o túnel)');
    radiusKey();
    const secret = newSecret();
    try {
      return await withScope(req.ctx.scope, async (c) => {
        const agentId = await ensureInternalAgent(c, req.ctx.tenantId!);
        const d = (await c.query(
          `insert into devices (tenant_id, name, driver, vendor, host, agent_id) values ($1,$2,'radius',$3,$4,$5) returning id, name, driver, vendor`,
          [req.ctx.tenantId, b.name, b.vendor, b.nas_ip ?? null, agentId])).rows[0];
        // com túnel, o endereço que identifica o concentrador é o que o sistema lhe dá dentro do túnel
        const tunnel = b.connection === 'vpn' ? await newTunnel(c, req.ctx.tenantId!, d.id, b.vendor) : null;
        const nasIp = tunnel ? tunnel.tunnelIp : b.nas_ip!;
        await c.query('update devices set host = $2 where id = $1', [d.id, nasIp]);
        await c.query('insert into radius_nas (device_id, tenant_id, nas_ip, secret, coa_host, coa_port) values ($1,$2,$3,$4,$5,$6)', [d.id, req.ctx.tenantId, nasIp, secret, tunnel ? null : b.coa_host, b.coa_port]);
        await audit(c, req.ctx, 'radius.device_create', 'device', d.id, { vendor: b.vendor, connection: b.connection, nas_ip: nasIp });     // segredo e chave do túnel nunca vão para a auditoria
        return { ...d, nas_ip: nasIp, secret, setup: setup(b.vendor, b.coa_port, secret, tunnel) };
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
      return { ...n, setup: setup(n.vendor, n.coa_port, '<SEGREDO>', await tunnelOf(c, n.id)) };
    }));

  app.post('/api/radius/devices/:id/secret', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const secret = newSecret();
    return withScope(req.ctx.scope, async (c) => {
      const n = await nasOf(c, id);
      await c.query('update radius_nas set secret = $2 where device_id = $1', [id, secret]);
      await audit(c, req.ctx, 'radius.secret_rotate', 'device', id);
      return { secret, setup: setup(n.vendor, n.coa_port, secret, await tunnelOf(c, id)), note: 'O servidor passa a aceitar o segredo novo em até 2 minutos. Troque no concentrador em seguida: enquanto diferirem, ninguém autentica.' };
    });
  });

  /**
   * Liga (ou refaz) o túnel de um concentrador já cadastrado: endereço e chaves novos. A partir daí ele é reconhecido pelo endereço
   * do túnel; enquanto o equipamento não for reconfigurado com os comandos devolvidos, ele não autentica ninguém novo.
   */
  app.post('/api/radius/devices/:id/tunnel', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const n = await nasOf(c, id);
      const tunnel = await newTunnel(c, req.ctx.tenantId!, id, n.vendor);
      await c.query('update radius_nas set nas_ip = $2, coa_host = null, coa_port = 3799 where device_id = $1', [id, tunnel.tunnelIp]);
      await c.query('update devices set host = $2 where id = $1', [id, tunnel.tunnelIp]);
      await audit(c, req.ctx, 'radius.device_tunnel', 'device', id, { tunnel_ip: tunnel.tunnelIp });
      return { id, nas_ip: tunnel.tunnelIp, setup: setup(n.vendor, 3799, '<SEGREDO>', tunnel),
        note: 'O segredo do RADIUS não mudou. Aplique os comandos do túnel e aponte o RADIUS do concentrador para o endereço interno.' };
    });
  });

  /**
   * Passa um equipamento que usava agente local para o RADIUS integrado e pede a reaplicação de todas as contas (as senhas já
   * estão no NexoISP, cifradas). Os assinantes continuam conectados; só passam a autenticar aqui quando o concentrador for apontado.
   */
  app.post('/api/devices/:id/convert-to-integrated', { preHandler: guard('network:write') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ vendor: z.enum(VENDORS), connection: z.enum(['vpn', 'direct']).default('direct'), nas_ip: zIp.optional(),
      coa_host: z.string().trim().max(200).nullish().transform((v) => v || null), coa_port: z.number().int().min(1).max(65535).default(3799) }).parse(req.body);
    if (b.connection === 'direct' && !b.nas_ip) throw new HttpError(400, 'informe o endereço de origem do concentrador (ou use o túnel)');
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
        const tunnel = b.connection === 'vpn' ? await newTunnel(c, req.ctx.tenantId!, id, b.vendor) : null;
        const nasIp = tunnel ? tunnel.tunnelIp : b.nas_ip!;
        await c.query(`update devices set driver = 'radius', vendor = $2, agent_id = $3, host = $4, api_port = null, credential_ref = null where id = $1`, [id, b.vendor, agentId, nasIp]);
        await c.query('insert into radius_nas (device_id, tenant_id, nas_ip, secret, coa_host, coa_port) values ($1,$2,$3,$4,$5,$6)', [id, req.ctx.tenantId, nasIp, secret, tunnel ? null : b.coa_host, b.coa_port]);
        const rows = (await c.query(
          `select r.id from service_resources r join contracts k on k.id = r.contract_id
           where r.device_id = $1 and r.desired_version > 0 and r.secret_enc is not null and k.status = 'active'`, [id])).rows;
        for (const r of rows) await requestOperation(c, req.ctx.tenantId!, r.id, 'subscriber.provision', { type: 'user', id: req.ctx.userId, reason: 'passagem para o RADIUS integrado' });
        const semSenha = (await c.query(`select count(*)::int as n from service_resources where device_id = $1 and desired_version > 0 and secret_enc is null`, [id])).rows[0].n;
        await audit(c, req.ctx, 'radius.device_convert', 'device', id, { vendor: b.vendor, connection: b.connection, nas_ip: nasIp, accounts: rows.length });
        return { id, accounts_requested: rows.length, accounts_without_secret: semSenha, secret, setup: setup(b.vendor, b.coa_port, secret, tunnel) };
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
