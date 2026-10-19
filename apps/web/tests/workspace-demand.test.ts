import test from "node:test";
import assert from "node:assert/strict";
import { needsWorkspaceData, viewDataRequirements } from "../application/workspace-demand";
import { navigationAliases, navigationPages } from "../lib/navigation";

test("todos os destinos têm demanda coerente sem consultar dados em escopos", () => {
  for (const node of navigationPages) {
    const expected = node.view ? viewDataRequirements[node.view] === "workspace" : false;
    assert.equal(needsWorkspaceData(node.href, false, null), expected, node.href);
    assert.equal(needsWorkspaceData(`${node.href === "/" ? "" : node.href}/`, false, null), expected, node.href);
  }
});

test("aliases, especiais e ficha usam a mesma política que o resolvedor", () => {
  for (const [alias, canonical] of navigationAliases) {
    assert.equal(needsWorkspaceData(alias, false, null), needsWorkspaceData(canonical, false, null));
  }
  for (const path of ["/relatorios", "/relatorios/", "/configuracoes", "/configuracoes/"]) assert.equal(needsWorkspaceData(path, false, null), true, path);
  for (const path of ["/estrutura", "/busca", "/acompanhamento", "/assistente", "/s/demo", "/inexistente", "/rede/enderecos-ip"]) {
    assert.equal(needsWorkspaceData(path, false, null), false, path);
    assert.equal(needsWorkspaceData(path, true, null), true, path);
    assert.equal(needsWorkspaceData(path, false, "sub-1"), true, path);
  }
});
