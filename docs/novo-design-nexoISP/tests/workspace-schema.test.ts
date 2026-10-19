import test from "node:test";
import assert from "node:assert/strict";
import seed from "../lib/db/demo-seed.json";
import { parseWorkspaceRecords, workspaceDataSchema } from "../lib/workspace-schema";
import { matchesSubscriber } from "../lib/subscriber-search";
import { getSubscriberHistory } from "../lib/subscriber-history";

const data = parseWorkspaceRecords(seed.records);
test("consulta valida os 82 registros públicos e preserva valores em reais", () => {
  assert.equal(seed.records.length, 82);
  assert.ok(data.subscribers.length > 0);
  assert.equal(data.invoices.find(i => i.id === "inv-1")?.amount, 149.9);
});
test("consulta recusa payloads inválidos sem inventar valores de fallback", () => {
  for (const mutate of [
    (d: typeof data) => { d.subscribers[0].price = -1; },
    (d: typeof data) => { d.invoices[0].amount = "149.90" as unknown as number; },
    (d: typeof data) => { d.invoices[0].subscriberId = "ausente"; },
    (d: typeof data) => { d.subscribers.push(d.subscribers[0]); },
    (d: typeof data) => { d.snapshot.asOf = "data inválida"; },
    (d: typeof data) => { d.subscribers[0].access = { latitude: 100 }; },
  ]) { const invalid = structuredClone(data); mutate(invalid); assert.equal(workspaceDataSchema.safeParse(invalid).success, false); }
  assert.throws(() => parseWorkspaceRecords(seed.records.filter(r => r.kind !== "snapshot")));
  assert.throws(() => parseWorkspaceRecords([...seed.records, seed.records.find(r => r.kind === "snapshot")!]));
  assert.throws(() => parseWorkspaceRecords([{ id: "invalid", kind: "subscriber", payload: null }]));
});
test("busca global cobre documento, telefone, PPPoE, IP, MAC e serial", () => {
  const subscriber = { ...data.subscribers[0], name: "João Exemplo", document: "DEMO-12345", phone: "+55 (11) 91234-5678", onu: "HWTC12345678", access: { login: "joao.pppoe", ip: "100.64.1.23", mac: "AA:BB:CC:DD:EE:FF" } };
  for (const query of ["joao", "demo-12345", "11912345678", "joao.pppoe", "100.64.1.23", "aa-bb-cc-dd-ee-ff", "HWTC12345678", subscriber.code, subscriber.email]) assert.equal(matchesSubscriber(subscriber, query), true, query);
  assert.equal(matchesSubscriber(subscriber, "não existe"), false);
  assert.equal(matchesSubscriber(subscriber, "  "), true);
});
test("histórico ordena os dias e separa OS sem data sem usar vencimento como data de pagamento", () => {
  const subscriber = data.subscribers[0];
  const history = getSubscriberHistory(subscriber, data);
  const days = history.dated.map(item => item.at.slice(0, 10));
  assert.deepEqual(days, [...days].sort().reverse());
  assert.equal(history.undatedOrders.length, data.orders.filter(o => o.subscriberId === subscriber.id).length);
  for (const invoice of data.invoices.filter(i => i.subscriberId === subscriber.id)) {
    const entry = history.dated.find(item => item.id === invoice.id)!;
    assert.match(entry.title, /^Vencimento/);
    assert.match(entry.description, /Não representa a data do pagamento/);
  }
});
