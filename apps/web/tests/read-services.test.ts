import test from "node:test";
import assert from "node:assert/strict";
import { createReadServices } from "../application/read-services";
import { demoReaders } from "../data/demo/readers";
import { parseWorkspaceRecords } from "../domain/workspace-schema";
import { workspaceDataSchema as legacySchema } from "../lib/workspace-schema";
import { workspaceDataSchema } from "../domain/workspace-schema";
import { technicalCatalogSchema as legacyTechnical } from "../lib/technical-catalog";
import { technicalCatalogSchema } from "../domain/technical-catalog";
import seed from "../lib/db/demo-seed.json";

test("serviços aceitam fontes injetadas e devolvem leituras validadas independentes", async () => {
  const workspace = await demoReaders.readWorkspace();
  const catalog = await demoReaders.readTechnicalCatalog();
  let workspaceCalls = 0;
  let technicalCalls = 0;
  const services = createReadServices({
    readWorkspace: async () => { workspaceCalls++; return workspace; },
    readTechnicalCatalog: async () => { technicalCalls++; return catalog; },
  });
  assert.equal(Object.isFrozen(services), true);
  const first = await services.readWorkspace();
  first.subscribers[0].name = "alteração descartável";
  assert.notEqual((await services.readWorkspace()).subscribers[0].name, first.subscribers[0].name);
  assert.equal(workspaceCalls, 2);
  assert.equal(technicalCalls, 0);
  const technical = await services.readTechnicalCatalog();
  technical.models[0].description = "alteração descartável";
  assert.notEqual((await services.readTechnicalCatalog()).models[0].description, technical.models[0].description);
  assert.equal(technicalCalls, 2);
});

test("falhas da fonte e corrupção não acionam fallback nem retornam sucesso", async () => {
  const failure = new Error("falha controlada da fonte");
  const services = createReadServices({ readWorkspace: async () => { throw failure; }, readTechnicalCatalog: demoReaders.readTechnicalCatalog });
  await assert.rejects(services.readWorkspace, error => error === failure);
  const workspace = await demoReaders.readWorkspace();
  workspace.subscribers[0].price = -1;
  const corrupt = createReadServices({ readWorkspace: async () => workspace, readTechnicalCatalog: demoReaders.readTechnicalCatalog });
  await assert.rejects(corrupt.readWorkspace);
  workspace.subscribers[0].price = 149.9;
  assert.equal((await corrupt.readWorkspace()).subscribers[0].price, 149.9);
});

test("envelopes recusam tipos desconhecidos, IDs divergentes e duplicados entre entidades", () => {
  const subscriber = seed.records.find(row => row.kind === "subscriber")!;
  assert.throws(() => parseWorkspaceRecords([...seed.records, { id: "x", kind: "future-entity", payload: {} }]), /Tipo de registro desconhecido/);
  assert.throws(() => parseWorkspaceRecords(seed.records.map(row => row === subscriber ? { ...row, payload: { ...row.payload, id: "outro" } } : row)), /Identificador divergente/);
  assert.throws(() => parseWorkspaceRecords([...seed.records, { id: subscriber.id, kind: "invoice", payload: {} }]), /Identificadores duplicados/);
  assert.equal(parseWorkspaceRecords(seed.records).subscribers.length, 24);
});

test("exports legados apontam para os mesmos schemas, não cópias divergentes", () => {
  assert.equal(legacySchema, workspaceDataSchema);
  assert.equal(legacyTechnical, technicalCatalogSchema);
});
