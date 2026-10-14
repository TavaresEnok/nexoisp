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
