import { execFileSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { closePool, noScope, withScope } from './db.js';
import { renderServerConf, VPN_INTERNAL_PORT, VPN_SERVER_IP } from './radius/vpn-shared.js';

/**
 * Serviço do túnel (processo próprio, mesmo pacote da API). Mantém a interface WireGuard com um par por concentrador cadastrado
 * no painel e repassa os pedidos de desconexão da API para dentro do túnel. O servidor RADIUS compartilha a rede deste serviço:
 * é por aqui que os pacotes dos concentradores chegam a ele.
 */
const STATE = process.env.NEXO_VPN_STATE ?? '/state';
const IFACE = 'wg0', KEY = `${STATE}/server.key`, CONF = `${STATE}/wg0.conf`;
const RELAY_PORT = Number(process.env.NEXO_COA_RELAY_PORT ?? 3798);
const log = (m: string) => console.log(`${new Date().toISOString()} túnel: ${m}`);
const sh = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

function setup(): string {
  mkdirSync(STATE, { recursive: true });
  if (!existsSync(KEY)) { writeFileSync(KEY, sh('wg', ['genkey']) + '\n', { mode: 0o600 }); log('chave do servidor gerada'); }
  chmodSync(KEY, 0o600);
  try { sh('ip', ['link', 'add', IFACE, 'type', 'wireguard']); } catch (e) { if (!/exists/i.test(String((e as any).stderr ?? e))) throw e; }
  try { sh('ip', ['addr', 'add', `${VPN_SERVER_IP}/16`, 'dev', IFACE]); } catch (e) { if (!/exists/i.test(String((e as any).stderr ?? e))) throw e; }
  sh('wg', ['set', IFACE, 'listen-port', String(VPN_INTERNAL_PORT), 'private-key', KEY]);
  sh('ip', ['link', 'set', IFACE, 'mtu', '1420', 'up']);
  return sh('wg', ['pubkey'], readFileSync(KEY, 'utf8'));
}

let lastConf = '';
async function syncPeers() {
  const peers = await withScope(noScope, async (c) => (await c.query('select public_key, tunnel_ip from vpn_peers_all() order by tunnel_ip')).rows);
  const conf = renderServerConf(readFileSync(KEY, 'utf8').trim(), peers);
  if (conf !== lastConf) {
    writeFileSync(CONF, conf + '\n', { mode: 0o600 });
    sh('wg', ['syncconf', IFACE, CONF]);        // aplica só a diferença: quem não mudou não perde a sessão
    lastConf = conf;
    log(`${peers.length} concentrador(es) no túnel`);
  }
}

const reported = new Map<string, string>();
async function report() {
  // wg dump: chave pública, psk, endpoint, endereços, último aperto de mão (época), rx, tx, keepalive
  for (const line of sh('wg', ['show', IFACE, 'dump']).split('\n').slice(1)) {
    const [pub, , endpoint, , hs, rx, tx] = line.split('\t');
    if (!pub) continue;
    const mark = `${hs}|${endpoint}`;
    if (reported.get(pub) === mark) continue;
    reported.set(pub, mark);
    await withScope(noScope, (c) => c.query('select vpn_report($1, $2, $3, $4, $5)',
      [pub, Number(hs) > 0 ? new Date(Number(hs) * 1000) : null, endpoint && endpoint !== '(none)' ? endpoint : null, Number(rx) || 0, Number(tx) || 0]));
  }
}

/** Repasse da desconexão: a API manda [IPv4 de destino (4 bytes)][porta (2 bytes)][pacote RADIUS]; a resposta volta crua. */
function relay() {
  const srv = createSocket('udp4');
  srv.on('message', (msg, from) => {
    if (msg.length < 26) return;
    const host = [...msg.subarray(0, 4)].join('.'), port = msg.readUInt16BE(4);
    const out = createSocket('udp4');
    const done = setTimeout(() => out.close(), 4000);
    out.on('message', (reply) => { srv.send(reply, from.port, from.address); clearTimeout(done); out.close(); });
    out.on('error', () => { clearTimeout(done); try { out.close(); } catch { /* já fechado */ } });
    out.send(msg.subarray(6), port, host);
  });
  srv.bind(RELAY_PORT, '0.0.0.0', () => log(`repasse de desconexão na porta ${RELAY_PORT}`));
}

async function main() {
  const pub = setup();
  await withScope(noScope, (c) => c.query('select vpn_set_server_key($1)', [pub]));
  log(`interface ${IFACE} no ar (${VPN_SERVER_IP}, porta ${VPN_INTERNAL_PORT})`);
  relay();
  let n = 0;
  for (;;) {
    try { await syncPeers(); if (n++ % 3 === 0) await report(); } catch (e) { log(`erro: ${(e as Error).message}`); await closePool().catch(() => {}); }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
