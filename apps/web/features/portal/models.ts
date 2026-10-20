import { z } from "zod";
import { cents } from "@/features/shared/schema";
export const portalContract = z.object({
  id: z.string().uuid(),
  status: z.string(),
  due_day: z.coerce.number(),
  plan_name: z.string(),
  price_cents: cents(),
  down_kbps: z.coerce.number(),
  up_kbps: z.coerce.number(),
  desired_policy: z.string().nullable(),
  observed_policy: z.string().nullable(),
  desired_version: z.coerce.number().nullable(),
  observed_version: z.coerce.number().nullable(),
  trust_release: z.object({
    enabled: z.boolean(),
    eligible: z.boolean(),
    reason: z.string().nullable(),
    max_days: z.coerce.number(),
    active_until: z.string().nullable(),
  }),
});
export const portalInvoice = z.object({
  id: z.string().uuid(),
  contract_id: z.string(),
  competence: z.string().nullable(),
  due_date: z.string(),
  amount_cents: cents(),
  status: z.string(),
  gateway: z.string().nullable(),
  overdue: z.boolean(),
  payment_methods: z.record(z.string(), z.unknown()).nullable(),
});
export type PortalInvoice = z.infer<typeof portalInvoice>;
export const overview = z.object({
  subscriber: z.object({
    name: z.string(),
    document: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    address_street: z.string().nullable(),
    address_number: z.string().nullable(),
    address_city: z.string().nullable(),
    address_state: z.string().nullable(),
  }),
  contracts: z.array(portalContract),
  invoices: z.array(portalInvoice),
  notices: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      message: z.string(),
      starts_at: z.string(),
      ends_at: z.string(),
      active: z.boolean(),
    }),
  ),
  usage: z.array(
    z.object({
      contract_id: z.string(),
      month: z.string(),
      bytes_in: z.coerce.number(),
      bytes_out: z.coerce.number(),
      sessions: z.coerce.number(),
    }),
  ),
});
export const acceptance = z.object({
  id: z.string(),
  contract_id: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.string(),
  requested_at: z.string(),
  accepted_at: z.string().nullable(),
});
export const ticket = z.object({
  id: z.string(),
  number: z.coerce.number(),
  subject: z.string(),
  category: z.string(),
  status: z.string(),
  updated_at: z.string(),
});
export const ticketDetail = ticket.extend({
  thread: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      at: z.string(),
      author_kind: z.string(),
      body: z.string(),
    }),
  ),
});
export const portalDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value.split("-").reverse().join("/")
    : new Date(value).toLocaleString("pt-BR");
export function portalAccessLabel(contract: z.infer<typeof portalContract>) {
  if (contract.status !== "active") return "Contrato encerrado";
  if (contract.desired_policy == null) return "Acesso em instalação";
  if (
    contract.desired_version !== contract.observed_version ||
    contract.desired_policy !== contract.observed_policy
  )
    return contract.desired_policy === "suspended"
      ? "Suspensão em aplicação"
      : "Liberação em aplicação";
  return contract.observed_policy === "suspended"
    ? "Acesso suspenso"
    : "Acesso liberado";
}
