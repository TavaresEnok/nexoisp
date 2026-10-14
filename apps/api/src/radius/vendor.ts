/**
 * O protocolo RADIUS é o mesmo em qualquer concentrador; o que muda por fabricante são os ATRIBUTOS que carregam perfil,
 * velocidade e pool. Este arquivo é a única parte que conhece os fabricantes.
 * Situação: MikroTik validado em laboratório (CHR). Huawei e Cisco seguem a documentação dos fabricantes e os dicionários do
 * servidor RADIUS, mas NÃO foram exercitados em equipamento: tratar como não homologados.
 */
export const VENDORS = ['mikrotik', 'huawei', 'cisco', 'generic'] as const;
export type Vendor = (typeof VENDORS)[number];
export const VENDOR_VALIDATED: Record<Vendor, boolean> = { mikrotik: true, huawei: false, cisco: false, generic: false };

export interface Row { attribute: string; op: string; value: string }
export interface Wanted {
  policy: 'active' | 'suspended';
  profile: string;                 // perfil do plano
  blockProfile?: string | null;    // suspensão por perfil (bloqueio ou velocidade reduzida)
  rateLimit?: string | null;       // formato MikroTik; só MikroTik entende
  addressPool?: string | null;
  framedIp?: string | null;
  acctInterim?: number | null;
  simultaneousUse?: number | null;
  mac?: string | null;
  downKbps: number;
  upKbps: number;
}

/** Perfil que vale agora: o de bloqueio durante a suspensão por perfil, senão o do plano. */
export const effectiveProfile = (w: Wanted) => (w.policy === 'suspended' && w.blockProfile ? w.blockProfile : w.profile);
const byProfile = (w: Wanted) => w.policy === 'suspended' && !!w.blockProfile;

/** Atributos de CONFERÊNCIA (o que precisa bater para autenticar). Iguais para todos os fabricantes. */
export function checkRows(w: Wanted): Row[] {
  const rows: Row[] = [];
  if (w.policy === 'suspended' && !byProfile(w)) rows.push({ attribute: 'Auth-Type', op: ':=', value: 'Reject' });
  if (w.mac) rows.push({ attribute: 'Calling-Station-Id', op: '==', value: w.mac });
  if (w.simultaneousUse) rows.push({ attribute: 'Simultaneous-Use', op: ':=', value: String(w.simultaneousUse) });
  return rows;
}

/** Atributos de RESPOSTA, por fabricante. Suspensa por perfil, velocidade e pool são os do perfil de bloqueio. */
export function replyRows(vendor: Vendor, w: Wanted): Row[] {
  const blocked = byProfile(w), profile = effectiveProfile(w);
  const rows: Row[] = [];
  const set = (attribute: string, value: string | number, op = ':=') => rows.push({ attribute, op, value: String(value) });
  if (vendor === 'mikrotik') {
    set('Mikrotik-Group', profile);
    if (!blocked && w.rateLimit) set('Mikrotik-Rate-Limit', w.rateLimit);
  } else if (vendor === 'huawei') {
    // NE/ME: velocidade em bit/s direto do plano (Input = do assinante, Output = para o assinante); bloqueio por perfil de QoS
    if (blocked) set('Huawei-Qos-Profile-Name', profile);
    else { set('Huawei-Input-Average-Rate', w.upKbps * 1000); set('Huawei-Output-Average-Rate', w.downKbps * 1000); }
  } else if (vendor === 'cisco') {
    // IOS XE/ASR: o perfil é o nome do policy-map de QoS aplicado à sessão nos dois sentidos
    set('Cisco-AVPair', `ip:sub-qos-policy-in=${profile}`, '+=');
    set('Cisco-AVPair', `ip:sub-qos-policy-out=${profile}`, '+=');
  } else {
    set('Filter-Id', profile);
  }
  if (!blocked && w.addressPool) {
    if (vendor === 'cisco') set('Cisco-AVPair', `ip:addr-pool=${w.addressPool}`, '+='); else set('Framed-Pool', w.addressPool);
  }
  if (w.framedIp) set('Framed-IP-Address', w.framedIp);
  if (w.acctInterim) set('Acct-Interim-Interval', w.acctInterim);
  return rows;
}

export interface Tunnel { privateKey: string; serverPublicKey: string; endpointHost: string; endpointPort: number; tunnelIp: string; serverIp: string }
/** Fabricantes em que sabemos montar o túnel pelo painel. Huawei e Cisco não têm WireGuard: usam acesso direto. */
export const TUNNEL_VENDORS: Vendor[] = ['mikrotik', 'generic'];

