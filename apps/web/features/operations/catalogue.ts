import {
  navigationAreas,
  navigationPages,
  searchNavigation,
  type NavigationNode,
} from "@/lib/navigation";
import { normalize } from "@/lib/format";
import { can, hasModule, type Session } from "@/features/session/model";

// Extensões operacionais não alteram o catálogo da demonstração original.
function extension(area: string, href: string, label: string): NavigationNode {
  return {
    href,
    label,
    sourceLabel: label,
    area,
    audience: "Equipe",
    trail: [area, label],
    parentHref: null,
    moduleHref: href,
    children: [],
  };
}
const extensions: Record<string, NavigationNode[]> = {
  financeiro: [extension("Financeiro", "/relatorios/indicacoes", "Indicações")],
  rede: [
    extension("Rede / FTTx", "/noc", "NOC"),
    extension("Rede / FTTx", "/pops", "Pontos de presença"),
  ],
};
const extensionPages = Object.values(extensions).flat();

// Recursos do desenho v0 sem suporte no backend Go.
export const plannedPaths: ReadonlySet<string> = new Set([
  "/rede/ftth/fttx-pon",
  "/rede/ftth/fttx-onu-tipo",
  "/rede/ftth/fttx-onu-template",
  "/rede/ftth/acs-template",
  "/assistente",
  "/acompanhamento",
]);

const recordId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRecordId = (value: string) => recordId.test(value);

type Guard = (me: Session) => boolean;
// Submenus do catálogo com destino próprio: página, alias ou aba. Os demais
// descendentes são subações da página ancestral; ficam fora do menu e as URLs
// diretas redirecionam para ela.
const destinations: Record<string, string | [string, Guard]> = {
  "/relatorios/cobranca/carteira-por-atraso": "/relatorios/cobranca",
  "/relatorios/cobranca/recebido": "/relatorios/cobranca?aba=receipts",
  "/relatorios/cobranca/clientes-sem-fatura":
    "/relatorios/cobranca?aba=without",
  "/relatorios/cobranca/candidatos-a-cancelamento-por-atraso":
    "/relatorios/cobranca?aba=cancel",
  "/rede/equipamentos/concentradores": "/rede/equipamentos",
  "/rede/equipamentos/agentes-locais": "/rede/equipamentos",
  "/rede/equipamentos/equipamentos-e-olts": "/rede/equipamentos",
  "/rede/ftth/fttx-olt": "/rede/equipamentos",
  "/rede/ftth/fttx-cto": "/rede/ftth/fttx-cto",
  "/rede/enderecos-ip/blocos-de-enderecos":
    "/rede/enderecos-ip/blocos-de-enderecos",
  "/rede/enderecos-ip/planos-de-cgnat": "/rede/enderecos-ip/planos-de-cgnat",
  "/rede/enderecos-ip/rastrear-conexao-por-ip-publico-porta-e-instante":
    "/rede/consulta-ip",
  "/administracao/avisos-assinante/aba-regua":
    "/administracao/avisos-assinante",
  "/administracao/avisos-assinante/aba-modelos":
    "/administracao/avisos-assinante?aba=modelos",
  "/administracao/avisos-assinante/aba-canais-de-envio":
    "/administracao/avisos-assinante?aba=canais",
  "/administracao/avisos-assinante/aba-historico":
    "/administracao/avisos-assinante?aba=historico",
  "/administracao/integracoes/aba-tokens-da-api": "/administracao/integracoes",
  "/administracao/integracoes/aba-webhooks":
    "/administracao/integracoes?aba=webhooks",
  "/administracao/integracoes/aba-entregas":
    "/administracao/integracoes?aba=entregas",
  "/administracao/catalogos-sla/aba-catalogos": "/administracao/catalogos-sla",
  "/administracao/catalogos-sla/aba-sla": [
    "/administracao/catalogos-sla?aba=sla",
    (me) => hasModule(me, "crm") || hasModule(me, "field"),
  ],
  "/administracao/catalogos-sla/aba-satisfacao": [
    "/administracao/catalogos-sla?aba=satisfacao",
    (me) => hasModule(me, "field"),
  ],
  "/administracao/catalogos-sla/aba-campos-personalizados":
    "/administracao/catalogos-sla?aba=campos",
  "/administracao/catalogos-sla/aba-kits-de-instalacao": [
    "/administracao/catalogos-sla?aba=kits",
    (me) => hasModule(me, "field") && can(me, "stock:read"),
  ],
  "/administracao/catalogos-sla/aba-comissoes": [
    "/administracao/catalogos-sla?aba=comissoes",
    (me) => can(me, "finance:read"),
  ],
};
// Ações "Novo …" do menu do v0 abrem o diálogo da página (?novo=<tipo>) e só
// aparecem para quem pode usar o botão correspondente.
const write =
  (permission: string, module?: string): Guard =>
  (me) =>
    can(me, permission) && (!module || hasModule(me, module));
