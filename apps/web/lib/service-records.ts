import { normalize } from "../domain/formatters";
import { getSubscriberProfile } from "./subscriber-profile";
import type { Subscriber, WorkspaceData } from "./types";

export type ServiceRecord = {
  id: string;
  source: "Observação de OS" | "Evento do assinante";
  reference: string;
  title: string;
  content: string;
  time: string;
  orderId?: string;
};

export function getSubscriberServiceRecords(subscriber: Subscriber, data: WorkspaceData, query = "", status = "Todos") {
  const profile = getSubscriberProfile(subscriber, data);
  const search = normalize(query.trim());
  const matches = (...values: (string | number)[]) => normalize(values.join(" ")).includes(search);
  const records: ServiceRecord[] = [
    ...profile.orders.filter(order => order.notes.trim()).map(order => ({
      id: `order-${order.id}`,
      source: "Observação de OS" as const,
      reference: `OS #${order.code}`,
      title: order.type,
      content: order.notes,
      time: `Horário da visita: ${order.time}`,
      orderId: order.id,
    })),
    ...profile.activities.map(activity => ({
      id: `activity-${activity.id}`,
      source: "Evento do assinante" as const,
      reference: `Cliente #${subscriber.code}`,
      title: activity.title,
      content: activity.description,
      time: activity.time,
    })),
  ];
  return {
    profile,
    recordCount: records.length,
    tickets: profile.tickets.filter(ticket => (status === "Todos" || ticket.status === status) && matches(ticket.code, ticket.subject, ticket.category, ticket.agent, ticket.channel, ticket.priority, ticket.status)),
    orders: profile.orders.filter(order => (status === "Todos" || order.status === status) && matches(order.code, order.type, order.technician, order.neighborhood, order.notes, order.status)),
    records: records.filter(record => matches(record.reference, record.title, record.content, record.source)),
  };
}
