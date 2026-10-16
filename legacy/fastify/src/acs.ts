import { HttpError } from './auth.js';

/**
 * Cliente do servidor de gerência TR-069 integrado (API interna, nunca exposta). Fala TR-098 (InternetGatewayDevice) e TR-181 (Device):
 * os caminhos mudam conforme o modelo de dados que o roteador anunciou. Só o necessário para o atendimento: identificação, WAN, Wi-Fi,
 * reiniciar e atualizar a leitura.
 */
export const acsUrl = () => (process.env.NEXO_ACS_URL ?? '').replace(/\/$/, '');
export const acsConfigured = () => /^https?:\/\//.test(acsUrl());

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  if (!acsConfigured()) throw new HttpError(503, 'o gerenciamento de roteadores (TR-069) não está habilitado nesta instalação', 'acs_unavailable');
  let r: Response;
  try { r = await fetch(`${acsUrl()}${path}`, { ...init, signal: AbortSignal.timeout(25_000) }); }
  catch { throw new HttpError(502, 'o servidor de gerência de roteadores não respondeu', 'acs_down'); }
  const text = await r.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* texto */ }
  if (r.status >= 500) throw new HttpError(502, 'o servidor de gerência de roteadores falhou', 'acs_error');
  return { status: r.status, body };
}

