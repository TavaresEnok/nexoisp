import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { acsConfigured, findDevices, getDevice, summarize, task, wifiParams } from '../acs.js';
import { audit, guard, HttpError } from '../auth.js';
import { withScope, type Tx } from '../db.js';
import { zUuid } from '../validators.js';

/**
 * Roteador do cliente por TR-069: ver como está, trocar nome e senha do Wi-Fi, reiniciar, reler. O vínculo roteador ↔ contrato fica no
 * NexoISP; o servidor de gerência é compartilhado pela instalação, e um provedor nunca alcança roteador que não vinculou.
 */
const zSsid = z.string().trim().min(1).max(32).regex(/^[\x20-\x7E]+$/, 'nome da rede: até 32 caracteres comuns (sem acento)');
const zWifiPass = z.string().min(8, 'senha do Wi-Fi: de 8 a 63 caracteres').max(63).regex(/^[\x20-\x7E]+$/, 'senha do Wi-Fi: caracteres comuns (sem acento)');
const DEVICE_ID = z.string().trim().min(3).max(200).regex(/^[A-Za-z0-9%._-]+$/, 'identificador de roteador inválido');

async function linkOf(c: Tx, contractId: string) {
  return (await c.query('select acs_device_id, serial, linked_at from cpe_links where contract_id = $1', [contractId])).rows[0] ?? null;
}
const outcome = (r: 'applied' | 'queued') => (r === 'applied' ? { result: 'applied', note: 'aplicado no roteador agora' }
  : { result: 'queued', note: 'o roteador não atendeu agora: a mudança fica na fila e vale quando ele contatar o servidor' });

