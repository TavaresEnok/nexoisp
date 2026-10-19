import type { Ticket, WorkOrder } from "../../lib/types";
import { normalize } from "../../domain/formatters";

export function selectTickets(tickets: readonly Ticket[], status: string, query: string) {
  return tickets.filter(t => (status === "Todos" || (status === "Em risco" ? t.sla === "Em risco" : t.status === status)) && normalize(`${t.name} ${t.subject} ${t.code}`).includes(normalize(query)));
}
export function selectOrders(orders: readonly WorkOrder[], status: string, technician: string, query: string) {
  return orders.filter(o => (status === "Todas" || o.status === status) && (technician === "Todos" || o.technician === technician) && normalize(`${o.name} ${o.code} ${o.type} ${o.technician} ${o.neighborhood}`).includes(normalize(query.trim())));
}
