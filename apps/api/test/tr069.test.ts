import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, testAgent } from './helpers.js';

// TR-069: vínculo roteador ↔ contrato com prova de posse, isolamento entre provedores, Wi-Fi nos dois modelos de dados, fila e portal.
let admin: string, beta: string, atend: string, fin: string, contractId: string, portal: string;
const tag = String(Date.now()).slice(-6);
const v = (x: unknown, w = true) => ({ _value: x, _writable: w });
const devices: Record<string, any> = {};
const tasks: { id: string; body: any }[] = [];
let offline = false, refuse = false;
const faults: any[] = [];
const server = createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  let body = ''; req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.method === 'GET' && u.pathname === '/devices/') {
      const q = JSON.parse(u.searchParams.get('query') ?? '{}');
      const conds: any[] = q.$or ?? [q];
      const get = (d: any, p: string) => p.split('.').reduce((a: any, k) => (a == null ? a : a[k]), d);
      const hit = Object.values(devices).filter((d) => conds.some((c) => Object.entries(c).every(([p, want]) => { const g = get(d, p); return (g?._value ?? g) === want; })));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hit));
      return;
    }
    const m = u.pathname.match(/^\/devices\/([^/]+)\/tasks$/);
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      if (!devices[id]) { res.writeHead(404).end(); return; }
      const tid = `t${tasks.length}`;
      tasks.push({ id, body: JSON.parse(body) });
      if (refuse) faults.push({ _id: `${id}:task_${tid}`, device: id, channel: `task_${tid}`, code: 'cwmp.9000', message: 'Method not supported', detail: { faultCode: '9000' } });
      res.writeHead(offline || refuse ? 202 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...JSON.parse(body), _id: tid }));
      return;
    }
    if (req.method === 'GET' && u.pathname === '/faults/') {
      const q = JSON.parse(u.searchParams.get('query') ?? '{}');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(faults.filter((f) => f.device === q.device && f.channel === q.channel)));
      return;
    }
    if (req.method === 'DELETE' && (u.pathname.startsWith('/tasks/') || u.pathname.startsWith('/faults/'))) {
      const fid = decodeURIComponent(u.pathname.split('/')[2]);
      const i = faults.findIndex((f) => f._id === fid); if (i >= 0) faults.splice(i, 1);
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.NEXO_ACS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  admin = await login('admin@alfa.demo'); beta = await login('admin@beta.demo'); atend = await login('atendimento@alfa.demo'); fin = await login('financeiro@alfa.demo');
  const ag = await testAgent(admin, `tr-${tag}`);
  const plan = (await call(admin, 'POST', '/api/plans', { name: `Plano tr ${tag}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `tr${tag}` })).body.id;
  const sub = (await call(admin, 'POST', '/api/subscribers', { name: `Cliente TR ${tag}` })).body;
  contractId = (await call(admin, 'POST', '/api/contracts', { subscriber_id: sub.id, plan_id: plan, due_day: 10 })).body.id;
  await call(admin, 'POST', `/api/contracts/${contractId}/service`, { device_id: ag.deviceId, pppoe_username: `trcli${tag}` });
  await call(admin, 'POST', `/api/subscribers/${sub.id}/portal-access`, { email: `tr${tag}@cliente.demo`, password: 'demo1234' });
  portal = await login(`tr${tag}@cliente.demo`, 'demo1234');
  devices[`ABC-R1-${tag}`] = { _id: `ABC-R1-${tag}`, _lastInform: new Date().toISOString(), _deviceId: { _Manufacturer: 'Fab', _ProductClass: 'R1', _SerialNumber: `S1${tag}` },
    InternetGatewayDevice: { DeviceInfo: { SoftwareVersion: v('1.2.3', false), UpTime: v(3600, false) },
      WANDevice: { 1: { WANConnectionDevice: { 1: { WANPPPConnection: { 1: { Username: v(`trcli${tag}`), ExternalIPAddress: v('100.64.0.9', false), ConnectionStatus: v('Connected', false) } } } } } },
      LANDevice: { 1: { WLANConfiguration: { 1: { SSID: v('Antiga'), Enable: v(true), PreSharedKey: { 1: { KeyPassphrase: v('') } } }, 5: { SSID: v('Antiga-5G'), Enable: v(true), KeyPassphrase: v('') } } } } } };
  devices[`XYZ-R2-${tag}`] = { _id: `XYZ-R2-${tag}`, _lastInform: new Date().toISOString(), _deviceId: { _Manufacturer: 'Out', _ProductClass: 'R2', _SerialNumber: `S2${tag}` },
    Device: { DeviceInfo: { SoftwareVersion: v('9', false) }, PPP: { Interface: { 1: { Username: v('outro-cliente') } } }, WiFi: { SSID: { 1: { SSID: v('Casa'), Enable: v(true) } } } } };
});
afterAll(async () => { delete process.env.NEXO_ACS_URL; await new Promise((r) => server.close(r)); });

describe('roteador do cliente (TR-069)', () => {
  it('candidatos: casa pela conta PPPoE; outro roteador só com o número de série; vincular exige posse', async () => {
    const c = (await call(admin, 'GET', `/api/contracts/${contractId}/cpe/candidates`)).body;
    expect(c.map((x: any) => x.id)).toEqual([`ABC-R1-${tag}`]);
    expect((await call(admin, 'POST', `/api/contracts/${contractId}/cpe/link`, { acs_device_id: `XYZ-R2-${tag}` })).status).toBe(400);    // não é dele
    expect((await call(admin, 'GET', `/api/contracts/${contractId}/cpe/candidates?serial=S2${tag}`)).body.some((x: any) => x.id === `XYZ-R2-${tag}`)).toBe(true);
    const l = await call(admin, 'POST', `/api/contracts/${contractId}/cpe/link`, { acs_device_id: `ABC-R1-${tag}` });
    expect(l.status).toBe(200);
    const st = (await call(atend, 'GET', `/api/contracts/${contractId}/cpe`)).body;
    expect(st.device).toMatchObject({ model: 'tr098', firmware: '1.2.3', serial: `S1${tag}`, wan: { ip: '100.64.0.9', status: 'Connected' } });
    expect(st.device.wifi.map((w: any) => w.ssid)).toEqual(['Antiga', 'Antiga-5G']);
  });

  it('outro provedor não alcança o roteador nem consegue vinculá-lo', async () => {
    expect((await call(beta, 'GET', `/api/contracts/${contractId}/cpe`)).status).toBe(404);
    const subB = (await call(beta, 'POST', '/api/subscribers', { name: `B TR ${tag}` })).body;
    const planB = (await call(beta, 'POST', '/api/plans', { name: `PB tr ${tag}`, price_cents: 5000, down_kbps: 1000, up_kbps: 1000, profile_name: `trb${tag}` })).body.id;
    const kB = (await call(beta, 'POST', '/api/contracts', { subscriber_id: subB.id, plan_id: planB, due_day: 10 })).body.id;
    expect((await call(beta, 'POST', `/api/contracts/${kB}/cpe/link`, { acs_device_id: `ABC-R1-${tag}`, serial: `S1${tag}` })).status).toBe(409);
    expect((await call(beta, 'POST', `/api/contracts/${kB}/cpe/wifi`, { index: '1', ssid: 'invasor' })).status).toBe(404);
  });

  it('Wi-Fi: caminho certo de cada modelo; senha fora da auditoria; roteador sem resposta fica na fila', async () => {
    expect((await call(admin, 'POST', `/api/contracts/${contractId}/cpe/wifi`, { index: '1', password: 'curta' })).status).toBe(400);
    expect((await call(fin, 'POST', `/api/contracts/${contractId}/cpe/wifi`, { index: '1', ssid: 'x' })).status).toBe(403);
    const r = (await call(atend, 'POST', `/api/contracts/${contractId}/cpe/wifi`, { index: '1', ssid: 'Casa Nova', password: 'senha-forte-123' })).body;
    expect(r.result).toBe('applied');
    expect(tasks.at(-1)!.body.parameterValues).toEqual([
      ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', 'Casa Nova', 'xsd:string'],
      ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase', 'senha-forte-123', 'xsd:string']]);
    await call(atend, 'POST', `/api/contracts/${contractId}/cpe/wifi`, { index: '5', password: 'outra-senha-456' });
    expect(tasks.at(-1)!.body.parameterValues[0][0]).toBe('InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.KeyPassphrase');
    const aud = JSON.stringify((await call(admin, 'GET', '/api/audit?limit=20')).body);
    expect(aud).toMatch(/cpe\.wifi/);
    expect(aud).not.toMatch(/senha-forte-123/);
    offline = true;
    expect((await call(atend, 'POST', `/api/contracts/${contractId}/cpe/reboot`)).body.result).toBe('queued');
    offline = false;
    expect(tasks.at(-1)!.body).toEqual({ name: 'reboot' });
    refuse = true;                                                          // o roteador atende e recusa (como o simulador recusa reiniciar)
    const recusa = await call(atend, 'POST', `/api/contracts/${contractId}/cpe/reboot`);
    refuse = false;
    expect(recusa.status).toBe(409);
    expect(recusa.body.error).toMatch(/recusou: Method not supported \(código 9000\)/);
    expect(faults).toHaveLength(0);                                         // falha e tarefa removidas
  });

  it('portal: o assinante vê e troca o próprio Wi-Fi', async () => {
    const mine = (await call(portal, 'GET', '/api/portal/cpe')).body;
    expect(mine[0]).toMatchObject({ contract_id: contractId });
    expect((await call(portal, 'POST', `/api/portal/cpe/${contractId}/wifi`, { index: '1', password: 'minha-senha-99' })).body.result).toBe('applied');
    const other = (await call(portal, 'POST', `/api/portal/cpe/00000000-0000-4000-8000-000000000000/wifi`, { index: '1', password: 'minha-senha-99' }));
    expect(other.status).toBe(404);
  });
});
