import { z } from "zod";
import type { Ticket } from "@/domain/workspace";
export const stageLabels: Record<string, string> = {
  new: "Novo",
  contacted: "Contatado",
  proposal: "Proposta enviada",
  won: "Convertido",
  lost: "Perdido",
};
export const ticketLabels: Record<string, string> = {
  open: "Aguardando o provedor",
  waiting: "Aguardando o assinante",
  closed: "Encerrado",
};
export const categoryLabels: Record<string, string> = {
  technical: "Técnico",
  financial: "Financeiro",
  commercial: "Comercial",
  other: "Outro",
};
export const priorityLabels: Record<string, string> = {
  low: "Baixa",
  normal: "Normal",
  high: "Alta",
};
const contact = {
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  document: z.string().nullable(),
  address_street: z.string().nullable(),
  address_number: z.string().nullable(),
  address_district: z.string().nullable(),
  address_city: z.string().nullable(),
  address_state: z.string().nullable(),
  address_zip: z.string().nullable(),
  source: z.string().nullable(),
  plan_id: z.string().nullable(),
  notes: z.string().nullable(),
};
export const leadSchema = z.object({
  ...contact,
  id: z.string().uuid(),
  stage: z.enum(["new", "contacted", "proposal", "won", "lost"]),
  owner_id: z.string().nullable(),
  owner_name: z.string().nullable(),
  plan_name: z.string().nullable(),
  subscriber_id: z.string().nullable(),
  subscriber_name: z.string().nullable(),
  lost_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const leadDetailSchema = leadSchema.extend({
  events: z.array(
    z.object({
      at: z.string(),
      event: z.string(),
      detail: z.record(z.string(), z.unknown()),
      actor_name: z.string().nullable(),
    }),
  ),
});
export type Lead = z.infer<typeof leadSchema>;
export type LeadDetail = z.infer<typeof leadDetailSchema>;
export const ticketSchema = z.object({
  id: z.string().uuid(),
  number: z.coerce.number().int(),
  subscriber_id: z.string().uuid(),
  subscriber_name: z.string(),
  contract_id: z.string().nullable(),
  subject: z.string(),
  category: z.string(),
  priority: z.string(),
  status: z.enum(["open", "waiting", "closed"]),
  origin: z.string(),
  assignee_id: z.string().nullable(),
  assignee_name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  sla_due_at: z.string().nullable(),
  sla_breached_at: z.string().nullable(),
  type_id: z.string().nullable(),
  classification_id: z.string().nullable(),
  root_cause_id: z.string().nullable(),
});
export const ticketDetailSchema = ticketSchema.extend({
  thread: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      at: z.string(),
      author_kind: z.string(),
      author_name: z.string().nullable(),
      body: z.string(),
      internal: z.boolean(),
    }),
  ),
  work_orders: z.array(
    z.object({
      id: z.string().uuid(),
      number: z.coerce.number(),
      kind: z.string(),
      status: z.string(),
    }),
  ),
});
export type ErpTicket = z.infer<typeof ticketSchema>;
export type TicketDetail = z.infer<typeof ticketDetailSchema>;
export type TicketDisplay = Omit<Ticket, "wait">;
export function projectTicket(ticket: ErpTicket): TicketDisplay {
  return {
    id: ticket.id,
    code: ticket.number,
    subscriberId: ticket.subscriber_id,
    name: ticket.subscriber_name,
    subject: ticket.subject,
    category: categoryLabels[ticket.category] ?? ticket.category,
    status: ticketLabels[ticket.status],
    priority: priorityLabels[ticket.priority] ?? ticket.priority,
    agent: ticket.assignee_name ?? "Não atribuído",
    channel:
      ticket.origin === "portal" ? "Portal do assinante" : "Equipe do provedor",
    opened: ticket.created_at,
    sla: ticket.sla_breached_at
      ? "Estourado"
      : ticket.sla_due_at
        ? "Prazo registrado"
        : "Sem prazo definido",
  };
}
