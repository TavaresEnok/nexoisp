import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { navigationPages } from "../lib/navigation";

function parseFile(path: string) {
  const text = readFileSync(new URL(path, import.meta.url), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collect<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return result;
}

const registry = parseFile("../components/navigation-views.tsx");
const declaration = collect(registry, ts.isVariableDeclaration).find(node => node.name.getText(registry) === "navigationViews");
assert.ok(declaration?.initializer && ts.isSatisfiesExpression(declaration.initializer));
assert.equal(declaration.initializer.type.getText(registry), "Record<NavigationView, ReactElement>");
const object = declaration.initializer.expression;
assert.ok(ts.isObjectLiteralExpression(object));
const entries = new Map(object.properties.map(property => {
  assert.ok(ts.isPropertyAssignment(property));
  const key = ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(registry);
  return [key, property.initializer] as const;
}));

const expected = {
  overview: ["Overview", null, true, "overview"],
  subscribers: ["Subscribers", null, true, "subscribers"],
  plans: ["Plans", null, true, "plans"],
  contracts: ["Contracts", null, true, "contracts"],
  financial: ["Financial", null, true, "financial"],
  support: ["Support", null, true, "support"],
  field: ["FieldOperations", null, true, "field-operations"],
  network: ["NetworkCenter", null, true, "network-center"],
  "network-online": ["NetworkExplorer", "online", true, "network-explorer"],
  "network-map": ["NetworkExplorer", "map", true, "network-explorer"],
  "network-olt": ["OpticalNetwork", "olt", true, "optical-network"],
  "network-pon": ["OpticalNetwork", "pon", true, "optical-network"],
  "network-cto": ["OpticalNetwork", "cto", true, "optical-network"],
  "network-ip": ["IpTraceability", null, true, "ip-traceability"],
  "network-onu-models": ["TechnicalWorkspace", "models", false, "technical-workspace"],
  "network-onu-templates": ["TechnicalWorkspace", "templates", false, "technical-workspace"],
  "network-pools": ["TechnicalWorkspace", "pools", false, "technical-workspace"],
  "network-nas": ["TechnicalWorkspace", "nas", false, "technical-workspace"],
  "network-cgnat": ["TechnicalWorkspace", "cgnat", false, "technical-workspace"],
  settings: ["Settings", null, true, "management"],
} as const;

test("registro cobre todas as views com componente, modo, import e fronteira originais (análise estrutural, não renderização)", () => {
  assert.deepEqual([...entries.keys()].sort(), Object.keys(expected).sort());
  const imports = new Map(collect(registry, ts.isImportDeclaration).flatMap(node => {
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || !ts.isStringLiteral(node.moduleSpecifier)) return [];
    const source = node.moduleSpecifier.text;
    return bindings.elements.map(element => [element.name.text, source] as const);
  }));
  for (const [view, [component, mode, requiresWorkspace, filename]] of Object.entries(expected)) {
    const expression = entries.get(view)!;
    const elements = collect(expression, (node): node is ts.JsxOpeningElement | ts.JsxSelfClosingElement => ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node));
    assert.deepEqual(elements.map(node => node.tagName.getText(registry)), requiresWorkspace ? ["WorkspaceDataBoundary", component] : [component], view);
    const leaf = elements.at(-1)!;
    const actualMode = leaf.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(registry) === "mode");
    if (mode) {
      assert.ok(actualMode && ts.isJsxAttribute(actualMode) && actualMode.initializer && ts.isStringLiteral(actualMode.initializer), view);
      assert.equal(actualMode.initializer.text, mode, view);
    } else {
      assert.equal(actualMode, undefined, view);
    }
    assert.equal(imports.get(component), `@/components/${filename}`, view);
  }
  const assigned = navigationPages.filter(node => node.view);
  assert.equal(assigned.length, 20);
  for (const node of assigned) assert.ok(entries.has(node.view!), node.href);
});

test("início e catch-all usam o mesmo registro, preservando escopos, busca, limites e 404", () => {
  for (const path of ["../src/route-content.tsx"]) {
    const ast = parseFile(path);
    assert.ok(collect(ast, ts.isCallExpression).some(node => node.expression.getText(ast) === "resolveNavigationRoute"), path);
    const view = collect(ast, ts.isJsxSelfClosingElement).find(node => node.tagName.getText(ast) === "NavigationViewContent" && node.attributes.getText(ast).includes("view={route.view}"));
    assert.ok(view, path);
  }
  const ast = parseFile("../src/route-content.tsx");
  const cases = collect(ast, ts.isCaseClause);
  assert.ok(cases.some(node => node.expression.getText(ast) === '"scope"' && node.getText(ast).includes("<NavigationScope node={route.node} />")));
  assert.ok(cases.some(node => node.expression.getText(ast) === '"not-found"' && node.getText(ast).includes("<NotFound />")));
  assert.ok(cases.some(node => node.expression.getText(ast) === '"assistant"' && node.getText(ast).includes("<DemoAssistant />")));
  assert.ok(cases.some(node => node.expression.getText(ast) === '"directory"' && node.getText(ast).includes('query.get("q") ?? ""')));
  assert.ok(cases.some(node => node.expression.getText(ast) === '"reports"' && node.getText(ast).includes("<WorkspaceDataBoundary><Reports /></WorkspaceDataBoundary>")));
});
