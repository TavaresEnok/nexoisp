import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { cents, money } from "../features/shared/schema";
import { exportCoverage } from "../platform/erp-client";

test("valores monetários rejeitam ausência em vez de virar zero", () => {
  assert.equal(cents().parse(1990), 1990);
  assert.equal(cents().parse("1990"), 1990);
  assert.equal(money().parse("2.50"), 2.5);
  for (const value of [null, undefined, "", "abc", "1e3", 1.5]) assert.equal(cents().safeParse(value).success, false, String(value));
  assert.equal(cents().nullable().parse(null), null);
});

test("exportação informa quando o servidor cortou no limite", () => {
  assert.deepEqual(exportCoverage("/invoices?status=open&format=csv&limit=5000", 7200), { total: 7200, limit: 5000, truncated: true });
  assert.equal(exportCoverage("/invoices?format=csv&limit=5000", 5000).truncated, false);
  assert.equal(exportCoverage("/invoices?format=csv&limit=5000", null).truncated, false);
  assert.equal(exportCoverage("/invoices?format=csv", 9000).truncated, false);
});

test("navegação interna usa o roteador em vez de recarregar a aplicação", () => {
  const offenders: string[] = [];
  for (const name of readdirSync("features", { recursive: true }).map(String)) {
    if (!name.endsWith(".tsx")) continue;
    const source = readFileSync(path.join("features", name), "utf8");
    for (const match of source.matchAll(/<a\b[^>]*\bhref=(?:"\/(?!demonstracao\/|api\/)|\{`\/)/g)) offenders.push(`${name}: ${match[0].slice(0, 60)}`);
  }
  assert.deepEqual(offenders, []);
});
