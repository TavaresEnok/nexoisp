import { navigationRequirements } from "./navigation-requirements";

export type NavigationView = "overview" | "subscribers" | "plans" | "contracts" | "financial" | "support" | "field" | "network" | "network-online" | "network-map" | "network-olt" | "network-pon" | "network-cto" | "network-ip" | "network-onu-models" | "network-onu-templates" | "network-pools" | "network-nas" | "network-cgnat" | "settings";
export type NavigationNode = {
  href: string;
  label: string;
  sourceLabel: string;
  area: string;
  audience: "Equipe" | "Operador" | "Assinante" | "Público";
  trail: string[];
  parentHref: string | null;
  moduleHref: string;
  view?: NavigationView;
  children: NavigationNode[];
};
export type NavigationArea = { id: string; label: string; description: string; pages: NavigationNode[] };
type Requirement = { label: string; children: Requirement[] };

export function parseRequirements(text: string): Requirement[] {
  const roots: Requirement[] = [];
  const stack: Requirement[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || /^[│\s]+$/.test(line)) continue;
    const match = line.match(/^((?:│   |    )*)(?:├── |└── )(.*)$/);
    const node: Requirement = { label: match ? match[2] : line.trim(), children: [] };
    if (!match) {
      roots.push(node);
      stack.length = 0;
    } else {
      const depth = match[1].length / 4 + 1;
      if (!stack[depth - 1]) throw new Error(`Hierarquia inválida: ${line}`);
      stack[depth - 1].children.push(node);
      stack.length = depth;
    }
    stack.push(node);
  }
  return roots;
}
export function navigationSlug(label: string) {
  return label.split("→")[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
const specifications: Record<string, [string, string?, NavigationView?]> = {
  "ACESSO/Login": ["/login"], "ACESSO/Minha conta": ["/conta"],
  "INÍCIO/Painel inicial": ["/", "Painel inicial", "overview"], "INÍCIO/Busca global": ["/busca"],
  "ASSINANTES/Consultar": ["/assinantes", undefined, "subscribers"],
  "ASSINANTES/Contratos": ["/contratos", undefined, "contracts"],
  "ASSINANTES/Planos": ["/planos", undefined, "plans"],
  "ASSINANTES/Produtos adicionais": ["/produtos-adicionais"],
  "ATENDIMENTO/Atendimentos": ["/atendimentos", undefined, "support"],
  "ATENDIMENTO/Prospectos": ["/prospectos"], "ATENDIMENTO/Meu trabalho": ["/meu-trabalho"],
  "ATENDIMENTO/Ordens de serviço": ["/ordens-de-servico", undefined, "field"],
  "ATENDIMENTO/Agenda": ["/agenda"], "ATENDIMENTO/Estoque": ["/estoque"],
  "ATENDIMENTO/Relatórios de atendimento": ["/relatorios/atendimento"],
  "FINANCEIRO/Faturas": ["/financeiro/faturas", undefined, "financial"],
  "FINANCEIRO/Conciliação": ["/financeiro/conciliacao"],
  "FINANCEIRO/Política de cobrança": ["/financeiro/politica-de-cobranca"],
  "FINANCEIRO/Pela ficha financeira do contrato": ["/financeiro/contratos", "Ficha financeira do contrato"],
  "FINANCEIRO/Relatórios de cobrança": ["/relatorios/cobranca"],
  "REDE / FTTX/Agentes e equipamentos": ["/rede/equipamentos", undefined, "network"],
  "REDE / FTTX/Rede óptica — FTTH": ["/rede/ftth"],
  "REDE / FTTX/Endereços IP e CGNAT": ["/rede/enderecos-ip", undefined, "network-pools"],
  "REDE / FTTX/Operações": ["/rede/operacoes"], "REDE / FTTX/Manutenções": ["/rede/manutencoes"],
  "RELATÓRIO/Online agora": ["/rede/online", undefined, "network-online"],
  "RELATÓRIO/Consulta de IP": ["/rede/consulta-ip", undefined, "network-ip"],
  "RELATÓRIO/Mapa": ["/rede/mapa", undefined, "network-map"],
  "RELATÓRIO/Consultar ONU": ["/relatorios/consultar-onu"],
  "ADMINISTRAÇÃO/Usuários": ["/administracao/usuarios"], "ADMINISTRAÇÃO/Empresas": ["/administracao/empresas"],
  "ADMINISTRAÇÃO/Avisos": ["/administracao/avisos"], "ADMINISTRAÇÃO/Avisos ao assinante": ["/administracao/avisos-assinante"],
  "ADMINISTRAÇÃO/Integrações": ["/administracao/integracoes"], "ADMINISTRAÇÃO/Catálogos e SLA": ["/administracao/catalogos-sla"],
  "ADMINISTRAÇÃO/Coleta ANATEL — DICI": ["/administracao/anatel"], "ADMINISTRAÇÃO/Importação": ["/administracao/importacao"],
  "ADMINISTRAÇÃO/Auditoria": ["/auditoria"],
};
const roots = parseRequirements(navigationRequirements);
const audienceFor = (label: string): NavigationNode["audience"] => label.startsWith("OPERAÇÃO") ? "Operador" : label.startsWith("PORTAL") ? "Assinante" : label === "PÁGINA PÚBLICA" || label === "ACESSO" ? "Público" : "Equipe";
function moduleSpec(area: string, label: string): [string, string?, NavigationView?] {
  const defined = specifications[`${area}/${label}`];
  if (defined) return defined;
  if (area.startsWith("OPERAÇÃO")) return ["/provedores"];
  if (area === "PÁGINA PÚBLICA") return ["/aviso-bloqueio", "Aviso ao assinante bloqueado"];
  const portalRoutes = ["", "planos", "consumo", "faturas", "dados", "wifi", "religar", "atendimento", "documentos", "satisfacao", "sair"];
  const portal = roots.find(root => root.label.startsWith("PORTAL"))!;
  const index = portal.children.findIndex(child => child.label === label);
  if (index < 0) throw new Error(`Módulo sem rota: ${area}/${label}`);
  const shortLabels: Record<number, string> = { 5: "Meu Wi-Fi", 6: "Religar por confiança" };
  return [`/portal${portalRoutes[index] ? `/${portalRoutes[index]}` : ""}`, shortLabels[index]];
}
const opticalViews: Record<string, NavigationView> = {
  "/rede/ftth/fttx-olt": "network-olt",
  "/rede/ftth/fttx-pon": "network-pon",
  "/rede/ftth/fttx-cto": "network-cto",
  "/rede/ftth/fttx-onu-tipo": "network-onu-models",
  "/rede/ftth/fttx-onu-template": "network-onu-templates",
  "/rede/enderecos-ip/blocos-de-enderecos": "network-pools",
  "/rede/enderecos-ip/planos-de-cgnat": "network-cgnat",
  "/rede/equipamentos/concentradores": "network-nas",
};
function makeModule(root: Requirement, module: Requirement): NavigationNode {
  const [href, label, view] = moduleSpec(root.label, module.label);
  function makeNode(item: Requirement, path: string, trail: string[], parentHref: string | null, isModule = false): NavigationNode {
    return {
      href: path, label: isModule ? label ?? item.label : item.label, sourceLabel: item.label,
      area: root.label, audience: audienceFor(root.label), trail: [...trail, isModule ? label ?? item.label : item.label],
      parentHref, moduleHref: href, ...((isModule ? view : opticalViews[path]) ? { view: isModule ? view : opticalViews[path] } : {}),
      children: item.children.map(child => makeNode(child, `${path === "/" ? "" : path}/${navigationSlug(child.label)}`, [...trail, isModule ? label ?? item.label : item.label], path)),
    };
  }
  return makeNode(module, href, [root.label.split(" — ")[0]], null, true);
}
const modulesByArea = new Map(roots.map(root => [root.label, root.children.map(module => makeModule(root, module))]));
const area = (id: string, label: string, description: string, source: string): NavigationArea => ({ id, label, description, pages: modulesByArea.get(source)! });
export const navigationAreas: NavigationArea[] = [
  area("assinantes", "Assinantes", "Consultas, relacionamentos e contratos", "ASSINANTES"),
  area("relatorio", "Relatório", "Mapa, ONU, sessões online e consulta de IP", "RELATÓRIO"),
  area("financeiro", "Financeiro", "Faturas, cobrança e conciliação", "FINANCEIRO"),
  area("rede", "Rede / FTTx", "Infraestrutura e conectividade", "REDE / FTTX"),
  area("atendimento", "Atendimento", "Da primeira resposta à resolução", "ATENDIMENTO"),
  area("administracao", "Administração", "Pessoas, processos e integrações", "ADMINISTRAÇÃO"),
  area("saas", "Operação do SaaS", "Escopo exclusivo do operador", roots.find(root => root.label.startsWith("OPERAÇÃO"))!.label),
  area("portal", "Portal do assinante", "Escopo exclusivo do assinante autenticado", roots.find(root => root.label.startsWith("PORTAL"))!.label),
  { id: "acesso", label: "Acesso e páginas públicas", description: "Conta, autenticação e avisos", pages: [...modulesByArea.get("ACESSO")!, ...modulesByArea.get("PÁGINA PÚBLICA")!] },
];
export const navigationModules = [...modulesByArea.values()].flat();
function flatten(nodes: NavigationNode[]): NavigationNode[] {
  return nodes.flatMap(node => [node, ...flatten(node.children)]);
}
export const navigationPages = flatten(navigationModules);
const byHref = new Map(navigationPages.map(page => [page.href, page]));
export const navigationAliases: ReadonlyMap<string, string> = new Map([
  ["/operacoes", "/ordens-de-servico"],
  ["/rede", "/rede/online"],
  ["/financeiro", "/financeiro/faturas"],
]);
export function resolveNavigationPathname(pathname: string) {
  const normalized = pathname === "/" ? pathname : pathname.replace(/\/$/, "");
  return navigationAliases.get(normalized) ?? normalized;
}
export function findNavigationPage(pathname: string) {
  return byHref.get(resolveNavigationPathname(pathname));
}
export function isNavigationCurrent(node: NavigationNode, pathname: string) {
  return findNavigationPage(pathname)?.href === node.href;
}
export function searchNavigation(query: string) {
  const terms = navigationSlug(query).split("-").filter(Boolean);
  return navigationPages.filter(page => terms.every(term => navigationSlug(page.trail.join(" ")).includes(term)));
}
export const navigationCount = navigationPages.length;
