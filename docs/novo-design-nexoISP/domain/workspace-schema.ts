import { z } from "zod";
import type { WorkspaceData } from "./workspace";

const text = z.string();
const id = text.min(1);
const nonnegative = z.number().nonnegative();
const serviceType = z.enum(["Internet", "IPTV", "Telefonia", "Serviço"]);
const accessSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
  login: text.optional(), ip: text.optional(), mac: text.optional(), olt: text.optional(), oltSlot: text.optional(),
  pon: text.optional(), complement: text.optional(), connectionType: text.optional(), group: text.optional(),
  ipv6: z.boolean().optional(), ipv6Pd: z.boolean().optional(), fixedIp: z.boolean().optional(), personType: text.optional(),
  simultaneousSessions: nonnegative.int().optional(), serviceName: text.optional(), nasPortId: text.optional(),
  tags: z.array(text).optional(), uptime: text.optional(), download: text.optional(), upload: text.optional(),
});
export const subscriberSchema = z.object({
  id, code: id, name: id, email: text, phone: text, document: text, plan: text, speed: nonnegative,
  price: nonnegative, status: text, connection: text, neighborhood: text, address: text, pop: text,
  signal: z.number(), since: z.iso.date(), dueDay: z.number().int().min(1).max(31), contract: text,
  onu: text, nas: text, access: accessSchema.optional(),
});
const invoiceSchema = z.object({ id, code: id, subscriberId: id, name: text, amount: nonnegative, due: z.iso.date(), status: text, method: text, reference: text });
const ticketSchema = z.object({ id, code: nonnegative.int(), subscriberId: id, name: text, subject: text, category: text, status: text, priority: text, agent: text, channel: text, opened: z.union([z.iso.date(), z.iso.datetime({ offset: true })]), wait: nonnegative, sla: text });
const orderSchema = z.object({ id, code: nonnegative.int(), subscriberId: id, name: text, type: text, technician: text, time: text.regex(/^\d{2}:\d{2}$/), status: text, neighborhood: text, duration: nonnegative, notes: text });
const nodeSchema = z.object({ id, name: text, type: text, pop: text, ip: text, status: text, latency: nonnegative, sessions: nonnegative, capacity: nonnegative, cpu: nonnegative, traffic: nonnegative, lastRead: z.iso.datetime({ offset: true }), vendor: text });
const activitySchema = z.object({ id, title: text, description: text, time: text.regex(/^\d{2}:\d{2}$/), type: text, subscriberId: id.optional() });
const snapshotSchema = z.object({
  id: id.optional(), asOf: z.iso.datetime({ offset: true }), provider: id, active: nonnegative, newSubscribers: nonnegative,
  mrr: nonnegative, received: nonnegative, billed: nonnegative, openInvoices: nonnegative, overdue: nonnegative,
  delinquency: nonnegative, ticketsOpen: nonnegative, waiting: nonnegative, online: nonnegative, accounts: nonnegative,
  availability: nonnegative.max(100), latency: nonnegative, equipmentOnline: nonnegative, equipmentTotal: nonnegative,
  onusDegraded: nonnegative, reconciliation: nonnegative, ordersLate: nonnegative, ordersToday: nonnegative,
  series: z.array(z.object({ day: text, current: nonnegative, previous: nonnegative })),
});
const planSchema = z.object({
  id, name: id, serviceType, download: nonnegative.nullable(), upload: nonnegative.nullable(), price: nonnegative.nullable(),
  active: z.boolean().nullable(), technology: text.nullable(), billing: text.nullable(), installationFee: nonnegative.nullable(),
  loyaltyMonths: nonnegative.nullable(), discount: nonnegative.nullable(), sla: text.nullable(), ipv4Pool: text.nullable(),
  ipv6Pool: text.nullable(), policyIn: text.nullable(), policyOut: text.nullable(), radius: text.nullable(), onu: text.nullable(),
  source: z.enum(["catalog", "legacy"]),
});
const contractSchema = z.object({
  id, code: id, subscriberId: id, planId: id, label: text, address: text, neighborhood: text, pop: text,
  price: nonnegative, dueDay: z.number().int().min(1).max(31), status: text, since: z.iso.date(),
  additionalServices: z.array(z.object({ id, name: text, serviceType, price: nonnegative })),
});
export const workspaceDataSchema = z.object({
  snapshot: snapshotSchema, subscribers: z.array(subscriberSchema), invoices: z.array(invoiceSchema),
  tickets: z.array(ticketSchema), orders: z.array(orderSchema), nodes: z.array(nodeSchema), activities: z.array(activitySchema),
  commercialPlans: z.array(planSchema).optional(), contracts: z.array(contractSchema).optional(),
}).superRefine((data, context) => {
  const subscribers = new Set(data.subscribers.map(s => s.id));
  const plans = new Set(data.commercialPlans?.map(p => p.id));
  const collections = [data.subscribers, data.invoices, data.tickets, data.orders, data.nodes, data.activities, data.commercialPlans ?? [], data.contracts ?? []];
  if (collections.some(rows => new Set(rows.map(row => row.id)).size !== rows.length)) context.addIssue({ code: "custom", message: "Identificadores duplicados na consulta." });
  for (const row of [...data.invoices, ...data.tickets, ...data.orders, ...data.activities, ...(data.contracts ?? [])]) {
    if (row.subscriberId && !subscribers.has(row.subscriberId)) context.addIssue({ code: "custom", message: `Assinante ausente no vínculo ${row.id}.` });
  }
  if (data.commercialPlans && data.contracts?.some(c => !plans.has(c.planId))) context.addIssue({ code: "custom", message: "Contrato com plano inexistente." });
}) satisfies z.ZodType<WorkspaceData>;

export function parseWorkspaceRecords(records: readonly { id: string; kind: string; payload: unknown }[]): WorkspaceData {
  const kinds = new Set(["snapshot", "subscriber", "invoice", "ticket", "order", "node", "activity", "plan", "contract"]);
  const ids = new Set<string>();
  for (const row of records) {
    if (!kinds.has(row.kind)) throw new Error(`Tipo de registro desconhecido: ${row.kind}.`);
    if (!row.id || ids.has(row.id)) throw new Error("Identificadores duplicados ou ausentes nos registros.");
    ids.add(row.id);
    if (row.payload && typeof row.payload === "object" && "id" in row.payload && row.payload.id !== row.id) throw new Error(`Identificador divergente no registro ${row.id}.`);
  }
  const collect = (kind: string) => records.filter(row => row.kind === kind).map(row => {
    if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) throw new Error("Registro inválido na consulta.");
    return { ...row.payload, id: row.id };
  });
  const snapshots = collect("snapshot");
  if (snapshots.length !== 1) throw new Error("A consulta precisa de exatamente um snapshot.");
  const data = workspaceDataSchema.parse({
    snapshot: snapshots[0], subscribers: collect("subscriber"), invoices: collect("invoice"), tickets: collect("ticket"),
    orders: collect("order"), nodes: collect("node"), activities: collect("activity"),
    ...(records.some(r => r.kind === "plan") ? { commercialPlans: collect("plan") } : {}),
    ...(records.some(r => r.kind === "contract") ? { contracts: collect("contract") } : {}),
  });
  return { ...data, subscribers: data.subscribers.sort((a, b) => a.code.localeCompare(b.code)), tickets: data.tickets.sort((a, b) => a.code - b.code), orders: data.orders.sort((a, b) => a.time.localeCompare(b.time)) };
}