const q = (o: object) => encodeURIComponent(JSON.stringify(o));
export async function findDevices(query: object, projection = '_id,_lastInform,_deviceId'): Promise<any[]> {
  const r = await call(`/devices/?query=${q(query)}&projection=${projection}`);
  return Array.isArray(r.body) ? r.body : [];
}
export async function getDevice(id: string, projection?: string): Promise<any | null> {
  return (await findDevices({ _id: id }, projection ?? '_id,_lastInform,_deviceId,InternetGatewayDevice,Device'))[0] ?? null;
}
/** Tarefa no roteador. 200 = aplicada agora; 202 = ficou na fila (o roteador não atendeu): vale no próximo contato dele. */
export async function task(id: string, body: object): Promise<'applied' | 'queued'> {
  const r = await call(`/devices/${encodeURIComponent(id)}/tasks?connection_request&timeout=20000`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status === 404) throw new HttpError(404, 'roteador não encontrado no servidor de gerência');
  if (r.status !== 200 && r.status !== 202) throw new HttpError(502, `o servidor de gerência recusou a tarefa (${r.status})`);
  if (r.status === 200) return 'applied';
  // 202: ou o roteador não atendeu (fica na fila), ou atendeu e RECUSOU (falha registrada). Recusa não é "na fila": mostra o motivo
  // e tira a tarefa, para ela não ficar sendo repetida a cada contato do roteador.
  const taskId = r.body?._id;
  if (taskId) {
    const f = await call(`/faults/?query=${q({ device: id, channel: `task_${taskId}` })}`);
    const fault = Array.isArray(f.body) ? f.body[0] : null;
    if (fault) {
      await call(`/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }).catch(() => null);
      await call(`/faults/${encodeURIComponent(fault._id)}`, { method: 'DELETE' }).catch(() => null);
      throw new HttpError(409, `o roteador recusou: ${fault.message ?? fault.code}${fault.detail?.faultCode ? ` (código ${fault.detail.faultCode})` : ''}`, 'cpe_fault');
    }
  }
  return 'queued';
}

const val = (o: any, path: string) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o)?._value ?? null;
const keys = (o: any) => (o ? Object.keys(o).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)) : []);
export type Model = 'tr098' | 'tr181';
export const modelOf = (d: any): Model => (d?.Device && !d?.InternetGatewayDevice ? 'tr181' : 'tr098');

/** Usuários PPPoE que o roteador informa (para casar com a conta do contrato). */
export function pppUsernames(d: any): string[] {
  const out: string[] = [];
  const igd = d?.InternetGatewayDevice?.WANDevice;
  for (const w of keys(igd)) for (const c of keys(igd[w]?.WANConnectionDevice)) for (const p of keys(igd[w].WANConnectionDevice[c]?.WANPPPConnection)) {
    const u = val(igd, `${w}.WANConnectionDevice.${c}.WANPPPConnection.${p}.Username`); if (u) out.push(u);
  }
  const ppp = d?.Device?.PPP?.Interface;
  for (const i of keys(ppp)) { const u = val(ppp, `${i}.Username`); if (u) out.push(u); }
  return out;
}

/** Resumo para a tela: identificação, WAN e redes Wi-Fi. Sem senhas. */
export function summarize(d: any) {
  const m = modelOf(d);
  const info = m === 'tr098' ? d?.InternetGatewayDevice?.DeviceInfo : d?.Device?.DeviceInfo;
  const wifi: { index: string; ssid: string | null; enabled: boolean | null }[] = [];
  if (m === 'tr098') {
    const w = d?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration;
    for (const i of keys(w)) wifi.push({ index: i, ssid: val(w, `${i}.SSID`), enabled: val(w, `${i}.Enable`) });
  } else {
    const s = d?.Device?.WiFi?.SSID;
    for (const i of keys(s)) wifi.push({ index: i, ssid: val(s, `${i}.SSID`), enabled: val(s, `${i}.Enable`) });
  }
  let wan: { ip: string | null; status: string | null } = { ip: null, status: null };
  if (m === 'tr098') {
    const igd = d?.InternetGatewayDevice?.WANDevice;
    for (const w of keys(igd)) for (const c of keys(igd[w]?.WANConnectionDevice)) for (const kind of ['WANPPPConnection', 'WANIPConnection']) for (const p of keys(igd[w].WANConnectionDevice[c]?.[kind])) {
      const base = `${w}.WANConnectionDevice.${c}.${kind}.${p}`;
      if (!wan.ip && val(igd, `${base}.ExternalIPAddress`)) wan = { ip: val(igd, `${base}.ExternalIPAddress`), status: val(igd, `${base}.ConnectionStatus`) };
    }
  } else {
    const ip = d?.Device?.IP?.Interface;
    for (const i of keys(ip)) for (const a of keys(ip[i]?.IPv4Address)) if (!wan.ip && val(ip, `${i}.IPv4Address.${a}.IPAddress`)) wan = { ip: val(ip, `${i}.IPv4Address.${a}.IPAddress`), status: val(ip, `${i}.Status`) };
  }
  return {
    id: d._id, model: m, manufacturer: d._deviceId?._Manufacturer ?? val(info, 'Manufacturer'), product: val(info, 'ModelName') ?? d._deviceId?._ProductClass,
    serial: d._deviceId?._SerialNumber ?? val(info, 'SerialNumber'), firmware: val(info, 'SoftwareVersion'), hardware: val(info, 'HardwareVersion'),
    uptime_s: Number(val(info, 'UpTime')) || null, last_inform: d._lastInform ?? null, wan, wifi, ppp_usernames: pppUsernames(d),
  };
}

/** Parâmetros para trocar nome e senha de uma rede Wi-Fi, no modelo de dados do roteador. */
export function wifiParams(d: any, index: string, ssid?: string, password?: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  if (modelOf(d) === 'tr098') {
    const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}`;
    const w = d?.InternetGatewayDevice?.LANDevice?.['1']?.WLANConfiguration?.[index];
    if (!w) throw new HttpError(400, 'rede Wi-Fi não encontrada neste roteador');
    if (ssid) out.push([`${base}.SSID`, ssid, 'xsd:string']);
    // a frase-senha WPA fica em KeyPassphrase em uns modelos e em PreSharedKey em outros
    if (password) out.push([w.KeyPassphrase ? `${base}.KeyPassphrase` : w.PreSharedKey?.['1']?.KeyPassphrase ? `${base}.PreSharedKey.1.KeyPassphrase` : `${base}.PreSharedKey.1.PreSharedKey`, password, 'xsd:string']);
  } else {
    if (!d?.Device?.WiFi?.SSID?.[index]) throw new HttpError(400, 'rede Wi-Fi não encontrada neste roteador');
    if (ssid) out.push([`Device.WiFi.SSID.${index}.SSID`, ssid, 'xsd:string']);
    if (password) out.push([`Device.WiFi.AccessPoint.${index}.Security.KeyPassphrase`, password, 'xsd:string']);
  }
  return out;
}
