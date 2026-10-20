// Fonte única das páginas operacionais: rotas, permissões, títulos e aliases.
// application.tsx monta <Routes> a partir daqui; navigation.ts e status.ts
// derivam acesso, endereço canônico e situação de integração.

// "conta": qualquer sessão; "equipe": equipe de um provedor; "saas": operação
// do SaaS fora do modo suporte; "portal": assinante; tupla: permissão e módulo.
export type PageAccess =
  | "conta"
  | "equipe"
  | "saas"
  | "portal"
  | readonly [permission: string, module?: string];

type PageDefinition = {
  // O primeiro caminho é o canônico; os demais abrem a mesma página.
  paths: readonly string[];
  access: PageAccess;
  title?: string;
  // Caminho com curinga para páginas com sub-rotas próprias.
  nested?: boolean;
  aliases?: readonly string[];
};

export const operationalPages = {
  overview: { paths: ["/"], access: ["subscribers:read"] },
  referrals: {
    paths: ["/relatorios/indicacoes"],
    access: ["finance:read"],
    title: "Relatório de indicações",
  },
  settings: { paths: ["/configuracoes"], access: "equipe" },
  directory: { paths: ["/estrutura"], access: "equipe" },
  dataImport: {
    paths: ["/administracao/importacao"],
    access: ["import:run"],
    aliases: ["/importacao"],
  },
  integrations: {
    paths: ["/administracao/integracoes"],
    access: ["settings:manage", "api"],
    aliases: ["/integracoes"],
  },
  teamNotices: {
    paths: ["/administracao/avisos"],
    access: ["settings:manage", "notices"],
    aliases: ["/avisos"],
  },
  subscriberMessages: {
    paths: ["/administracao/avisos-assinante"],
    access: ["settings:manage", "messages"],
    aliases: ["/avisos-assinante"],
  },
  portalSignOut: { paths: ["/portal/sair"], access: "portal" },
  portal: { paths: ["/portal"], access: "portal", nested: true },
  tenants: { paths: ["/provedores"], access: "saas" },
  anatel: {
    paths: ["/administracao/anatel"],
    access: ["settings:manage"],
    aliases: ["/anatel"],
  },
  audit: { paths: ["/auditoria"], access: ["audit:read"] },
  quality: {
    paths: ["/administracao/catalogos-sla"],
    access: ["settings:manage"],
    aliases: ["/qualidade"],
  },
  search: { paths: ["/busca"], access: ["subscribers:read"], title: "Busca" },
  team: {
    paths: ["/administracao/usuarios"],
    access: ["users:manage"],
    aliases: ["/usuarios"],
  },
  companies: {
    paths: ["/administracao/empresas"],
    access: ["contracts:read"],
    aliases: ["/empresas"],
  },
  map: {
    paths: ["/rede/mapa"],
    access: ["contracts:read"],
    aliases: ["/mapa"],
  },
  legalIp: {
    paths: ["/rede/consulta-ip"],
    access: ["legal:query"],
    aliases: ["/consulta-ip"],
  },
  cgnat: {
    paths: ["/rede/enderecos-ip/planos-de-cgnat"],
    access: ["network:read", "ipam"],
  },
  addresses: {
    paths: ["/rede/enderecos-ip", "/rede/enderecos-ip/blocos-de-enderecos"],
    access: ["network:read", "ipam"],
    aliases: ["/ipam"],
  },
  fiber: {
    paths: ["/rede/ftth", "/rede/ftth/fttx-cto"],
    access: ["network:read", "ftth"],
    aliases: ["/ftth"],
  },
  pops: {
    paths: ["/pops"],
    access: ["contracts:read"],
    title: "Pontos de presença",
  },
  maintenance: {
    paths: ["/rede/manutencoes"],
    access: ["network:read"],
    title: "Manutenções",
    aliases: ["/manutencoes"],
  },
  onus: {
    // Destino do item "Relatório > Consultar ONU" do menu original do v0.
    paths: ["/relatorios/consultar-onu", "/rede/ftth/fttx-onu"],
    access: ["network:read", "olt"],
    title: "ONUs e autorizações",
    aliases: ["/onus", "/rede/onus"],
  },
  noc: { paths: ["/noc"], access: ["network:read", "noc"], title: "NOC" },
  online: {
    paths: ["/rede/online"],
    access: ["network:read"],
    aliases: ["/online"],
  },
  operations: {
    paths: ["/rede/operacoes"],
    access: ["network:read"],
    title: "Operações de rede",
    aliases: ["/operacoes"],
  },
  equipment: {
    paths: ["/rede/equipamentos"],
    access: ["network:read"],
    aliases: [
      "/rede",
      "/rede/equipamentos/concentradores",
      "/rede/ftth/fttx-olt",
    ],
  },
  stock: {
    paths: ["/estoque"],
    access: ["stock:read", "field"],
    title: "Estoque",
  },
  agenda: { paths: ["/agenda"], access: ["os:read", "field"], title: "Agenda" },
  myWork: {
    paths: ["/meu-trabalho"],
    access: ["os:write", "field"],
    title: "Meu trabalho",
  },
  orders: {
    paths: ["/ordens-de-servico"],
    access: ["os:read", "field"],
    aliases: ["/ordens-servico"],
  },
  leads: { paths: ["/prospectos"], access: ["crm:read", "crm"] },
  tickets: { paths: ["/atendimentos"], access: ["crm:read", "crm"] },
  crmReport: {
    paths: ["/relatorios/atendimento"],
    access: ["crm:read", "crm"],
    aliases: ["/relatorios-atendimento"],
  },
  collectionReports: {
    paths: ["/relatorios/cobranca"],
    access: ["finance:read"],
    aliases: ["/relatorios-cobranca"],
  },
  financePolicy: {
    paths: ["/financeiro/politica-de-cobranca"],
    access: ["finance:read"],
    aliases: ["/politica-cobranca"],
  },
  reconciliation: {
    paths: ["/financeiro/conciliacao"],
    access: ["finance:read"],
    aliases: ["/conciliacao"],
  },
  invoices: {
    paths: ["/financeiro/faturas"],
    access: ["finance:read"],
    aliases: ["/financeiro", "/faturas"],
  },
  contracts: {
    paths: ["/contratos"],
    access: ["contracts:read"],
    aliases: ["/financeiro/contratos"],
  },
  addons: {
    paths: ["/produtos-adicionais"],
    access: ["plans:read"],
    aliases: ["/adicionais"],
  },
  plans: { paths: ["/planos"], access: ["plans:read"] },
  account: { paths: ["/conta"], access: "conta", nested: true },
  subscribers: { paths: ["/assinantes"], access: ["subscribers:read"] },
} as const satisfies Record<string, PageDefinition>;

