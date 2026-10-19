import test from "node:test";
import assert from "node:assert/strict";
import seed from "../lib/db/demo-seed.json";
import { getOverviewMetrics, getOverviewBreakdown, overviewAreas } from "../lib/overview";
import type { WorkspaceData } from "../lib/types";

function workspace(): WorkspaceData {
  const rows = (kind: string) => seed.records.filter(row => row.kind === kind).map(row => ({ ...structuredClone(row.payload), id: row.id }));
  return {
    snapshot: rows("snapshot")[0], subscribers: rows("subscriber"), invoices: rows("invoice"),
    tickets: rows("ticket"), orders: rows("order"), nodes: rows("node"), activities: rows("activity"),
  } as unknown as WorkspaceData;
}

test("cada aba apresenta quatro indicadores próprios e destinos válidos", () => {
  const data = workspace();
  const signatures = new Set<string>();
  for (const area of overviewAreas) {
    const metrics = getOverviewMetrics(area.value, data);
    assert.equal(metrics.length, 4);
    assert.ok(metrics.every(metric => metric.href.startsWith("/") && metric.value.length > 0));
    signatures.add(metrics.map(metric => metric.title).join("|"));
  }
  assert.equal(signatures.size, 4);
  assert.deepEqual(getOverviewMetrics("overview", data).map(metric => metric.title), ["Base ativa", "Conectados agora", "Receita recebida", "Atendimento"]);
});

test("gráficos de rede e atendimento refletem somente os registros disponíveis", () => {
  const data = workspace();
  const support = getOverviewBreakdown("support", data);
  assert.equal(support.reduce((sum, row) => sum + row.value, 0), data.tickets.length);
  const network = getOverviewBreakdown("network", data);
  assert.deepEqual(network, data.nodes.map(node => ({ name: node.name, value: node.traffic })));
  data.tickets = [];
  data.nodes = [];
  assert.deepEqual(getOverviewBreakdown("support", data), []);
  assert.deepEqual(getOverviewBreakdown("network", data), []);
});

test("indicadores de atendimento excluem chamados resolvidos dos alertas", () => {
  const data = workspace();
  data.tickets = data.tickets.slice(0, 1).map(ticket => ({ ...ticket, status: "Resolvido", priority: "Alta", sla: "Em risco" }));
  const metrics = getOverviewMetrics("support", data);
  assert.equal(metrics.find(metric => metric.title === "Prioridade alta")?.value, "0");
  assert.equal(metrics.find(metric => metric.title === "SLA em risco")?.value, "0");
});

test("percentuais permanecem válidos quando não há faturamento ou assinantes", () => {
  const data = workspace();
  data.snapshot.active = 0;
  data.snapshot.billed = 0;
  for (const area of overviewAreas) {
    assert.doesNotMatch(JSON.stringify(getOverviewMetrics(area.value, data)), /NaN|Infinity/);
  }
});
