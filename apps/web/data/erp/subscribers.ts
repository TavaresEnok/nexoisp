import { z } from "zod";
import { erpClient, api } from "@/platform/erp-client";
import { subscriberRecordSchema, subscriberDetailSchema, subscriberCommand, type SubscriberInput } from "@/features/subscribers/model";
export function subscriberQuery({ query, status, page, pageSize = 8, descending = false }: { query: string; status: string; page: number; pageSize?: number; descending?: boolean }) {
  const params = new URLSearchParams({ q: query, limit: String(pageSize), offset: String(page * pageSize) });
  if (status) params.set("status", status);
  if (descending) params.set("order", "desc");
  return `/subscribers?${params}`;
}
export async function readSubscribers(path: string) {
 const result = await erpClient.request<unknown>(path); const rows = z.array(subscriberRecordSchema).parse(result.data);
 if (result.total === null) throw new Error("O servidor não informou a contagem de assinantes.");
 return { rows, total: result.total };
}
export async function readSubscriber(id: string) { return subscriberDetailSchema.parse(await api(`/subscribers/${encodeURIComponent(id)}`)); }
export async function saveSubscriber(input: SubscriberInput, id?: string) { return subscriberRecordSchema.parse(await api(id ? `/subscribers/${id}` : "/subscribers", { method: id ? "PATCH" : "POST", body: subscriberCommand(input) })); }