export type OperationalPageId = keyof typeof operationalPages;
type Page = PageDefinition & { id: OperationalPageId };
export const pageList: readonly Page[] = Object.entries(operationalPages).map(
  ([id, page]) => ({ ...page, id: id as OperationalPageId }),
);

// Áreas sem página própria: valem para recursos planejados e destinos do
// catálogo abaixo delas. A página mais específica sempre prevalece.
export const areaAccess: readonly (readonly [string, PageAccess])[] = [
  ["/financeiro", ["finance:read"]],
  ["/rede", ["network:read"]],
  ["/administracao", ["settings:manage"]],
  ["/acompanhamento", "equipe"],
  ["/assistente", "equipe"],
];

// Fichas abertas por identificador redirecionam para a lista com o parâmetro.
export const recordLinks = [
  { path: "/contratos/:id", base: "/contratos", param: "contrato" },
  { path: "/assinantes/:id", base: "/assinantes", param: "ficha" },
] as const;

export const pageAliases: Readonly<Record<string, string>> = Object.fromEntries(
  pageList.flatMap((page) =>
    (page.aliases ?? []).map((alias) => [alias, page.paths[0]]),
  ),
);

export const pageTitles: Readonly<Record<string, string>> = Object.fromEntries(
  pageList.flatMap((page) =>
    page.title ? page.paths.map((path) => [path, page.title!]) : [],
  ),
);

// Caminhos declarados como <Route>, na forma usada pelo roteador.
export const routePaths: readonly string[] = [
  ...pageList.flatMap((page) =>
    page.paths.map((path) => (page.nested ? `${path}/*` : path)),
  ),
  ...recordLinks.map((link) => link.path),
  ...Object.keys(pageAliases),
];

const accessRules = [
  ...pageList.flatMap((page) =>
    page.paths.map((path) => [path, page.access] as const),
  ),
  ...areaAccess,
].sort(([a], [b]) => b.length - a.length);

export function pageAccess(path: string): PageAccess | undefined {
  return accessRules.find(([prefix]) =>
    prefix === "/"
      ? path === "/"
      : path === prefix || path.startsWith(`${prefix}/`),
  )?.[1];
}

export function hasPage(path: string) {
  return pageList.some(
    (page) =>
      page.paths.includes(path) ||
      (page.nested && path.startsWith(`${page.paths[0]}/`)),
  );
}
