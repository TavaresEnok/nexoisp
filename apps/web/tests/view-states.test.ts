import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fieldOrderViews, contractViews } from "../domain/view-states";
import { readQueryValue } from "../platform/navigation/query";

test("visualização de OS corresponde aos painéis reais board e agenda, nunca list", () => {
  const source = readFileSync("components/field-operations.tsx", "utf8");
  const panels = [...source.matchAll(/<TabsContent value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(panels, [...fieldOrderViews]);
  assert.equal(readQueryValue("agenda", "board", fieldOrderViews), "agenda");
  assert.equal(readQueryValue("list", "board", fieldOrderViews), "board");
  assert.equal(readQueryValue("invalida", "board", fieldOrderViews), "board");
});

test("contratos preservam alternância real por contrato ou titular", () => {
  assert.equal(readQueryValue("assinantes", "contratos", contractViews), "assinantes");
  assert.equal(readQueryValue("invalida", "contratos", contractViews), "contratos");
});
