import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';

/**
 * Desconexão de sessão pelo próprio protocolo RADIUS (Disconnect-Request, RFC 5176): funciona em qualquer concentrador
 * que aceite a mensagem, sem API de fabricante. O concentrador só aceita se vier do endereço do servidor RADIUS e com o segredo certo.
 */
export type DisconnectResult = { outcome: 'ack' } | { outcome: 'nak'; errorCause: number | null } | { outcome: 'timeout' };
export const SESSION_NOT_FOUND = 503;   // Error-Cause: o concentrador não tem essa sessão (já caiu)

const attr = (type: number, value: Buffer) => Buffer.concat([Buffer.from([type, value.length + 2]), value]);

export function buildDisconnect(secret: string, id: number, a: { username: string; sessionId?: string | null; framedIp?: string | null }): Buffer {
  const parts = [attr(1, Buffer.from(a.username, 'utf8'))];
  if (a.sessionId) parts.push(attr(44, Buffer.from(a.sessionId, 'utf8')));
  if (a.framedIp && isIP(a.framedIp) === 4) parts.push(attr(8, Buffer.from(a.framedIp.split('.').map(Number))));
  const attrs = Buffer.concat(parts);
  const head = Buffer.alloc(4);
  head[0] = 40; head[1] = id; head.writeUInt16BE(20 + attrs.length, 2);
  // autenticador do pedido: MD5(código + id + tamanho + 16 zeros + atributos + segredo)
  const auth = createHash('md5').update(Buffer.concat([head, Buffer.alloc(16), attrs, Buffer.from(secret, 'utf8')])).digest();
  return Buffer.concat([head, auth, attrs]);
}

/** Resposta só vale se o autenticador conferir com o do pedido e o segredo (senão qualquer um na rede poderia forjar um ACK). */
export function parseReply(secret: string, request: Buffer, reply: Buffer): DisconnectResult | null {
  if (reply.length < 20 || reply[1] !== request[1] || reply.readUInt16BE(2) !== reply.length) return null;
  const expected = createHash('md5').update(Buffer.concat([reply.subarray(0, 4), request.subarray(4, 20), reply.subarray(20), Buffer.from(secret, 'utf8')])).digest();
  if (!expected.equals(reply.subarray(4, 20))) return null;
  if (reply[0] === 41) return { outcome: 'ack' };
  if (reply[0] !== 42) return null;
  let cause: number | null = null;
  for (let i = 20; i + 2 <= reply.length;) {
    const len = reply[i + 1];
    if (len < 2) break;
    if (reply[i] === 101 && len === 6) cause = reply.readUInt32BE(i + 2);
    i += len;
  }
  return { outcome: 'nak', errorCause: cause };
}

export async function sendDisconnect(o: { host: string; port: number; secret: string; username: string; sessionId?: string | null; framedIp?: string | null },
  timeoutMs = 2500, tries = 2): Promise<DisconnectResult> {
  const id = randomBytes(1)[0];
  const req = buildDisconnect(o.secret, id, o);
  // Com o serviço do túnel, o pedido sai por ele (é de lá que o concentrador espera receber); senão vai direto.
  const relay = process.env.NEXO_RADIUS_COA_RELAY?.match(/^([^:]+):(\d+)$/);
  if (relay && isIP(o.host) === 4) {
    const head = Buffer.alloc(6);
    o.host.split('.').forEach((n, i) => { head[i] = Number(n); });
    head.writeUInt16BE(o.port, 4);
    return exchange(relay[1], Number(relay[2]), Buffer.concat([head, req]), o.secret, req, timeoutMs, tries);
  }
  return exchange(o.host, o.port, req, o.secret, req, timeoutMs, tries);
}

async function exchange(host: string, port: number, wire: Buffer, secret: string, req: Buffer, timeoutMs: number, tries: number): Promise<DisconnectResult> {
  const o = { host, port, secret };
  const sock = createSocket(isIP(o.host) === 6 ? 'udp6' : 'udp4');
  try {
    return await new Promise<DisconnectResult>((resolve) => {
      let n = 0;
      const send = () => { n++; sock.send(wire, o.port, o.host, () => {}); };
      const timer = setInterval(() => { if (n >= tries) { clearInterval(timer); resolve({ outcome: 'timeout' }); } else send(); }, timeoutMs);
      sock.on('message', (msg) => { const r = parseReply(o.secret, req, msg); if (r) { clearInterval(timer); resolve(r); } });
      sock.on('error', () => { clearInterval(timer); resolve({ outcome: 'timeout' }); });
      send();
    });
  } finally { sock.close(); }
}
