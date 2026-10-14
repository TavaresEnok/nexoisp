import { generateKeyPairSync } from 'node:crypto';

/** Endereçamento do túnel. O concentrador só fala com o endereço do servidor; pares não se alcançam entre si. */
export const VPN_SERVER_IP = '10.250.0.1';
export const VPN_INTERNAL_PORT = 51820;
/** Dentro do túnel o RADIUS está sempre nas portas padrão, qualquer que seja a porta publicada para acesso direto. */
export const TUNNEL_AUTH_PORT = 1812, TUNNEL_ACCT_PORT = 1813;

/** Par de chaves do concentrador (X25519, formato do WireGuard). A privada é entregue uma vez e não é guardada. */
export function newPeerKeys(): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const b64 = (v: string) => Buffer.from(v, 'base64url').toString('base64');
  return { privateKey: b64(privateKey.export({ format: 'jwk' }).d!), publicKey: b64(publicKey.export({ format: 'jwk' }).x!) };
}

export const vpnEndpoint = () => ({
  host: process.env.NEXO_VPN_PUBLIC_HOST || process.env.NEXO_RADIUS_PUBLIC_HOST || '<endereço do NexoISP>',
  port: Number(process.env.NEXO_VPN_PORT ?? VPN_INTERNAL_PORT),
});

/** Configuração aplicada no servidor: um par por concentrador, cada um restrito ao próprio endereço. */
export function renderServerConf(privateKey: string, peers: { public_key: string; tunnel_ip: string }[]): string {
  return [`[Interface]`, `PrivateKey = ${privateKey}`, `ListenPort = ${VPN_INTERNAL_PORT}`, '',
    ...peers.flatMap((p) => [`[Peer]`, `PublicKey = ${p.public_key}`, `AllowedIPs = ${p.tunnel_ip}/32`, ''])].join('\n');
}

// ---------------------------------------------------------------- L2TP/IPsec
/** Concentradores sem WireGuard: L2TP sobre IPsec (transporte, chave da instalação), usuário e senha por concentrador. */
export const L2TP_SERVER_IP = '10.251.0.1';
export const l2tpPsk = () => process.env.NEXO_L2TP_PSK ?? '';
export const l2tpConfigured = () => /^[A-Za-z0-9_-]{16,}$/.test(l2tpPsk());

export function renderIpsecConf(): string {
  return [
    'config setup', '  uniqueids=no', '',
    'conn nexoisp-l2tp',
    '  keyexchange=ikev1', '  authby=secret', '  type=transport',
    '  left=%any', '  leftprotoport=17/1701', '  right=%any', '  rightprotoport=17/%any', '  auto=add',
    // RouterOS 6/7, Huawei e Cisco negociam ao menos uma destas; 3DES/MODP1024 só para equipamentos antigos
    '  ike=aes256-sha256-modp2048,aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024!',
    // fase 2: com e sem PFS (o RouterOS pede PFS com MODP1024 por padrão — medido com o 7.17; sem o grupo na lista, NO_PROPOSAL_CHOSEN)
    '  esp=aes256-sha256-modp2048,aes256-sha1-modp2048,aes256-sha1-modp1024,aes192-sha1-modp1024,aes128-sha1-modp1024,aes256-sha256,aes256-sha1,aes128-sha1,3des-sha1!',
    '  dpddelay=30s', '  dpdtimeout=120s', '  dpdaction=clear', '  rekey=no', '  ikelifetime=8h', '  lifetime=1h', '',
  ].join('\n');
}
/**
 * O plugin bypass-lan do strongSwan deixa passar sem cifrar o tráfego das redes locais do contêiner. Atrás do proxy de portas do Docker
 * (ou de um NAT na mesma rede) o concentrador aparece com um endereço dessas redes e a resposta L2TP sairia em claro (medido no lab).
 */
export const renderStrongswanConf = () => 'charon {\n  plugins {\n    bypass-lan {\n      load = no\n    }\n  }\n}\n';
export const renderIpsecSecrets = (psk: string) => `%any %any : PSK "${psk.replace(/"/g, '')}"\n`;
export function renderXl2tpdConf(): string {
  return ['[global]', 'port = 1701', 'ipsec saref = no', 'force userspace = yes', '',
    '[lns default]', `local ip = ${L2TP_SERVER_IP}`, 'assign ip = no', 'require authentication = yes', 'refuse pap = yes', 'require chap = yes',
    'name = nexoisp', 'pppoptfile = /etc/ppp/options.xl2tpd', 'length bit = yes', ''].join('\n');
}
export function renderPppOptions(): string {
  return ['name nexoisp', 'auth', 'refuse-pap', 'nodefaultroute', 'noproxyarp', 'noccp', 'novj', 'novjccomp', 'nobsdcomp', 'nodeflate',
    'mtu 1400', 'mru 1400', 'lcp-echo-interval 30', 'lcp-echo-failure 4', 'noipdefault', ''].join('\n');
}
/** Um par usuário/senha/endereço por concentrador: o endereço fixo da linha é o que o pppd entrega a ele. */
export function renderChapSecrets(peers: { username: string; secret: string; tunnel_ip: string }[]): string {
  return ['# gerado pelo NexoISP — não editar', ...peers.map((p) => `"${p.username}" nexoisp "${p.secret.replace(/"/g, '')}" ${p.tunnel_ip}`), ''].join('\n');
}
