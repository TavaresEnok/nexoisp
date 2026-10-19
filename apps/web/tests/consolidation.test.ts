import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { features, originIds, filterFeatures, standaloneRoutes } from "../lib/consolidation/features";
import { findNavigationPage } from "../lib/navigation";
import sources from "../lib/consolidation/sources.json";

const resolvesToView = (route: string) => (standaloneRoutes as readonly string[]).includes(route) || (findNavigationPage(route)?.href === route && Boolean(findNavigationPage(route)?.view));
test("inventário preserva os 49 escopos da primeira consolidação sem contar menus como conclusão", () => {
  assert.equal(features.length, 49);
  assert.equal(new Set(features.map(feature => feature.id)).size, 49);
  assert.ok(features.every(feature => ["Consulta parcial", "Núcleo preparado", "Pendente"].includes(feature.stage)));
});
test("manifesto identifica as nove origens, 418 arquivos e hashes verificáveis", () => {
  assert.deepEqual(sources.projects.map(project => project.id), [...originIds]);
  assert.equal(sources.totalFiles, 418);
  assert.equal(sources.projects.reduce((sum, project) => sum + project.fileCount, 0) + sources.additionalFiles.length, sources.totalFiles);
  assert.equal(sources.additionalFiles.length, 6);
  assert.match(sources.archiveSha256, /^[a-f0-9]{64}$/);
  for (const source of sources.projects) {
    assert.match(source.treeSha256, /^[a-f0-9]{64}$/);
    assert.ok(source.evidence.length > 0);
    for (const file of source.evidence) assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
});
test("capacidade só referencia origem conhecida e tela realmente existente", () => {
  for (const feature of features) {
    assert.ok(feature.origins.length > 0);
    assert.ok(feature.origins.every(origin => originIds.includes(origin as typeof originIds[number])));
    assert.ok(feature.route === null || resolvesToView(feature.route), `${feature.id}: ${feature.route} não é uma rota canônica com tela`);
    assert.ok(feature.remaining.length > 20);
  }
});
test("evidências de implementação e de testes apontam para arquivos entregues", async () => {
  const paths = [...new Set(features.flatMap(feature => [...feature.implementation, ...feature.tests]))];
  await Promise.all(paths.map(path => access(new URL(`../${path}`, import.meta.url))));
  for (const feature of features.filter(feature => feature.stage === "Núcleo preparado")) assert.ok(feature.tests.length > 0);
});
test("atalhos de rede não dependem do apelido /rede, que abre Online agora", async () => {
  const files = ["components/overview.tsx", "components/overview-area-panels.tsx", "components/app-shell.tsx", "components/management.tsx", "components/subscriber-technical-panels.tsx", "lib/overview.ts"];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /["'`]\/rede(?:\?|["'`])/, `${file} aponta para o apelido /rede`);
  }
});
test("matriz acompanha os componentes realmente renderizados em planos, contratos e sessões", async () => {
  const page = await readFile(new URL("../src/route-content.tsx", import.meta.url), "utf8");
  assert.match(page, /import \{ NavigationViewContent \} from "@\/components\/navigation-views"/);
  assert.match(page, /<NavigationViewContent view=\{route.view\}/);
  const route = await readFile(new URL("../components/navigation-views.tsx", import.meta.url), "utf8");
  for (const id of ["C03", "C04", "F09"]) {
    const feature = features.find(feature => feature.id === id)!;
    const view = findNavigationPage(feature.route!)?.view;
    assert.ok(view);
    const component = route.match(new RegExp(`["']?${view}["']?:\\s*(?:<WorkspaceDataBoundary>)?<(\\w+)`))?.[1];
    assert.ok(component, `${id}: view não renderizada na rota ativa`);
    const imported = route.match(new RegExp(`import \\{ ${component} \\} from [\"']@/([^\"']+)[\"']`))?.[1];
    assert.ok(imported);
    assert.ok(feature.implementation.includes(`${imported}.tsx`), `${id}: evidência não corresponde à implementação ativa`);
  }
  const explorer = await readFile(new URL("../components/network-explorer.tsx", import.meta.url), "utf8");
  assert.match(explorer, /mode === "online" \? <NetworkOnline/);
  assert.ok(features.find(feature => feature.id === "F09")!.implementation.includes("components/network-online.tsx"));
});
test("conclusão exige quatro evidências e preserva decisões de navegação", () => {
  for (const feature of features) {
    assert.deepEqual(Object.keys(feature.acceptance).sort(), ["authorizedPersistence", "businessRules", "endToEnd", "interface"]);
    assert.equal(feature.acceptance.interface, Boolean(feature.route));
    assert.ok(feature.decision.length > 30);
    assert.equal(Object.values(feature.acceptance).every(Boolean), false);
    if (feature.route && feature.route !== feature.originalRoute) assert.equal(feature.disposition, "Adaptado");
  }
});
test("filtros combinam etapa, identificador, origem e busca sem acentos", () => {
  assert.ok(filterFeatures("operacoes de rede", "Todos").some(feature => feature.id === "F07"));
  assert.ok(filterFeatures("8022", "Pendente").every(feature => feature.stage === "Pendente" && feature.origins.includes("8022")));
  assert.deepEqual(filterFeatures("C01", "Todos").map(feature => feature.id), ["C01"]);
  assert.equal(filterFeatures("nenhum-resultado-possível", "Todos").length, 0);
});
