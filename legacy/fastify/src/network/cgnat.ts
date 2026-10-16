/** CGNAT determinístico (IPv4): cálculo puro, sem acesso a banco ou equipamento. */

export interface CgnatPlan {
  id: string; name: string; public_cidr: string; private_cidr: string; ports_per_subscriber: number; port_start: number;
}
export interface Block { private_ip: string; public_ip: string; port_start: number; port_end: number }

export const ipToInt = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
export const intToIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
export const isIpv4 = (s: string) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((o) => Number(o) <= 255);

export function parseCidr4(cidr: string): { base: number; size: number; mask: number } {
  const [ip, m] = cidr.split('/');
  const mask = Number(m);
  if (!isIpv4(ip) || !Number.isInteger(mask) || mask < 0 || mask > 32) throw new Error(`bloco IPv4 inválido: ${cidr}`);
  return { base: ipToInt(ip), size: 2 ** (32 - mask), mask };
}

/** Blocos de portas que cabem em um IP público. */
export const blocksPerPublic = (p: Pick<CgnatPlan, 'ports_per_subscriber' | 'port_start'>) => Math.floor((65536 - p.port_start) / p.ports_per_subscriber);

/** Capacidade do plano e o motivo de não caber, se for o caso. */
export function capacity(p: Pick<CgnatPlan, 'public_cidr' | 'private_cidr' | 'ports_per_subscriber' | 'port_start'>) {
  const pub = parseCidr4(p.public_cidr), priv = parseCidr4(p.private_cidr), per = blocksPerPublic(p);
  const max = pub.size * per;
  return { public_ips: pub.size, private_ips: priv.size, blocks_per_public: per, max_private_ips: max, fits: priv.size <= max,
    ratio: Math.min(per, Math.ceil(priv.size / pub.size)) };
}

/** IP privado -> IP público e bloco de portas. */
export function forward(p: CgnatPlan, privateIp: string): Block | null {
  const pub = parseCidr4(p.public_cidr), priv = parseCidr4(p.private_cidr), per = blocksPerPublic(p);
  const i = ipToInt(privateIp) - priv.base;
  if (!isIpv4(privateIp) || i < 0 || i >= priv.size) return null;
  const pi = Math.floor(i / per);
  if (pi >= pub.size) return null;
  const start = p.port_start + (i % per) * p.ports_per_subscriber;
  return { private_ip: privateIp, public_ip: intToIp(pub.base + pi), port_start: start, port_end: start + p.ports_per_subscriber - 1 };
}

/** IP público + porta -> IP privado. Null quando a porta está fora de qualquer bloco do plano. */
export function reverse(p: CgnatPlan, publicIp: string, port: number): Block | null {
  const pub = parseCidr4(p.public_cidr), priv = parseCidr4(p.private_cidr), per = blocksPerPublic(p);
  const pi = ipToInt(publicIp) - pub.base;
  if (!isIpv4(publicIp) || pi < 0 || pi >= pub.size || port < p.port_start) return null;
  const k = Math.floor((port - p.port_start) / p.ports_per_subscriber);
  const i = pi * per + k;
  if (k >= per || i >= priv.size) return null;
  return forward(p, intToIp(priv.base + i));
}

export function* blocks(p: CgnatPlan): Generator<Block> {
  const priv = parseCidr4(p.private_cidr);
  for (let i = 0; i < priv.size; i++) {
    const b = forward(p, intToIp(priv.base + i));
    if (b) yield b;
  }
}

/** n-ésimo prefixo de tamanho `len` dentro de um bloco IPv6 (ex.: 3º /56 de 2001:db8::/40). O banco normaliza a escrita. */
export function ipv6Subnet(pool: string, len: number, n: number): string {
  const [addr, mask] = pool.split('/');
  const [head, tail = ''] = addr.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8 || Number(mask) > len || len > 128) throw new Error(`bloco IPv6 inválido: ${pool}`);
  const base = groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
  const v = base + (BigInt(n) << BigInt(128 - len));
  return Array.from({ length: 8 }, (_, i) => ((v >> BigInt(16 * (7 - i))) & 0xffffn).toString(16)).join(':') + `/${len}`;
}

/** Script RouterOS v7 para REVISÃO HUMANA. Não é enviado a nenhum equipamento pelo sistema. */
export function routerosScript(p: CgnatPlan): string {
  const tag = `nexo-cgnat:${p.id.slice(0, 8)}`, chain = `nexo-cgnat-${p.id.slice(0, 8)}`;
  const cap = capacity(p);
  const out: string[] = [
    `# NexoISP — CGNAT determinístico "${p.name}"`,
    `# privado ${p.private_cidr} -> público ${p.public_cidr} · ${p.ports_per_subscriber} portas por assinante a partir da ${p.port_start} · até ${cap.ratio} assinante(s) por IP público`,
    `# GERADO PARA REVISÃO: o NexoISP não aplica este script. Confira em laboratório, ajuste a interface de saída e`,
    `# importe em janela de manutenção. Para remover: /ip firewall nat remove [find comment~"${tag}"]`,
    `/ip firewall nat`,
    `add chain=srcnat src-address=${p.private_cidr} action=jump jump-target=${chain} comment="${tag}"`,
  ];
  let cur = '', first = '', last = '';
  const other = () => { if (cur) out.push(`add chain=${chain} src-address=${first === last ? first : `${first}-${last}`} action=src-nat to-addresses=${cur} comment="${tag}"`); };
  for (const b of blocks(p)) {
    if (b.public_ip !== cur) { other(); cur = b.public_ip; first = b.private_ip; }
    last = b.private_ip;
    for (const proto of ['tcp', 'udp'])
      out.push(`add chain=${chain} src-address=${b.private_ip} protocol=${proto} action=src-nat to-addresses=${b.public_ip} to-ports=${b.port_start}-${b.port_end} comment="${tag}"`);
  }
  other();   // demais protocolos (ICMP etc.) saem pelo mesmo IP público, sem tradução de porta
  return out.join('\n') + '\n';
}
