import test from "node:test";
import assert from "node:assert/strict";
import { navigationRequirements } from "../lib/navigation-requirements";
import { parseRequirements, navigationAreas, navigationModules, navigationPages, findNavigationPage, isNavigationCurrent, searchNavigation } from "../lib/navigation";

test("navegação preserva todos os módulos e descendentes dos requisitos", () => {
  const roots = parseRequirements(navigationRequirements);
  function count(nodes: { children: unknown[] }[]): number {
    return nodes.reduce((total, node) => total + 1 + count(node.children as { children: unknown[] }[]), 0);
  }
  assert.equal(navigationModules.length, roots.flatMap(root => root.children).length);
  assert.equal(navigationPages.length, count(roots.flatMap(root => root.children)));
  assert.equal(new Set(navigationPages.map(page => page.href)).size, navigationPages.length);
  for (const page of navigationPages) {
    assert.equal(findNavigationPage(page.href), page);
    assert.equal(findNavigationPage(`${page.href === "/" ? "" : page.href}/`), page);
    assert.ok(page.trail.length >= 2);
    assert.ok(page.href.startsWith("/"));
    assert.ok(!page.href.includes("//"));
    if (page.parentHref) assert.ok(findNavigationPage(page.parentHref)?.children.includes(page));
  }
});
test("todas as áreas possuem destino e o menu cobre cada módulo", () => {
  assert.equal(navigationAreas.length, 9);
  const sidebarModules = navigationAreas.flatMap(area => area.pages);
  for (const page of navigationModules) {
    assert.ok(page.area === "INÍCIO" || sidebarModules.includes(page));
  }
});
test("rotas antigas preservam a consulta sem confundir operações de campo e rede", () => {
  assert.equal(findNavigationPage("/operacoes")?.href, "/ordens-de-servico");
  assert.equal(findNavigationPage("/financeiro")?.href, "/financeiro/faturas");
  assert.equal(findNavigationPage("/rede")?.href, "/rede/online");
  assert.equal(findNavigationPage("/rede/operacoes")?.view, undefined);
  assert.ok(isNavigationCurrent(findNavigationPage("/ordens-de-servico")!, "/operacoes"));
  assert.equal(findNavigationPage("/rota-inexistente"), undefined);
});
test("rede óptica e relatórios seguem a nova estrutura sem menus removidos", () => {
  const network = navigationAreas.find(area => area.id === "rede")!;
  assert.ok(network.pages.every(page => !["NOC", "POPs", "ONUs", "Mapa"].includes(page.label)));
  assert.deepEqual(findNavigationPage("/rede/ftth")?.children.map(page => page.label), [
    "FTTx - OLT", "FTTx - PON", "FTTx - CTO", "FTTx - ONU Tipo", "FTTx - ONU Template", "ACS - Template",
  ]);
  const report = navigationAreas.find(area => area.id === "relatorio")!;
  assert.equal(report.label, "Relatório");
  assert.deepEqual(report.pages.map(page => page.label), ["Mapa", "Consultar ONU", "Online agora", "Consulta de IP"]);
  for (const href of ["/rede/online", "/rede/consulta-ip"]) {
    assert.ok(report.pages.includes(findNavigationPage(href)!));
    assert.ok(network.pages.every(page => page.href !== href));
    assert.equal(findNavigationPage(href)?.area, "RELATÓRIO");
  }
  assert.equal(findNavigationPage("/rede/consulta-ip")?.view, "network-ip");
  assert.equal(findNavigationPage("/rede/mapa")?.view, "network-map");
  assert.equal(findNavigationPage("/rede/mapa")?.children.length, 0);
  for (const route of ["/rede/noc", "/rede/pops", "/rede/onus"]) assert.equal(findNavigationPage(route), undefined);
  for (const label of ["Aguardando autorização", "Autorizar por serial", "ONUs vinculadas a contratos", "Posicionar/mover contratos e POPs", "Abrir detalhes dos elementos", "Consultar cobertura", "Buscar/localizar", "Camadas de contratos, caixas e POPs"]) {
    assert.ok(navigationPages.every(page => page.label !== label));
  }
});

test("áreas seguem ordem solicitada e preservam rotas de consulta", () => {
  assert.deepEqual(navigationAreas.slice(0, 5).map(area => area.label), ["Assinantes", "Relatório", "Financeiro", "Rede / FTTx", "Atendimento"]);
  assert.equal(findNavigationPage("/assinantes")?.label, "Consultar");
  assert.deepEqual(findNavigationPage("/assinantes")?.trail.slice(0, 2), ["ASSINANTES", "Consultar"]);
  for (const mode of ["olt", "pon", "cto"]) assert.equal(findNavigationPage(`/rede/ftth/fttx-${mode}`)?.view, `network-${mode}`);
  assert.ok(searchNavigation("relatorio online").some(page => page.href === "/rede/online"));
  assert.ok(searchNavigation("relatorio consulta ip").some(page => page.href === "/rede/consulta-ip"));
});

test("busca encontra caminhos profundos e múltiplas palavras sem acentos", () => {
  const results = searchNavigation("contratos onu sinal");
  assert.ok(results.length > 0);
  assert.ok(results.every(page => page.trail.join(" ").includes("ONU")));
  assert.ok(searchNavigation("autenticacao duas etapas").length > 0);
  assert.ok(searchNavigation("Wi Fi").some(page => page.area.startsWith("PORTAL")));
  assert.equal(searchNavigation("").length, navigationPages.length);
  assert.equal(searchNavigation("zzzinexistentezzz").length, 0);
});
test("módulos pendentes e escopos isolados não recebem uma consulta funcional fictícia", () => {
  for (const page of navigationPages) {
    if (page.parentHref && !["network-olt", "network-pon", "network-cto", "network-onu-models", "network-onu-templates", "network-pools", "network-cgnat", "network-nas"].includes(page.view ?? "") || page.audience !== "Equipe") assert.equal(page.view, undefined);
  }
  assert.equal(findNavigationPage("/assinantes")?.view, "subscribers");
  assert.equal(findNavigationPage("/")?.view, "overview");
  assert.equal(findNavigationPage("/login")?.view, undefined);
  assert.equal(findNavigationPage("/portal")?.view, undefined);
  assert.equal(findNavigationPage("/provedores")?.view, undefined);
});
