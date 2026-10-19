import type { Subscriber } from "../../lib/types";
import { matchesSubscriber } from "../../lib/subscriber-search";

export function selectSubscribers(subscribers: readonly Subscriber[], filters: { status: string; connection: string; query: string; sortAsc: boolean }) {
  return subscribers.filter(s => (filters.status === "Todos" || s.status === filters.status) && (filters.connection === "Todas" || s.connection === filters.connection) && matchesSubscriber(s, filters.query))
    .sort((a, b) => filters.sortAsc ? a.name.localeCompare(b.name, "pt-BR") : b.name.localeCompare(a.name, "pt-BR"));
}
