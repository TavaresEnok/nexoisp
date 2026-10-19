import type { Subscriber, WorkspaceData } from "@/lib/types";

export function getSubscriberProfile(subscriber: Subscriber, data: WorkspaceData) {
  const invoices = data.invoices.filter(item => item.subscriberId === subscriber.id).sort((a, b) => b.due.localeCompare(a.due));
  const tickets = data.tickets.filter(item => item.subscriberId === subscriber.id).sort((a, b) => b.opened.localeCompare(a.opened));
  const orders = data.orders.filter(item => item.subscriberId === subscriber.id);
  const activities = data.activities.filter(item => item.subscriberId === subscriber.id);
  const overdue = invoices.filter(item => item.status === "Vencida");
  const pending = invoices.filter(item => item.status === "Em aberto");
  const paid = invoices.filter(item => item.status === "Paga");
  const reconciliation = invoices.filter(item => item.status === "Em conciliação");
  const total = (rows: typeof invoices) => rows.reduce((sum, item) => sum + item.amount, 0);
  const openTickets = tickets.filter(item => item.status !== "Resolvido" && item.status !== "Cancelado");
  const openOrders = orders.filter(item => item.status !== "Concluída" && item.status !== "Cancelada");
  const referenceTime = new Date(data.snapshot.asOf).getTime();
  const oldestDue = overdue.map(item => item.due).sort()[0];
  const overdueDays = oldestDue ? Math.max(0, Math.floor((referenceTime - new Date(`${oldestDue.slice(0, 10)}T00:00:00-03:00`).getTime()) / 86400000)) : 0;
  const popNodes = data.nodes.filter(item => item.pop === subscriber.pop);
  return { invoices, tickets, orders, activities, overdue, pending, paid, reconciliation, overdueTotal: total(overdue), pendingTotal: total(pending), paidTotal: total(paid), reconciliationTotal: total(reconciliation), openTickets, openOrders, overdueDays, popNodes };
}

export function buildOnuReadOnlyScript(serial: string) {
  const normalized = serial.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,24}$/.test(normalized)) throw new Error("Serial da ONU inválido. Confira o cadastro antes de gerar a consulta.");
  return `display ont info by-sn ${normalized}\n`;
}