const creations: Record<string, [string, Guard]> = {
  "/assinantes/novo-assinante": [
    "/assinantes?novo=assinante",
    write("subscribers:write"),
  ],
  "/planos/novo-plano": ["/planos?novo=plano", write("plans:write")],
  "/produtos-adicionais/cadastrar-produto": [
    "/produtos-adicionais?novo=produto",
    write("plans:write"),
  ],
  "/atendimentos/novo-atendimento": [
    "/atendimentos?novo=atendimento",
    write("crm:write", "crm"),
  ],
  "/prospectos/novo-prospecto": [
    "/prospectos?novo=prospecto",
    write("crm:write", "crm"),
  ],
  "/ordens-de-servico/nova-os": [
    "/ordens-de-servico?novo=os",
    write("os:write", "field"),
  ],
  "/estoque/novo-item": ["/estoque?novo=item", write("stock:write", "field")],
  "/financeiro/faturas/gerar-mensalidades-por-competencia": [
    "/financeiro/faturas?novo=mensalidades",
    write("finance:write"),
  ],
  "/rede/equipamentos/concentradores/novo-concentrador": [
    "/rede/equipamentos?novo=concentrador",
    write("network:write"),
  ],
  "/rede/equipamentos/agentes-locais/novo-agente": [
    "/rede/equipamentos?novo=agente",
    write("network:write"),
  ],
  "/rede/equipamentos/equipamentos-e-olts/novo-equipamento": [
    "/rede/equipamentos?novo=equipamento",
    write("network:write"),
  ],
  "/rede/equipamentos/equipamentos-e-olts/cadastrar-olt-e-vincular-ao-agente": [
    "/rede/equipamentos?novo=equipamento",
    write("network:write", "olt"),
  ],
  "/rede/enderecos-ip/blocos-de-enderecos/novo-bloco": [
    "/rede/enderecos-ip/blocos-de-enderecos?novo=bloco",
    write("network:write", "ipam"),
  ],
  "/rede/enderecos-ip/planos-de-cgnat/novo-plano": [
    "/rede/enderecos-ip/planos-de-cgnat?novo=cgnat",
    write("network:write", "ipam"),
  ],
  "/rede/manutencoes/novo-aviso": [
    "/rede/manutencoes?novo=aviso",
    write("network:write"),
  ],
  "/administracao/usuarios/novo-usuario": [
    "/administracao/usuarios?novo=usuario",
    write("users:manage"),
  ],
  "/administracao/empresas/nova-empresa": [
    "/administracao/empresas?novo=empresa",
    write("settings:manage"),
  ],
  "/provedores/novo-provedor-e-administrador-inicial": [
    "/provedores?novo=provedor",
    write("tenants:manage"),
  ],
  "/portal/atendimento/abrir-chamado": [
    "/portal/atendimento?novo=chamado",
    (me) => hasModule(me, "crm"),
  ],
};
Object.assign(destinations, creations);
const catalogue = new Map(navigationPages.map((page) => [page.href, page]));
export type CatalogueResolution =
  | { kind: "page"; destination: string }
  | { kind: "subaction"; destination: string }
  | { kind: "planned" };
export function resolveCatalogueNode(
  href: string,
): CatalogueResolution | undefined {
  if (plannedPaths.has(href)) return { kind: "planned" };
  const node = catalogue.get(href);
  if (!node) return undefined;
  if (node.parentHref === null) return { kind: "page", destination: href };
  const target = destinations[href];
  if (target)
    return {
      kind: "page",
      destination: typeof target === "string" ? target : target[0],
    };
  const parent = resolveCatalogueNode(node.parentHref);
  return parent?.kind === "planned" || !parent
    ? parent
    : { kind: "subaction", destination: parent.destination };
}
// Caminho da página que atende o nó; demais caminhos permanecem inalterados.
export function catalogueTarget(path: string) {
  const resolution = resolveCatalogueNode(path);
  return resolution && resolution.kind !== "planned"
    ? resolution.destination.split("?")[0]
    : path;
}
export function catalogueAllows(me: Session, path: string): boolean {
  const node = catalogue.get(path);
  if (!node) return true;
  const target = destinations[path];
  if (Array.isArray(target) && !target[1](me)) return false;
  return node.parentHref === null || catalogueAllows(me, node.parentHref);
}
function visible(node: NavigationNode) {
  return resolveCatalogueNode(node.href)?.kind !== "subaction";
}
export function operationalBranch(node: NavigationNode): NavigationNode {
  return {
    ...node,
    children: node.children.filter(visible).map(operationalBranch),
  };
}
export function operationalNavigationAreas() {
  return navigationAreas.map((area) => ({
    ...area,
    pages: [
      ...area.pages.map(operationalBranch),
      ...(extensions[area.id] ?? []),
    ],
  }));
}
export function findOperationalPage(path: string) {
  return extensionPages.find((page) => page.href === path);
}
export function searchOperationalNavigation(query: string) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return [
    ...searchNavigation(query).filter(visible),
    ...extensionPages.filter((page) =>
      terms.every((term) => normalize(page.trail.join(" ")).includes(term)),
    ),
  ];
}
