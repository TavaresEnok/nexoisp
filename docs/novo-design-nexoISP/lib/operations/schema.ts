import { z } from "zod";

const id = z.string().min(1).max(160);
const text = z.string().trim().min(3).max(500);
const cents = z.number().int().min(1).max(100_000_000);
export const planInputSchema = z.object({
  name: z.string().trim().min(3).max(100),
  speed: z.number().int().min(0).max(100_000),
  price: cents,
  serviceType: z.enum(["Internet", "IPTV", "Telefonia", "Serviço"]).default("Internet"),
  upload: z.number().int().min(0).max(100_000).nullable().default(null),
}).strict().refine(p => p.serviceType !== "Internet" || p.speed > 0, { message: "Planos de internet exigem download maior que zero.", path: ["speed"] });
export const subscriberInputSchema = z.object({
  name: z.string().trim().min(3).max(120),
  document: z.string().trim().regex(/^DEMO-[A-Z0-9-]{3,40}$/i, "Use um identificador fictício iniciado por DEMO-.").transform(s => s.toUpperCase()),
  email: z.email().max(150),
  phone: z.string().trim().min(8).max(25),
  address: z.string().trim().min(5).max(180),
  neighborhood: z.string().trim().min(2).max(80),
  pop: z.string().trim().min(2).max(80),
  planId: id,
  dueDay: z.number().int().min(1).max(28),
}).strict();
const subscriberEditSchema = subscriberInputSchema.pick({ name: true, email: true, phone: true, address: true, neighborhood: true, pop: true });
const changeSchema = z.object({ planId: id, dueDay: z.number().int().min(1).max(28), date: z.iso.date(), reason: text }).strict();
const ticketStatus = z.enum(["Aberto", "Em atendimento", "Aguardando", "Resolvido"]);
const orderStatus = z.enum(["Agendada", "Em execução", "Concluída", "Cancelada"]);
const paymentMethod = z.enum(["Pix demonstrativo", "Boleto demonstrativo", "Dinheiro demonstrativo"]);
const note = z.object({ id, text, actorId: id, at: z.iso.datetime(), visibility: z.enum(["Interna", "Resposta demonstrativa"]) });
const plan = planInputSchema.safeExtend({ id, catalogId: id, version: z.number().int().positive(), active: z.boolean() });
const subscriber = z.object({ ...subscriberEditSchema.shape, id, document: z.string(), createdAt: z.iso.datetime(), notes: z.array(note) });
export const contractInputSchema = z.object({
  subscriberId: id, planId: id, dueDay: z.number().int().min(1).max(28),
  label: z.string().trim().min(3).max(100),
  address: z.string().trim().min(5).max(180),
  neighborhood: z.string().trim().min(2).max(80),
  pop: z.string().trim().min(2).max(80),
}).strict();
const contract = z.object({
  id, subscriberId: id, planId: id, price: cents, dueDay: z.number().int().min(1).max(28),
  label: z.string().max(100).default("Instalação principal"),
  address: z.string().max(180).default(""), neighborhood: z.string().max(80).default(""), pop: z.string().max(80).default(""),
  status: z.enum(["Em instalação", "Ativo", "Encerrado"]),
  desired: z.enum(["Liberado", "Suspenso"]), observed: z.enum(["Sem leitura", "Conectado", "Desconectado"]),
  observedPlanId: id.nullable(), scheduledChange: changeSchema.nullable(), createdAt: z.iso.datetime(),
});
const invoice = z.object({ id, subscriberId: id, contractId: id, amount: cents, due: z.iso.date(), competence: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), paidAt: z.iso.datetime().nullable(), method: paymentMethod.nullable() });
const operation = z.object({
  id, contractId: id, kind: z.enum(["Provisionamento", "Reativação", "Suspensão", "Mudança de plano"]),
  status: z.enum(["Pendente", "Verificando", "Incerta", "Concluída", "Obsoleta"]),
  targetAccess: z.enum(["Liberado", "Suspenso"]), targetPlanId: id, reason: text,
  evidence: z.string().max(1500), createdAt: z.iso.datetime(),
});
const ticket = z.object({ id, subscriberId: id, subject: text, category: text, priority: z.enum(["Baixa", "Média", "Alta"]), channel: text, agent: z.string().max(120), status: ticketStatus, createdAt: z.iso.datetime(), notes: z.array(note) });
const order = z.object({ id, subscriberId: id, type: text, technician: z.string().trim().min(3).max(120), startAt: z.iso.datetime(), duration: z.number().int().min(15).max(480), status: orderStatus, result: z.string().max(1500), createdAt: z.iso.datetime() });
const event = z.object({ id, actorId: id, at: z.iso.datetime(), action: id, entityId: id, detail: z.string().max(2000) });
export const workspaceStateSchema = z.object({
  version: z.literal(1), clock: z.iso.datetime(), plans: z.array(plan), subscribers: z.array(subscriber),
  contracts: z.array(contract), invoices: z.array(invoice), operations: z.array(operation), tickets: z.array(ticket), orders: z.array(order), events: z.array(event),
});
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("plan.create"), input: planInputSchema }).strict(),
  z.object({ type: z.literal("plan.revise"), id, input: planInputSchema }).strict(),
  z.object({ type: z.literal("plan.availability"), id, active: z.boolean() }).strict(),
  z.object({ type: z.literal("subscriber.create"), input: subscriberInputSchema }).strict(),
  z.object({ type: z.literal("subscriber.edit"), id, input: subscriberEditSchema }).strict(),
  z.object({ type: z.literal("subscriber.note"), id, text }).strict(),
  z.object({ type: z.literal("contract.create"), input: contractInputSchema }).strict(),
  z.object({ type: z.literal("contract.schedule"), id, input: changeSchema }).strict(),
  z.object({ type: z.literal("contract.cancel-change"), id }).strict(),
  z.object({ type: z.literal("contract.access"), id, desired: z.enum(["Liberado", "Suspenso"]), reason: text }).strict(),
  z.object({ type: z.literal("invoice.pay"), id, method: paymentMethod }).strict(),
  z.object({ type: z.literal("operation.verify"), id }).strict(),
  z.object({ type: z.literal("operation.confirm"), id, evidence: z.string().trim().min(10).max(1500) }).strict(),
  z.object({ type: z.literal("operation.uncertain"), id, evidence: z.string().trim().min(10).max(1500) }).strict(),
  z.object({ type: z.literal("ticket.create"), input: ticket.pick({ subscriberId: true, subject: true, category: true, priority: true, channel: true }) }).strict(),
  z.object({ type: z.literal("ticket.transition"), id, status: ticketStatus, agent: z.string().trim().min(3).max(120), reason: text }).strict(),
  z.object({ type: z.literal("ticket.note"), id, text, visibility: z.enum(["Interna", "Resposta demonstrativa"]) }).strict(),
  z.object({ type: z.literal("order.create"), input: order.pick({ subscriberId: true, type: true, technician: true, startAt: true, duration: true }) }).strict(),
  z.object({ type: z.literal("order.reschedule"), id, startAt: z.iso.datetime(), technician: z.string().trim().min(3).max(120), duration: z.number().int().min(15).max(480), reason: text }).strict(),
  z.object({ type: z.literal("order.transition"), id, status: orderStatus, result: z.string().trim().min(10).max(1500) }).strict(),
  z.object({ type: z.literal("clock.advance") }).strict(),
]);
export type WorkspaceState = z.infer<typeof workspaceStateSchema>;
export type Command = z.infer<typeof commandSchema>;
export type SubscriberInput = z.infer<typeof subscriberInputSchema>;
export type ExecutionContext = { actorId: string; createId?: () => string };
