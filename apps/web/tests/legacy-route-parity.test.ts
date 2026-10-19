import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import {
  canonicalErpPath,
  erpAliases,
} from "../features/operations/navigation";
import { integrationStatus } from "../features/operations/status";
import { navigationPages } from "../lib/navigation";

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
const routes = declaredRoutes("features/operations/application.tsx");
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
