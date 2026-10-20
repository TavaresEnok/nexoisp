import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  canAccessPath,
  canonicalErpPath,
  erpAliases,
} from "../features/operations/navigation";
import {
  isRecordId,
  operationalBranch,
  operationalNavigationAreas,
  resolveCatalogueNode,
  searchOperationalNavigation,
} from "../features/operations/catalogue";
import { integrationStatus } from "../features/operations/status";
import { routePaths } from "../features/operations/pages";
import { findNavigationPage, navigationPages } from "../lib/navigation";
import type { Session } from "../features/session/model";

function declaredRoutes(file: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const paths: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(source) === "Route"
    ) {
      const path = node.attributes.properties.find(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(source) === "path",
      );
      if (
        path &&
        ts.isJsxAttribute(path) &&
        path.initializer &&
        ts.isStringLiteral(path.initializer)
      )
        paths.push(path.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return paths;
}
const routes = [...routePaths, "/login"];

test("rotas operacionais vêm somente do registro de páginas", () => {
  assert.deepEqual(
    declaredRoutes("features/operations/application.tsx").sort(),
    ["*", "*", "/login"],
    "Declare a página em features/operations/pages.ts em vez de escrever <Route> à mão.",
  );
});
const hasRoute = (path: string) =>
  routes.some(
    (route) =>
      route !== "*" &&
      (route === path ||
        (route.endsWith("/*") &&
          (path === route.slice(0, -2) ||
            path.startsWith(route.slice(0, -1))))),
  );

test("destinos antigos e aliases apontam a elementos Route existentes, além do rótulo de integração", () => {
  const old = declaredRoutes("../web-legacy/src/App.tsx").filter(
    (path) => path !== "*" && !path.includes(":"),
  );
  assert.ok(old.length >= 35);
  for (const path of [...old, ...Object.keys(erpAliases)]) {
    const target = canonicalErpPath(path);
    assert.ok(
      hasRoute(target),
      `${path}: destino sem Route operacional: ${target}`,
    );
    if (path !== "/login")
      assert.equal(integrationStatus(path), "connected", path);
  }
});
test("views do catálogo v0 disponíveis no Go têm destino operacional; catálogos sem backend continuam explícitos", () => {
  const futureViews = new Set([
    "network-pon",
    "network-onu-models",
    "network-onu-templates",
  ]);
  for (const node of navigationPages.filter((node) => node.view)) {
    if (futureViews.has(node.view!)) {
      assert.equal(integrationStatus(node.href), "pending", node.href);
      continue;
    }
    assert.ok(hasRoute(canonicalErpPath(node.href)), node.href);
    assert.equal(integrationStatus(node.href), "connected", node.href);
  }
});

// Recursos do v0 sem suporte no Go; qualquer outro nó deve chegar a uma página real.
const planned = [
  "/rede/ftth/fttx-pon",
  "/rede/ftth/fttx-onu-tipo",
  "/rede/ftth/fttx-onu-template",
  "/rede/ftth/acs-template",
];
const session = (role: Session["role"], perms: string[]): Session => ({
  id: role,
  name: role,
  email: `${role}@example.invalid`,
  role,
  perms,
  modules: [
    "olt",
    "ipam",
    "field",
    "crm",
    "ftth",
    "noc",
    "notices",
    "messages",
    "api",
  ],
  tenant:
    role === "saas_operator" ? null : { id: "t", name: "Alfa", slug: "alfa" },
  support: false,
  demo: false,
  mfa_enabled: false,
  mfa_pending: false,
});
const admin = session("admin", [
  "users:manage",
  "subscribers:read",
  "subscribers:write",
  "plans:read",
  "plans:write",
  "contracts:read",
  "contracts:write",
  "network:read",
  "network:write",
  "network:operate",
  "finance:read",
  "finance:write",
  "audit:read",
  "import:run",
  "settings:manage",
  "os:read",
  "os:write",
  "stock:read",
  "stock:write",
  "crm:read",
  "crm:write",
  "trust:grant",
  "legal:query",
]);
const personas = [
  admin,
  session("subscriber", ["portal:self"]),
  session("saas_operator", ["tenants:manage"]),
];
// Reproduz a seleção do React Router: rota estática, parâmetro, curinga e fallback.
function matchRoute(path: string) {
  if (routes.includes(path)) return path;
  const segments = path.split("/");
  const dynamic = routes.find((route) => {
    const parts = route.split("/");
    return (
      route.includes(":") &&
      parts.length === segments.length &&
      parts.every(
        (part, index) => part.startsWith(":") || part === segments[index],
      )
    );
  });
  if (dynamic) return dynamic;
  return (
    routes.find(
      (route) =>
        route !== "*" &&
        route.endsWith("/*") &&
        (path === route.slice(0, -2) || path.startsWith(route.slice(0, -1))),
    ) ?? "*"
  );
}
type Outcome =
  | { kind: "page"; route: string; path: string }
  | { kind: "planned" | "not-found" | "record" };
function navigate(start: string): Outcome {
  let path = start;
  for (let step = 0; step < 5; step++) {
    if (erpAliases[path]) {
      path = erpAliases[path];
      continue;
    }
    let route = matchRoute(path);
    if (route.includes(":")) {
      if (isRecordId(path.split("/").at(-1)!)) return { kind: "record" };
      route = "*";
    }
    if (route !== "*") return { kind: "page", route, path };
    const resolution = resolveCatalogueNode(path);
    if (!resolution) return { kind: "not-found" };
    if (resolution.kind === "planned") return { kind: "planned" };
    const next = resolution.destination.split("?")[0];
    if (next === path) return { kind: "not-found" };
    path = next;
  }
  throw new Error(`${start}: redirecionamentos em ciclo`);
}
test("os 420 nós do catálogo chegam a uma página operacional ou constam da lista de planejados", () => {
  assert.equal(navigationPages.length, 420);
  let reached = 0;
  for (const node of navigationPages) {
    const persona = personas.find((me) => canAccessPath(me, node.href));
    if (!persona) continue;
    const outcome = navigate(node.href);
    if (planned.includes(node.href)) {
      assert.equal(outcome.kind, "planned", node.href);
      assert.equal(integrationStatus(node.href), "pending", node.href);
      continue;
    }
    assert.equal(
      outcome.kind,
      "page",
      `${node.href}: terminou em ${outcome.kind}`,
    );
    if (outcome.kind !== "page") continue;
    assert.ok(
      canAccessPath(persona, outcome.path),
      `${node.href}: destino ${outcome.path} negado`,
    );
    assert.equal(integrationStatus(node.href), "connected", node.href);
    reached++;
  }
  assert.ok(canAccessPath(admin, "/rede/ftth/fttx-pon"));
  assert.ok(reached >= 400, `apenas ${reached} nós alcançados`);
});
test("menu e busca operacionais mostram páginas e abas, não subações sem destino próprio", () => {
  const tree = [
    operationalBranch(findNavigationPage("/")!),
    ...operationalNavigationAreas().flatMap((area) => area.pages),
  ];
  const flatten = (nodes: typeof tree): typeof tree =>
    nodes.flatMap((node) => [node, ...flatten(node.children)]);
  const visible = flatten(tree).filter((node) =>
    personas.some((me) => canAccessPath(me, node.href)),
  );
  for (const node of visible) {
    assert.notEqual(
      resolveCatalogueNode(node.href)?.kind,
      "subaction",
      node.href,
    );
    const outcome = navigate(node.href);
    assert.ok(
      outcome.kind === "page" || planned.includes(node.href),
      node.href,
    );
  }
  const hrefs = new Set(visible.map((node) => node.href));
  for (const href of [
    "/planos/novo-plano",
    "/assinantes/novo-assinante",
    "/financeiro/faturas/gerar-mensalidades-por-competencia",
  ])
    assert.ok(!hrefs.has(href), href);
  for (const href of [
    "/administracao/integracoes/aba-webhooks",
    "/relatorios/cobranca/recebido",
    ...planned,
  ])
    assert.ok(hrefs.has(href), href);
  const network = operationalNavigationAreas().find(
    (area) => area.id === "rede",
  )!;
  for (const href of ["/noc", "/pops", "/rede/onus"]) {
    assert.ok(
      network.pages.some((page) => page.href === href),
      href,
    );
    assert.equal(navigate(href).kind, "page", href);
  }
  assert.ok(
    !searchOperationalNavigation("novo plano").some(
      (page) => page.href === "/planos/novo-plano",
    ),
  );
  assert.ok(
    searchOperationalNavigation("noc").some((page) => page.href === "/noc"),
  );
});
test("subações redirecionam à página que as atende e abas levam o parâmetro da aba", () => {
  assert.deepEqual(resolveCatalogueNode("/planos/novo-plano"), {
    kind: "subaction",
    destination: "/planos",
  });
  assert.deepEqual(
    resolveCatalogueNode("/administracao/catalogos-sla/aba-sla/nova-politica"),
    { kind: "subaction", destination: "/administracao/catalogos-sla?aba=sla" },
  );
  assert.equal(
    canonicalErpPath("/financeiro/contratos/criar-acordo-de-pagamento"),
    "/contratos",
  );
  assert.equal(
    canonicalErpPath(
      "/rede/enderecos-ip/rastrear-conexao-por-ip-publico-porta-e-instante",
    ),
    "/rede/consulta-ip",
  );
  assert.equal(
    canAccessPath(
      { ...admin, modules: [] },
      "/administracao/catalogos-sla/aba-sla",
    ),
    false,
  );
  assert.equal(
    canAccessPath(
      { ...admin, modules: [] },
      "/administracao/catalogos-sla/aba-campos-personalizados",
    ),
    true,
  );
});
test("fichas por URL aceitam apenas UUID; demais segmentos resolvem no catálogo ou não existem", () => {
  assert.equal(isRecordId("0b5f6a8e-2c1d-4e3f-9a7b-6c5d4e3f2a1b"), true);
  assert.equal(
    navigate("/assinantes/0b5f6a8e-2c1d-4e3f-9a7b-6c5d4e3f2a1b").kind,
    "record",
  );
  assert.equal(
    navigate("/contratos/0b5f6a8e-2c1d-4e3f-9a7b-6c5d4e3f2a1b").kind,
    "record",
  );
  for (const path of [
    "/assinantes/novo-assinante",
    "/assinantes/exportar-csv",
    "/contratos/abrir-contrato",
    "/contratos/exportar-csv",
  ]) {
    assert.equal(isRecordId(path.split("/").at(-1)!), false, path);
    assert.deepEqual(navigate(path), {
      kind: "page",
      route: path.split("/").slice(0, 2).join("/"),
      path: path.split("/").slice(0, 2).join("/"),
    });
  }
  assert.equal(navigate("/assinantes/inexistente").kind, "not-found");
  assert.equal(navigate("/contratos/123").kind, "not-found");
});
