import { money } from "../domain/formatters";
import { getSubscriberProfile } from "./subscriber-profile";
import type { Subscriber, WorkspaceData } from "./types";

export type HistoryEntry = { id: string; at: string; title: string; description: string; precision: "instant" | "date" };
export function getSubscriberHistory(subscriber: Subscriber, data: WorkspaceData) {
  const profile = getSubscriberProfile(subscriber, data);
  const scenarioDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(data.snapshot.asOf));
  const dated: HistoryEntry[] = [
    ...profile.activities.map(a => ({ id: a.id, at: `${scenarioDay}T${a.time}:00-03:00`, title: a.title, description: a.description, precision: "instant" as const })),
    ...profile.tickets.map(t => ({ id: t.id, at: t.opened, title: `Abertura do atendimento #${t.code}`, description: `${t.subject} · situação atual: ${t.status}`, precision: t.opened.includes("T") ? "instant" as const : "date" as const })),
    ...profile.invoices.map(i => ({ id: i.id, at: i.due, title: `Vencimento do título ${i.code}`, description: `${i.reference} · ${money(i.amount)} · situação atual: ${i.status}. Não representa a data do pagamento.`, precision: "date" as const })),
    { id: `since-${subscriber.id}`, at: subscriber.since, title: `Início do contrato ${subscriber.contract}`, description: `${subscriber.plan} · ${money(subscriber.price)} / mês`, precision: "date" },
  ];
  dated.sort((a, b) => b.at.slice(0, 10).localeCompare(a.at.slice(0, 10)) || (a.precision === b.precision ? a.precision === "instant" ? new Date(b.at).getTime() - new Date(a.at).getTime() : a.id.localeCompare(b.id) : a.precision === "instant" ? -1 : 1));
  return { dated, undatedOrders: profile.orders };
}
