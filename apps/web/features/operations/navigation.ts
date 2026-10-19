import { can, hasModule, type Session } from "@/features/session/model";
export const erpAliases: Record<string, string> = { "/faturas": "/financeiro/faturas", "/conciliacao": "/financeiro/conciliacao", "/politica-cobranca": "/financeiro/politica-de-cobranca", "/relatorios-cobranca": "/relatorios/cobranca", "/adicionais": "/produtos-adicionais", "/ordens-servico": "/ordens-de-servico", "/rede": "/rede/equipamentos", "/operacoes": "/rede/operacoes", "/online": "/rede/online", "/mapa": "/rede/mapa", "/consulta-ip": "/rede/consulta-ip", "/ipam": "/rede/enderecos-ip", "/ftth": "/rede/ftth", "/onus": "/rede/onus", "/manutencoes": "/rede/manutencoes", "/usuarios": "/administracao/usuarios", "/empresas": "/administracao/empresas", "/avisos": "/administracao/avisos", "/avisos-assinante": "/administracao/avisos-assinante", "/integracoes": "/administracao/integracoes", "/qualidade": "/administracao/catalogos-sla", "/anatel": "/administracao/anatel", "/importacao": "/administracao/importacao", "/relatorios-atendimento": "/relatorios/atendimento" };
export function canonicalErpPath(path: string) { return erpAliases[path] ?? path; }
const policies: [string, string, string?][] = [
 ["/assinantes", "subscribers:read"], ["/contratos", "contracts:read"], ["/planos", "plans:read"], ["/produtos-adicionais", "plans:read"],
 ["/financeiro", "finance:read"], ["/relatorios/cobranca", "finance:read"], ["/atendimentos", "crm:read", "crm"], ["/prospectos", "crm:read", "crm"], ["/relatorios/atendimento", "crm:read", "crm"],
 ["/ordens-de-servico", "os:read", "field"], ["/agenda", "os:read", "field"], ["/meu-trabalho", "os:write", "field"], ["/estoque", "stock:read", "field"],
 ["/rede/mapa", "contracts:read"], ["/rede/consulta-ip", "legal:query"], ["/rede/enderecos-ip", "network:read", "ipam"], ["/rede/ftth/fttx-onu", "network:read", "olt"], ["/rede/ftth", "network:read", "ftth"], ["/rede/onus", "network:read", "olt"], ["/rede", "network:read"], ["/noc", "network:read", "noc"], ["/pops", "contracts:read"],
 ["/administracao/usuarios", "users:manage"], ["/administracao/empresas", "contracts:read"], ["/administracao/avisos-assinante", "settings:manage", "messages"], ["/administracao/avisos", "settings:manage", "notices"], ["/administracao/integracoes", "settings:manage", "api"], ["/administracao/importacao", "import:run"], ["/administracao", "settings:manage"], ["/auditoria", "audit:read"], ["/busca", "subscribers:read"], ["/", "subscribers:read"],
];
export function canAccessPath(me: Session | null, pathname: string): boolean {
 if (!me) return false;
 const path = canonicalErpPath(pathname);
 if (path === "/conta" || path.startsWith("/conta/")) return true;
 if (me.mfa_pending) return false;
 if (path === "/provedores" || path.startsWith("/provedores/")) return can(me, "tenants:manage") && !me.support;
 if (path === "/portal" || path.startsWith("/portal/")) return can(me, "portal:self");
 if (!me.tenant || me.role === "subscriber") return false;
 if (["/configuracoes", "/estrutura", "/acompanhamento", "/assistente"].includes(path)) return true;
 const policy = policies.find(([prefix]) => prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`));
 return Boolean(policy && can(me, policy[1]) && (!policy[2] || hasModule(me, policy[2])));
}
