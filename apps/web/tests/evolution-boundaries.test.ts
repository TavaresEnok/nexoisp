import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []);
}
function specifiers(file: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) values.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) values.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return values;
}

test("domínio canônico não volta a depender das fachadas lib nem da plataforma", () => {
  for (const file of files("domain")) {
    for (const source of specifiers(file)) assert.doesNotMatch(source, /(?:^@\/|\.\.\/)(?:lib|components|features|platform|app)(?:\/|$)|^(?:react|next|node:|server-only|pg$|drizzle-orm)/, `${file}: ${source}`);
  }
});

test("hooks de query e contexto de navegação não acessam globais de navegador", () => {
  for (const file of ["lib/use-query-state.ts", "lib/use-network-filters.ts", "platform/navigation/react.tsx"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /\b(?:window|document|history|location)\./, file);
  }
});

test("catálogo visual é síncrono, recebe dados e não seleciona uma fonte", () => {
  const file = "features/technical/catalog-view.tsx";
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, /\basync\b|\bfetch\s*\(|demoReaders|execution-mode|technical-catalog-server/);
  assert.match(source, /catalog: TechnicalCatalog/);
  for (const source of specifiers(file)) assert.doesNotMatch(source, /next|\/data\/|\/db\/|server-only/);
  assert.match(readFileSync("components/technical-workspace.tsx", "utf8"), /<TechnicalCatalogView catalog=\{catalog\} mode=\{mode\}/);
});

test("as sementes continuam com uma única origem física e leitores não fazem requisições", () => {
  const readers = readFileSync("data/demo/readers.ts", "utf8");
  assert.match(readers, /lib\/db\/demo-seed\.json/);
  assert.match(readers, /lib\/db\/technical-catalog-seed\.json/);
  assert.doesNotMatch(readers, /\bfetch\s*\(|localStorage|process\.env/);
});
