import test from "node:test";
import assert from "node:assert/strict";
import { demoReaders } from "../data/demo/readers";
import { selectSubscribers } from "../application/selectors/subscribers";
import { selectInvoices } from "../application/selectors/financial";
import { selectTickets, selectOrders } from "../application/selectors/operations";
import { selectNetworkNodes, selectMapSubscribers } from "../application/selectors/network";
import { selectContracts, selectPlans } from "../application/selectors/commercial";
import { selectActivities, selectReportIndicators } from "../application/selectors/reports";
import { getCommercialData } from "../lib/commercial";
import { normalize, scenarioDate } from "../domain/formatters";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}

test("assinantes: filtros combinados, ordenação e vazio não alteram a amostra", async () => {
  const data = freeze(await demoReaders.readWorkspace());
  const before = JSON.stringify(data);
  const rows = selectSubscribers(data.subscribers, { status: "Ativo", connection: "Online", query: "Mariana", sortAsc: true });
  assert.ok(rows.length > 0);
  assert.ok(rows.every(s => s.status === "Ativo" && s.connection === "Online" && s.name.includes("Mariana")));
  const ascending = selectSubscribers(data.subscribers, { status: "Todos", connection: "Todas", query: "", sortAsc: true });
  const descending = selectSubscribers(data.subscribers, { status: "Todos", connection: "Todas", query: "", sortAsc: false });
  assert.deepEqual(ascending.map(s => s.id).reverse(), descending.map(s => s.id));
  assert.equal(selectSubscribers(data.subscribers, { status: "Todos", connection: "Todas", query: "sem-correspondencia", sortAsc: true }).length, 0);
  assert.equal(JSON.stringify(data), before);
});

test("financeiro: total acompanha a seleção em reais, não o snapshot agregado", async () => {
  const data = freeze(await demoReaders.readWorkspace());
  const { rows, total } = selectInvoices(data.invoices, "Vencida", "");
  assert.ok(rows.length > 0);
  assert.ok(rows.every(i => i.status === "Vencida"));
  assert.equal(total, rows.reduce((sum, i) => sum + i.amount, 0));
  assert.deepEqual(selectInvoices(data.invoices, "Todas", "sem-correspondencia"), { rows: [], total: 0 });
  assert.notEqual(total, data.snapshot.overdue);
});

test("atendimento e OS preservam SLA, técnico, busca e reset", async () => {
  const data = freeze(await demoReaders.readWorkspace());
  assert.deepEqual(selectTickets(data.tickets, "Em risco", ""), data.tickets.filter(t => t.sla === "Em risco"));
  assert.deepEqual(selectTickets(data.tickets, "Todos", ""), data.tickets);
  const order = data.orders[0];
  const rows = selectOrders(data.orders, order.status, order.technician, String(order.code));
  assert.deepEqual(rows, [order]);
  assert.deepEqual(selectOrders(data.orders, "Todas", "Todos", ""), data.orders);
});

test("contratos e planos: agrupamento, seleção vazia e ordenação não inventam catálogo", async () => {
  const data = freeze(await demoReaders.readWorkspace());
  const commercial = getCommercialData(data);
  const result = selectContracts(data, { planId: null, subscriberId: null, status: "Todos", query: "" });
  assert.equal(result.rows.length, commercial.contracts.length);
  assert.equal(result.groups.flatMap(group => group.contracts).length, result.rows.length);
  assert.equal(selectContracts(data, { planId: "inexistente", subscriberId: null, status: "Todos", query: "" }).rows.length, 0);
  const plans = selectPlans(data, { query: "", service: "Todos", pop: "", sort: "speed" });
  assert.ok(plans.every((row, index) => !index || (plans[index - 1].plan.download ?? -1) >= (row.plan.download ?? -1)));
  assert.ok(plans.every(row => row.plan.source === "legacy" && row.plan.price === null));
});

test("rede e relatórios preservam recortes, ausências e datas do cenário", async () => {
  const data = freeze(await demoReaders.readWorkspace());
  assert.deepEqual(selectNetworkNodes(data.nodes, "Todos", ""), data.nodes);
  const rows = selectNetworkNodes(data.nodes, "Atenção", "norte");
  assert.ok(rows.every(n => n.status === "Atenção" && normalize(n.pop).includes("norte")));
  const map = selectMapSubscribers(data.subscribers, { visibility: "online" }, "");
  assert.ok(map.rows.every(s => s.connection === "Online"));
  assert.equal(map.online, map.rows.length);
  assert.ok(map.located.every(s => s.access && typeof s.access.latitude === "number"));
  assert.deepEqual(selectActivities(data.activities, "Todos"), data.activities);
  assert.equal(selectActivities(data.activities, "ausente").length, 0);
  assert.equal(selectReportIndicators({ ...data.snapshot, availability: 0 })[5][1], "0,00%");
  assert.equal(scenarioDate(data.snapshot.asOf), "17 de outubro");
});