/**
 * Comandos para o provedor colar no concentrador. `secret` e a chave privada do túnel só são conhecidos na criação/troca;
 * depois vão marcadores. Com túnel, o RADIUS é o endereço interno do servidor e os pacotes saem do endereço do túnel.
 */
export function setupCommands(vendor: Vendor, o: { host: string; authPort: number; acctPort: number; coaPort: number; secret: string; tunnel?: Tunnel | null }): string {
  const tn = o.tunnel;
  if (vendor === 'mikrotik') return [
    ...(tn ? [
      `# 1. túnel até o NexoISP (RouterOS 7 ou mais novo)`,
      `/interface wireguard add name=nexoisp private-key="${tn.privateKey}" comment=nexoisp`,
      `/interface wireguard peers add interface=nexoisp public-key="${tn.serverPublicKey}" endpoint-address=${tn.endpointHost} endpoint-port=${tn.endpointPort} allowed-address=${tn.serverIp}/32 persistent-keepalive=25s comment=nexoisp`,
      `/ip address add address=${tn.tunnelIp}/32 network=${tn.serverIp} interface=nexoisp comment=nexoisp`,
      `/ip firewall filter add chain=input in-interface=nexoisp protocol=udp dst-port=${o.coaPort} action=accept place-before=0 comment="nexoisp: desconexao de sessao"`,
      `# 2. autenticação pelo túnel`,
    ] : []),
    `/radius add service=ppp address=${o.host} secret="${o.secret}" authentication-port=${o.authPort} accounting-port=${o.acctPort} timeout=3s${tn ? ` src-address=${tn.tunnelIp}` : ''} comment=nexoisp`,
    `/radius incoming set accept=yes port=${o.coaPort}`,
    `/ppp aaa set use-radius=yes accounting=yes interim-update=5m`,
  ].join('\n');
  if (vendor === 'huawei') return [
    `radius-server group nexoisp`,
    ` radius-server authentication ${o.host} ${o.authPort} weight 0`,
    ` radius-server accounting ${o.host} ${o.acctPort} weight 0`,
    ` radius-server shared-key cipher ${o.secret}`,
    `radius-server authorization ${o.host} shared-key cipher ${o.secret}`,
    `aaa`,
    ` authentication-scheme nexoisp`,
    `  authentication-mode radius`,
    ` accounting-scheme nexoisp`,
    `  accounting-mode radius`,
    `  accounting interim interval 5`,
    ` domain nexoisp`,
    `  authentication-scheme nexoisp`,
    `  accounting-scheme nexoisp`,
    `  radius-server group nexoisp`,
  ].join('\n');
  if (vendor === 'cisco') return [
    `aaa new-model`,
    `radius server nexoisp`,
    ` address ipv4 ${o.host} auth-port ${o.authPort} acct-port ${o.acctPort}`,
    ` key ${o.secret}`,
    `aaa group server radius NEXOISP`,
    ` server name nexoisp`,
    `aaa authentication ppp default group NEXOISP`,
    `aaa authorization network default group NEXOISP`,
    `aaa accounting network default start-stop group NEXOISP`,
    `aaa accounting update periodic 5`,
    `aaa server radius dynamic-author`,
    ` client ${o.host} server-key ${o.secret}`,
    ` port ${o.coaPort}`,
  ].join('\n');
  return [
    ...(tn ? [
      `Túnel WireGuard`,
      `  chave privada deste equipamento: ${tn.privateKey}`,
      `  endereço deste equipamento no túnel: ${tn.tunnelIp}/32`,
      `  par (servidor): chave pública ${tn.serverPublicKey}`,
      `  endereço do par: ${tn.endpointHost}:${tn.endpointPort}  |  redes permitidas: ${tn.serverIp}/32  |  keepalive: 25 s`,
      ``,
    ] : []),
    `Servidor RADIUS: ${o.host}${tn ? ` (pelo túnel; origem ${tn.tunnelIp})` : ''}`,
    `Porta de autenticação: ${o.authPort}  |  Porta de accounting: ${o.acctPort}`,
    `Segredo compartilhado: ${o.secret}`,
    `Desconexão (RFC 5176): aceitar de ${o.host} na porta ${o.coaPort}`,
    `Atualização de accounting: 5 minutos`,
  ].join('\n');
}