export async function tr069Routes(app: FastifyInstance) {
  app.get('/api/acs/status', { preHandler: guard('network:read') }, async () => ({ enabled: acsConfigured(), public_url: process.env.NEXO_ACS_PUBLIC_URL ?? null }));

  app.get('/api/contracts/:id/cpe', { preHandler: guard('network:read') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const link = await withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from contracts where id = $1', [id])).rowCount) throw new HttpError(404, 'contrato não encontrado');
      return linkOf(c, id);
    });
    if (!link) return { enabled: acsConfigured(), linked: false };
    const d = await getDevice(link.acs_device_id);
    return { enabled: true, linked: true, linked_at: link.linked_at, device: d ? summarize(d) : null, missing: !d };
  });

  /** Roteadores que podem ser deste contrato: os que informam o usuário PPPoE da conta, ou o número de série digitado. */
  app.get('/api/contracts/:id/cpe/candidates', { preHandler: guard('network:operate') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const qs = z.object({ serial: z.string().trim().min(3).max(64).optional() }).parse(req.query);
    const users = await withScope(req.ctx.scope, async (c) => {
      if (!(await c.query('select 1 from contracts where id = $1', [id])).rowCount) throw new HttpError(404, 'contrato não encontrado');
      return (await c.query('select pppoe_username from service_resources where contract_id = $1', [id])).rows.map((r) => r.pppoe_username as string);
    });
    const or: object[] = [];
    if (qs.serial) or.push({ '_deviceId._SerialNumber': qs.serial });
    for (const u of users) or.push({ 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username': u }, { 'Device.PPP.Interface.1.Username': u });
    if (!or.length) return [];
    const found = await findDevices({ $or: or }, '_id,_lastInform,_deviceId,InternetGatewayDevice.WANDevice,Device.PPP');
    const out = [];
    for (const d of found.slice(0, 20)) {
      const taken = await withScope(req.ctx.scope, async (c) => (await c.query('select cpe_linked_anywhere($1) as t', [d._id])).rows[0].t);
      if (!taken) out.push({ id: d._id, manufacturer: d._deviceId?._Manufacturer, product: d._deviceId?._ProductClass, serial: d._deviceId?._SerialNumber, last_inform: d._lastInform,
        matched_by: qs.serial && d._deviceId?._SerialNumber === qs.serial ? 'serial' : 'pppoe' });
    }
    return out;
  });

  app.post('/api/contracts/:id/cpe/link', { preHandler: guard('network:operate') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = z.object({ acs_device_id: DEVICE_ID, serial: z.string().trim().max(64).optional() }).parse(req.body);
    const d = await getDevice(b.acs_device_id, '_id,_deviceId,InternetGatewayDevice.WANDevice,Device.PPP');
    if (!d) throw new HttpError(404, 'roteador não encontrado no servidor de gerência');
    return withScope(req.ctx.scope, async (c) => {
      const users = (await c.query('select pppoe_username from service_resources where contract_id = $1', [id])).rows.map((r) => r.pppoe_username as string);
      // posse: o roteador informa a conta PPPoE deste contrato, ou quem vincula leu o número de série na etiqueta
      const s = summarize(d);
      if (!s.ppp_usernames.some((u) => users.includes(u)) && !(b.serial && b.serial === s.serial))
        throw new HttpError(400, 'este roteador não informa a conta deste contrato: confirme digitando o número de série da etiqueta');
      if ((await c.query('select cpe_linked_anywhere($1) as t', [b.acs_device_id])).rows[0].t) throw new HttpError(409, 'este roteador já está vinculado a um contrato');
      await c.query('delete from cpe_links where contract_id = $1', [id]);
      await c.query('insert into cpe_links (tenant_id, contract_id, acs_device_id, serial, linked_by) values ($1,$2,$3,$4,$5)', [req.ctx.tenantId, id, b.acs_device_id, s.serial, req.ctx.userId]);
      await audit(c, req.ctx, 'cpe.link', 'contract', id, { acs_device_id: b.acs_device_id, serial: s.serial });
      // primeira leitura completa (sem esperar): o servidor só guarda o que o roteador já informou
      task(b.acs_device_id, { name: 'refreshObject', objectName: s.model === 'tr181' ? 'Device' : 'InternetGatewayDevice' }).catch(() => {});
      return { linked: true, device: s };
    });
  });

  app.delete('/api/contracts/:id/cpe/link', { preHandler: guard('network:operate') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    return withScope(req.ctx.scope, async (c) => {
      const r = await c.query('delete from cpe_links where contract_id = $1 returning acs_device_id', [id]);
      if (!r.rowCount) throw new HttpError(404, 'nenhum roteador vinculado');
      await audit(c, req.ctx, 'cpe.unlink', 'contract', id, { acs_device_id: r.rows[0].acs_device_id });
      return { linked: false };
    });
  });

  const linked = async (req: any, id: string) => {
    const link = await withScope(req.ctx.scope, (c) => linkOf(c, id));
    if (!link) throw new HttpError(404, 'nenhum roteador vinculado a este contrato');
    return link.acs_device_id as string;
  };
  const zWifi = z.object({ index: z.string().regex(/^\d{1,2}$/), ssid: zSsid.optional(), password: zWifiPass.optional() })
    .refine((v) => v.ssid || v.password, 'informe o nome da rede, a senha ou os dois');
  async function setWifi(dev: string, b: z.infer<typeof zWifi>) {
    const d = await getDevice(dev);
    if (!d) throw new HttpError(404, 'roteador não encontrado no servidor de gerência');
    return task(dev, { name: 'setParameterValues', parameterValues: wifiParams(d, b.index, b.ssid, b.password) });
  }

  app.post('/api/contracts/:id/cpe/wifi', { preHandler: guard('network:operate') }, async (req) => {
    const id = zUuid.parse((req.params as any).id);
    const b = zWifi.parse(req.body);
    const r = await setWifi(await linked(req, id), b);
    await withScope(req.ctx.scope, (c) => audit(c, req.ctx, 'cpe.wifi', 'contract', id, { index: b.index, ssid: b.ssid ?? null, password_changed: !!b.password, result: r }));
    return outcome(r);
  });
  for (const [path, body, action] of [['reboot', { name: 'reboot' }, 'cpe.reboot'], ['refresh', null, 'cpe.refresh']] as const) {
    app.post(`/api/contracts/:id/cpe/${path}`, { preHandler: guard('network:operate') }, async (req) => {
      const id = zUuid.parse((req.params as any).id);
      const dev = await linked(req, id);
      const d = path === 'refresh' ? await getDevice(dev, '_id,InternetGatewayDevice.DeviceInfo,Device.DeviceInfo') : null;
      const r = await task(dev, body ?? { name: 'refreshObject', objectName: d?.Device && !d?.InternetGatewayDevice ? 'Device' : 'InternetGatewayDevice' });
      await withScope(req.ctx.scope, (c) => audit(c, req.ctx, action, 'contract', id, { result: r }));
      return outcome(r);
    });
  }

  // ---- Portal: o assinante troca nome e senha do próprio Wi-Fi ----
  app.get('/api/portal/cpe', { preHandler: guard('portal:self') }, async (req) => {
    const rows = await withScope(req.ctx.scope, async (c) =>
      (await c.query('select l.contract_id, l.acs_device_id from cpe_links l join contracts k on k.id = l.contract_id where k.subscriber_id = $1 and k.status = $2', [req.ctx.subscriberId, 'active'])).rows);
    const out = [];
    for (const r of rows) { const d = await getDevice(r.acs_device_id).catch(() => null); if (d) out.push({ contract_id: r.contract_id, wifi: summarize(d).wifi, last_inform: d._lastInform }); }
    return out;
  });
  app.post('/api/portal/cpe/:contractId/wifi', { preHandler: guard('portal:self') }, async (req) => {
    const id = zUuid.parse((req.params as any).contractId);
    const b = zWifi.parse(req.body);
    const own = await withScope(req.ctx.scope, async (c) =>
      (await c.query('select l.acs_device_id from cpe_links l join contracts k on k.id = l.contract_id where l.contract_id = $1 and k.subscriber_id = $2', [id, req.ctx.subscriberId])).rows[0]);
    if (!own) throw new HttpError(404, 'roteador não encontrado');
    const r = await setWifi(own.acs_device_id, b);
    await withScope({ tenantId: req.ctx.tenantId!, operator: false }, (c) => audit(c, req.ctx, 'cpe.wifi', 'contract', id, { index: b.index, ssid: b.ssid ?? null, password_changed: !!b.password, result: r, source: 'portal' }));
    return outcome(r);
  });
}
