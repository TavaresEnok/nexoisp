import { z } from "zod";
import type { Invoice } from "@/domain/workspace";
import {
  formatDocument,
  formatPhone,
  shortCode,
} from "@/features/shared/format";
import { cents, money } from "@/features/shared/schema";
export const invoiceSchema = z.object({
  id: z.string().uuid(),
  contract_id: z.string().uuid(),
  subscriber_id: z.string().uuid(),
  subscriber_name: z.string(),
  plan_name: z.string(),
  amount_cents: cents(),
  paid_cents: cents(),
  due_date: z.string(),
  competence: z.string().nullable(),
  status: z.enum(["open", "paid", "canceled", "reconciling"]),
  overdue: z.boolean(),
  gateway: z.string().nullable(),
  gateway_charge_id: z.string().nullable(),
  fee_cents: cents(),
  discount_cents: cents(),
});
export type ErpInvoice = z.infer<typeof invoiceSchema>;
// These aggregates have a numeric JSON contract and must retain every cent.
const aggregateCents = () =>
  z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
// Dividing a large safe integer by 100 can already lose its final cent.
export function aggregateMoney(cents: number) {
  aggregateCents().parse(cents);
  const value = BigInt(cents);
  const whole = value / 100n;
  const fraction = (value < 0n ? -value % 100n : value % 100n)
    .toString()
    .padStart(2, "0");
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .formatToParts(whole === 0n && value < 0n ? -0 : whole)
    .map((part) => (part.type === "fraction" ? fraction : part.value))
    .join("");
}
export const monthlySchema = z.array(
  z.object({
    month: z.string(),
    received_cents: aggregateCents(),
  }),
);
export const summarySchema = z.object({
  open: z.coerce.number(),
  open_cents: aggregateCents(),
  nominal_open_cents: aggregateCents(),
  received_open_cents: aggregateCents(),
  overdue: z.coerce.number(),
  overdue_cents: aggregateCents(),
  reconciling: z.coerce.number(),
  received_month_cents: aggregateCents(),
});
export type FinanceSummary = z.infer<typeof summarySchema>;
export type Due = {
  remaining_cents: number;
  days_late: number;
  fee_if_applied_cents: number;
  fee_cents: number;
  discount_cents: number;
};
export type Payment = {
  id: string;
  kind: string;
  source: string;
  paid_at: string;
  amount_cents: number;
  method: string | null;
  note: string | null;
  reversal_of: string | null;
  created_by_name: string | null;
};
export type GatewayEvent = {
  id: string;
  type: string;
  received_at: string;
  status: string;
  note: string | null;
  subscriber_name?: string | null;
  invoice_id?: string | null;
};
export type InvoiceDetail = ErpInvoice & {
  provider_issuance_id?: string | null;
  paid_at: string | null;
  status_note: string | null;
  payment_methods: Record<string, unknown> | null;
  items: { description: string; amount_cents: number }[];
  payments: Payment[];
  events: GatewayEvent[];
};
export function invoiceStatus(invoice: Pick<ErpInvoice, "status" | "overdue">) {
  return invoice.status === "open"
    ? invoice.overdue
      ? "Vencida"
      : "Em aberto"
    : (
        {
          paid: "Paga",
          canceled: "Cancelada",
          reconciling: "Em conciliação",
        } as const
      )[invoice.status];
}
export function projectInvoice(invoice: ErpInvoice): Invoice {
  return {
    id: invoice.id,
    code: shortCode(invoice.id),
    subscriberId: invoice.subscriber_id,
    name: invoice.subscriber_name,
    amount: invoice.amount_cents / 100,
    due: invoice.due_date,
    status: invoiceStatus(invoice),
    method: invoice.gateway_charge_id
      ? invoice.gateway === "demo"
        ? "Gateway demonstrativo"
        : (invoice.gateway ?? "Gateway não informado")
      : "Sem cobrança emitida",
    reference: invoice.competence
      ? invoice.competence.slice(0, 7).split("-").reverse().join("/")
      : "Avulsa",
  };
}
export const policySchema = z.object({
  gateway: z.enum(["none", "demo"]),
  demo_mode: z.boolean(),
  billing_auto: z.boolean(),
  auto_suspend: z.boolean(),
  auto_resume_on_payment: z.boolean(),
  trust_release_enabled: z.boolean(),
  prorate_first_month: z.boolean(),
  suspend_after_days: z.coerce.number().nullable(),
  trust_release_days: z.coerce.number(),
  trust_release_gap_days: z.coerce.number(),
  late_fee_percent: money(),
  interest_monthly_percent: z.coerce.number(),
  suspension_mode: z.enum(["reject", "profile"]),
  suspension_profile: z.string().nullable(),
});
