import test from "node:test";
import assert from "node:assert/strict";
import { navigationAliases, navigationPages, findNavigationPage, isNavigationCurrent, resolveNavigationPathname } from "../lib/navigation";
import { resolveNavigationRoute } from "../lib/navigation-route";

const expectedViews = new Map([
  ["/", "overview"],
  ["/assinantes", "subscribers"],
  ["/contratos", "contracts"],
  ["/planos", "plans"],
  ["/atendimentos", "support"],
  ["/ordens-de-servico", "field"],
  ["/financeiro/faturas", "financial"],
  ["/rede/equipamentos", "network"],
  ["/rede/equipamentos/concentradores", "network-nas"],
  ["/rede/ftth/fttx-olt", "network-olt"],
  ["/rede/ftth/fttx-pon", "network-pon"],
  ["/rede/ftth/fttx-cto", "network-cto"],
  ["/rede/ftth/fttx-onu-tipo", "network-onu-models"],
  ["/rede/ftth/fttx-onu-template", "network-onu-templates"],
  ["/rede/enderecos-ip", "network-pools"],
  ["/rede/enderecos-ip/blocos-de-enderecos", "network-pools"],
  ["/rede/enderecos-ip/planos-de-cgnat", "network-cgnat"],
  ["/rede/online", "network-online"],
  ["/rede/consulta-ip", "network-ip"],
  ["/rede/mapa", "network-map"],
]);

test("os 420 destinos preservam classificação, identidade, trilha e resolução com barra final", () => {
  assert.equal(navigationPages.length, 420);
  assert.equal(navigationPages.filter(node => node.view).length, 20);
  assert.equal(navigationPages.filter(node => !node.view).length, 400);
  const counts = { view: 0, scope: 0, special: 0 };
  for (const node of navigationPages) {
    const route = resolveNavigationRoute(node.href);
    assert.notEqual(route.kind, "not-found", node.href);
    assert.ok("node" in route);
    assert.equal(route.node, node);
    assert.equal(route.pathname, node.href);
    assert.equal(route.title, node.label);
    assert.deepEqual(resolveNavigationRoute(node.href === "/" ? "/" : `${node.href}/`), route);
    if (route.kind === "view") {
      counts.view++;
      assert.equal(route.view, expectedViews.get(node.href), node.href);
      assert.match(route.description!, /Consulta parcial/);
    } else if (route.kind === "scope") {
      counts.scope++;
      assert.equal(expectedViews.has(node.href), false);
      assert.match(route.description!, /implementação funcional pendente/);
    } else if (route.kind === "special") {
      counts.special++;
      assert.equal(node.href, "/busca");
      assert.equal(route.entry, "directory");
      assert.equal(route.description, undefined);
    }
  }
  assert.deepEqual(counts, { view: 20, scope: 399, special: 1 });
  for (const [href, view] of expectedViews) {
    const route = resolveNavigationRoute(href);
    assert.equal(route.kind, "view", href);
    assert.ok(route.kind === "view");
    assert.equal(route.view, view);
  }
});

test("aliases com e sem barra final mantêm consulta, menu ativo e trilha canônica", () => {
  assert.deepEqual([...navigationAliases], [["/operacoes", "/ordens-de-servico"], ["/rede", "/rede/online"], ["/financeiro", "/financeiro/faturas"]]);
  for (const [alias, canonical] of navigationAliases) {
    const node = findNavigationPage(canonical)!;
    for (const path of [alias, `${alias}/`]) {
      assert.equal(resolveNavigationPathname(path), canonical);
      assert.equal(findNavigationPage(path), node);
      assert.equal(isNavigationCurrent(node, path), true);
      assert.deepEqual(resolveNavigationRoute(path), resolveNavigationRoute(canonical));
    }
  }
});

test("páginas especiais mantêm entradas específicas, sem promover escopos", () => {
  const entries = [
    ["/estrutura", "directory", "Mapa de páginas"],
    ["/busca", "directory", "Busca global"],
    ["/relatorios", "reports", "Relatórios"],
    ["/configuracoes", "settings", "Configurações"],
    ["/acompanhamento", "consolidation", "Consolidação e evidências"],
  ];
  for (const [path, entry, title] of entries) {
    const route = resolveNavigationRoute(path);
    assert.ok(route.kind === "special");
    assert.equal(route.entry, entry);
    assert.equal(route.title, title);
    assert.deepEqual(resolveNavigationRoute(`${path}/`), route);
  }
  for (const path of ["/login", "/conta", "/portal", "/provedores", "/relatorios/atendimento", "/financeiro/conciliacao"]) {
    assert.equal(resolveNavigationRoute(path).kind, "scope", path);
  }
});

test("rotas do assistente continuam reservadas às entradas com sessão, sem carregar auth ou agente", () => {
  for (const path of ["/assistente", "/s", "/s/sessao-de-teste"]) {
    const route = resolveNavigationRoute(path);
    assert.ok(route.kind === "special" && route.entry === "assistant");
    assert.equal(route.requiresSession, true);
    assert.equal(route.title, "Assistente");
    assert.equal(route.sessionId, path.startsWith("/s/") ? "sessao-de-teste" : undefined);
    assert.deepEqual(resolveNavigationRoute(`${path}/`), route);
  }
});

test("caminhos desconhecidos e propriedades herdadas não viram rotas nem títulos de módulos", () => {
  for (const path of ["/inexistente", "/assinantes/inexistente", "/estrutura/inexistente", "/configuracoes/inexistente", "/relatorios/inexistente", "/assistente/inexistente", "/s/uma/duas", "/rede//online", "constructor", "toString", "__proto__"]) {
    const route = resolveNavigationRoute(path);
    assert.equal(route.kind, "not-found", path);
    assert.equal(route.title, "Página não encontrada");
    assert.equal(findNavigationPage(path), undefined);
  }
});
