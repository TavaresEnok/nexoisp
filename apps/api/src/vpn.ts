import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { closePool, noScope, withScope } from './db.js';
import { l2tpConfigured, l2tpPsk, renderChapSecrets, renderIpsecConf, renderIpsecSecrets, renderPppOptions, renderServerConf, renderXl2tpdConf,
  VPN_INTERNAL_PORT, VPN_SERVER_IP } from './radius/vpn-shared.js';

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

// ---------------------------------------------------------------- L2TP/IPsec (concentradores sem WireGuard)
// strongSwan (IKEv1, transporte, chave da instalação) + xl2tpd + pppd neste mesmo contêiner: as interfaces ppp nascem na rede que o
// RADIUS compartilha, então os pacotes de 10.251.x.x chegam a ele como os do WireGuard.
const L2TP_BIN = ['/usr/sbin/ipsec', '/usr/sbin/xl2tpd', '/usr/sbin/pppd'];
const children = new Map<string, ChildProcess>();
function keep(name: string, cmd: string, args: string[]) {
  const cur = children.get(name);
  if (cur && cur.exitCode === null) return;
  const ch = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = (b: Buffer) => b.toString().split('\n').filter(Boolean).forEach((l) => log(`${name}: ${l.slice(0, 300)}`));
  ch.stdout?.on('data', out); ch.stderr?.on('data', out);
  ch.on('exit', (code) => log(`${name} saiu (código ${code}); será reiniciado`));
  children.set(name, ch);
}
let l2tpOn = false;
function l2tpSetup(): boolean {
  if (!l2tpConfigured()) { log('L2TP/IPsec desligado (defina NEXO_L2TP_PSK para habilitar)'); return false; }
  if (!L2TP_BIN.every(existsSync)) { log('L2TP/IPsec indisponível: faltam strongSwan, xl2tpd ou pppd nesta imagem'); return false; }
  if (!process.env.NEXO_RADIUS_KEY) { log('L2TP/IPsec desligado: o serviço precisa de NEXO_RADIUS_KEY para ler as senhas dos concentradores'); return false; }
  for (const d of ['/etc/xl2tpd', '/etc/ppp', '/var/run/xl2tpd']) mkdirSync(d, { recursive: true });
  if (!existsSync('/dev/ppp')) try { sh('mknod', ['/dev/ppp', 'c', '108', '0']); } catch (e) { log(`sem /dev/ppp: ${(e as Error).message}`); return false; }
  writeFileSync('/etc/ipsec.conf', renderIpsecConf());
  writeFileSync('/etc/ipsec.secrets', renderIpsecSecrets(l2tpPsk()), { mode: 0o600 });
  writeFileSync('/etc/xl2tpd/xl2tpd.conf', renderXl2tpdConf());
  writeFileSync('/etc/ppp/options.xl2tpd', renderPppOptions());
  if (!existsSync('/etc/ppp/chap-secrets')) writeFileSync('/etc/ppp/chap-secrets', renderChapSecrets([]), { mode: 0o600 });
  return true;
}
let lastChap = '';
async function l2tpSync() {
  keep('ipsec', '/usr/sbin/ipsec', ['start', '--nofork']);
  keep('xl2tpd', '/usr/sbin/xl2tpd', ['-D', '-c', '/etc/xl2tpd/xl2tpd.conf']);
  const peers = await withScope(noScope, async (c) => (await c.query('select username, secret, tunnel_ip from l2tp_peers_all($1) order by tunnel_ip', [process.env.NEXO_RADIUS_KEY])).rows);
  const chap = renderChapSecrets(peers);
  if (chap !== lastChap) { writeFileSync('/etc/ppp/chap-secrets', chap, { mode: 0o600 }); lastChap = chap; log(`${peers.length} concentrador(es) no L2TP`); }  // o pppd lê a cada autenticação
}
let lastUp = '';
async function l2tpReport() {
  // interfaces ppp no ar: "ppp0 ... inet 10.251.0.1 peer 10.251.0.5/32"
  const up = sh('ip', ['-o', '-4', 'addr', 'show']).split('\n').map((l) => /^\d+: ppp\d+.* peer (10\.251\.\d+\.\d+)\//.exec(l)?.[1]).filter(Boolean) as string[];
  const mark = up.sort().join(',');
  if (mark === lastUp && Math.random() > 0.2) return;    // sem mudança: atualiza "visto por último" de vez em quando
  lastUp = mark;
  await withScope(noScope, (c) => c.query('select l2tp_report($1)', [up]));
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
  l2tpOn = l2tpSetup();
  let n = 0;
  for (;;) {
    try {
      await syncPeers(); if (n % 3 === 0) await report();
      if (l2tpOn) { await l2tpSync(); if (n % 3 === 0) await l2tpReport(); }
      n++;
    } catch (e) { log(`erro: ${(e as Error).message}`); await closePool().catch(() => {}); }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
