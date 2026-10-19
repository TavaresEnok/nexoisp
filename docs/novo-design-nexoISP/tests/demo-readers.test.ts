import test from "node:test";
import assert from "node:assert/strict";
import { createDemoReaders, demoReaders, readScenarioMetadata } from "../data/demo/readers";
import { parseExecutionMode } from "../application/execution-mode";
import seed from "../lib/db/demo-seed.json";
import technical from "../lib/db/technical-catalog-seed.json";

test("leitores locais validam os 82 registros e os 20 itens sem alterar sementes", async () => {
  const before = JSON.stringify([seed, technical]);
  const data = await demoReaders.readWorkspace();
  const catalog = await demoReaders.readTechnicalCatalog();
  assert.equal(seed.records.length, 82);
  assert.deepEqual([data.subscribers.length, data.invoices.length, data.tickets.length, data.orders.length, data.nodes.length, data.activities.length], [24, 24, 12, 8, 8, 5]);
  assert.equal(catalog.models.length + catalog.templates.length + catalog.pools.length + catalog.nas.length + catalog.cgnat.length + catalog.vpns.length + catalog.pops.length, 20);
  data.subscribers[0].name = "não deve persistir";
  catalog.models[0].description = "não deve persistir";
  assert.notEqual((await demoReaders.readWorkspace()).subscribers[0].name, "não deve persistir");
  assert.notEqual((await demoReaders.readTechnicalCatalog()).models[0].description, "não deve persistir");
  assert.equal(JSON.stringify([seed, technical]), before);
});

test("cenário inválido falha explicitamente e leitor corrigido recupera sem fallback remoto", async () => {
  const sources = { records: [] as typeof seed.records, technical: {} as unknown };
  const readers = createDemoReaders(sources);
  await assert.rejects(readers.readWorkspace, /snapshot/);
  await assert.rejects(readers.readTechnicalCatalog);
  sources.records = seed.records;
  sources.technical = technical.payload;
  assert.equal((await readers.readWorkspace()).subscribers.length, 24);
  assert.equal((await readers.readTechnicalCatalog()).models.length, 5);
});

test("modo não depende de credenciais e seleção desconhecida não muda silenciosamente", () => {
  assert.equal(parseExecutionMode("demo"), "demo");
  assert.equal(parseExecutionMode("original"), "original");
  assert.throws(() => parseExecutionMode("fallback"));
});

test("metadados distinguem panorama, amostra, seleção e unidade monetária", async () => {
  const meta = await readScenarioMetadata();
  const data = await demoReaders.readWorkspace();
  assert.equal(meta.asOf, data.snapshot.asOf);
  assert.equal(meta.monetaryUnit, "reais");
  assert.notEqual(data.snapshot.active, data.subscribers.length);
  assert.equal(new Set(Object.values(meta.slices)).size, 3);
});
