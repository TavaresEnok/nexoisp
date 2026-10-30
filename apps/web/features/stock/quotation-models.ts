import { z } from "zod";
import { api } from "@/platform/erp-client";

const id = z.string().uuid();
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const status = z.enum(["draft", "converted", "canceled"]);
export const quotationListSchema = z.object({ items: z.array(z.object({ id, title: z.string(), status, created_at: z.string(), offers_count: z.number().int().nonnegative(), purchase_order_id: id.nullable() })), truncated: z.boolean() });
export const quotationSchema = z.object({ id, title: z.string(), note: z.string(), status, created_at: z.string(), purchase_order_id: id.nullable(), items: z.array(z.object({ item_id: id, item_name: z.string(), unit: z.string(), qty: z.number().int().min(1).max(1000000) })).min(1).max(30), offers: z.array(z.object({ id, supplier_id: id, supplier_name: z.string(), note: z.string(), created_at: z.string(), prices: z.array(z.object({ item_id: id, unit_cost_cents: amount.max(100000000) })), total_cents: amount })).max(10) }).superRefine((quote, ctx) => { const ids = new Set(quote.items.map(i => i.item_id)); if (ids.size !== quote.items.length) ctx.addIssue({code: "custom", message: "Itens duplicados na cotação."}); for (const offer of quote.offers) { const prices = new Set(offer.prices.map(p => p.item_id)); if (prices.size !== ids.size || offer.prices.length !== ids.size || [...prices].some(id => !ids.has(id))) ctx.addIssue({code: "custom", message: "Oferta incompleta ou inválida."}); } });
export type Quotation = z.infer<typeof quotationSchema>;
export const quotationsApi = {
  list: async () => quotationListSchema.parse(await api("/stock/quotations")),
  detail: async (id: string) => quotationSchema.parse(await api(`/stock/quotations/${id}`)),
  create: async (body: {title: string; note: string; items: {item_id: string; qty: number}[]}) => quotationSchema.parse(await api("/stock/quotations", {method: "POST", body})),
  offer: async (id: string, body: {supplier_id: string; note: string; prices: {item_id: string; unit_cost_cents: number}[]}) => quotationSchema.parse(await api(`/stock/quotations/${id}/offers`, {method: "POST", body})),
  removeOffer: async (id: string, offer: string) => api(`/stock/quotations/${id}/offers/${offer}`, {method: "DELETE"}),
  cancel: async (id: string, reason: string) => quotationSchema.parse(await api(`/stock/quotations/${id}/cancel`, {method: "POST", body: {reason}})),
  purchase: async (id: string, body: {offer_id: string; warehouse_id: string | null; expected_at: string | null}) => z.object({purchase_order_id: idSchema, number: z.number().int().positive()}).parse(await api(`/stock/quotations/${id}/purchase`, {method: "POST", body})),
};
const idSchema = id;
export function integerInput(value: string, min: number, max: number): number { if (!/^\d+$/.test(value)) throw new Error("Informe um número inteiro válido."); const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Informe um valor entre ${min} e ${max}.`); return n; }
export function priceInput(value: string): number { const match = /^(\d+)(?:[,.](\d{1,2}))?$/.exec(value); if (!match) throw new Error("Informe um preço válido com até duas casas decimais."); const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0"); if (cents > 100000000n) throw new Error("Preço unitário acima do limite."); return Number(cents); }
