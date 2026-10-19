import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace, executeCommand } from "../lib/operations/domain";
import { workspaceStateSchema } from "../lib/operations/schema";
import { getCommercialData, contractMonthlyTotal, planUsage } from "../lib/commercial";
import { findNavigationPage } from "../lib/navigation";
import type { Subscriber } from "../lib/types";

let sequence = 0;
const run = (state: ReturnType<typeof createWorkspace>, command: unknown) => executeCommand(state, command, { actorId: "test-operator", createId: () => `commercial-${++sequence}` });
function registered() {
  const state = run(createWorkspace("2026-10-17T12:00:00.000Z"), { type: "plan.create", input: { name: "Fibra 400", speed: 400, price: 11990 } });
  return run(state, { type: "subscriber.create", input: { name: "Enok demonstrativo", document: "DEMO-ENOK", email: "enok@example.com", phone: "0000000000", address: "Rua do titular, 100", neighborhood: "Centro", pop: "POP Centro", planId: state.plans[0].id, dueDay: 10 } });
}
const fixture: Subscriber = { id: "s1", code: "001", name: "Enok demonstrativo", email: "enok@example.com", phone: "0000000000", document: "DEMO-ENOK", plan: "Fibra 400", speed: 400, price: 119.9, status: "Ativo", connection: "Online", neighborhood: "Centro", address: "Rua do titular, 100", pop: "POP Centro", signal: -20, since: "2026-10-01", dueDay: 10, contract: "C001", onu: "", nas: "" };

test("planos e contratos usam views independentes", () => {
  assert.equal(findNavigationPage("/planos")?.view, "plans");
  assert.equal(findNavigationPage("/contratos")?.view, "contracts");
});
test("catálogo legado não inventa preço, upload ou disponibilidade", () => {
  const data = getCommercialData({ subscribers: [fixture] });
  assert.equal(data.plans[0].upload, null);
  assert.equal(data.plans[0].price, null);
  assert.equal(data.plans[0].active, null);
  assert.equal(data.contracts[0].price, fixture.price);
  assert.equal(data.contracts[0].address, fixture.address);
  assert.deepEqual(getCommercialData({ subscribers: [fixture], commercialPlans: [], contracts: [] }), { plans: [], contracts: [] });
});
test("leitura aceita dois contratos de um titular e adicionais sem duplicá-lo", () => {
  const data = getCommercialData({ subscribers: [fixture] });
  const second = { ...data.contracts[0], id: "second", code: "C002", label: "Casa da mãe", address: "Rua da mãe, 200", price: 50, additionalServices: [{ id: "tv", name: "IPTV", serviceType: "IPTV" as const, price: 20 }] };
  const contracts = [...data.contracts, second];
  assert.equal(contractMonthlyTotal(second), 70);
  assert.equal(planUsage(data.plans[0].id, contracts).subscribers, 1);
  assert.equal(planUsage(data.plans[0].id, contracts).contracts.length, 2);
  assert.equal(planUsage(data.plans[0].id, contracts).recurring, 189.9);
});
test("contratação adicional mantém titular, contratos antigos e endereço independente", () => {
  const state = registered();
  const input = { subscriberId: state.subscribers[0].id, planId: state.plans[0].id, dueDay: 20, label: "Casa da mãe", address: "Rua da mãe, 200", neighborhood: "Centro", pop: "POP Norte" };
  const next = run(state, { type: "contract.create", input });
  assert.equal(next.subscribers.length, 1);
  assert.equal(next.contracts.length, 2);
  assert.deepEqual(next.contracts[0], state.contracts[0]);
  assert.equal(next.contracts[1].address, input.address);
  assert.equal(next.invoices[1].contractId, next.contracts[1].id);
  assert.equal(next.invoices[1].due, "2026-10-20");
  assert.equal(next.operations[1].contractId, next.contracts[1].id);
  assert.deepEqual(workspaceStateSchema.parse(JSON.parse(JSON.stringify(next))), next);
  assert.throws(() => run(state, { type: "contract.create", input: { ...input, subscriberId: "outro-workspace" } }), /não encontrado/);
  assert.throws(() => run(state, { type: "contract.create", input: { ...input, price: 1 } }));
  assert.equal(state.contracts.length, 1);
});
test("IPTV tem contrato próprio sem velocidade de internet fictícia", () => {
  let state = registered();
  state = run(state, { type: "plan.create", input: { name: "IPTV Família", serviceType: "IPTV", speed: 0, price: 2990 } });
  const next = run(state, { type: "contract.create", input: { subscriberId: state.subscribers[0].id, planId: state.plans[1].id, dueDay: 10, label: "TV da irmã", address: "Rua da irmã, 300", neighborhood: "Centro", pop: "POP Centro" } });
  assert.equal(next.plans[1].serviceType, "IPTV");
  assert.equal(next.contracts[1].price, 2990);
  assert.equal(next.subscribers.length, 1);
  assert.throws(() => run(state, { type: "plan.create", input: { name: "Internet inválida", speed: 0, price: 100 } }));
});
