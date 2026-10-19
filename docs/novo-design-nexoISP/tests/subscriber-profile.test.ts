import test from "node:test";
import assert from "node:assert/strict";
import { buildOnuReadOnlyScript, getSubscriberProfile } from "../lib/subscriber-profile";
import type { Subscriber, WorkspaceData } from "../lib/types";

const subscriber = { id: "a", pop: "Centro" } as Subscriber;
const data = {
  snapshot: { asOf: "2026-10-17T09:42:00-03:00" },
  invoices: [
    { id: "1", subscriberId: "a", due: "2026-10-10", amount: 100, status: "Vencida" },
    { id: "2", subscriberId: "a", due: "2026-11-10", amount: 120, status: "Em aberto" },
    { id: "3", subscriberId: "a", due: "2026-09-10", amount: 90, status: "Em conciliação" },
    { id: "4", subscriberId: "a", due: "2026-08-10", amount: 95, status: "Paga" },
    { id: "5", subscriberId: "b", due: "2026-08-10", amount: 500, status: "Vencida" },
  ],
  tickets: [{ id: "t1", subscriberId: "a", opened: "2026-10-17", status: "Resolvido" }, { id: "t2", subscriberId: "a", opened: "2026-10-16", status: "Em atendimento" }],
  orders: [{ subscriberId: "a", status: "Concluída" }, { subscriberId: "a", status: "Agendada" }],
  activities: [], nodes: [],
} as unknown as WorkspaceData;

test("a ficha considera somente registros do assinante e separa conciliação de recebimento", () => {
  const profile = getSubscriberProfile(subscriber, data);
  assert.equal(profile.invoices.length, 4);
  assert.equal(profile.overdueTotal, 100);
  assert.equal(profile.pendingTotal, 120);
  assert.equal(profile.paidTotal, 95);
  assert.equal(profile.reconciliationTotal, 90);
  assert.equal(profile.overdueDays, 7);
  assert.equal(profile.openTickets.length, 1);
  assert.equal(profile.openOrders.length, 1);
});

test("a consulta gera exclusivamente comando de leitura e normaliza o serial", () => {
  assert.equal(buildOnuReadOnlyScript(" hwtc12345678 "), "display ont info by-sn HWTC12345678\n");
});

test("a consulta rejeita comandos e caracteres injetados no serial", () => {
  for (const value of ["", "HWTC1234\nreboot", "HWTC1234;reset", "$(reboot)", "HWTC 12345678", "X".repeat(25)]) {
    assert.throws(() => buildOnuReadOnlyScript(value), /Serial da ONU inválido/);
  }
});
