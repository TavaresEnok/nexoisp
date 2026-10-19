import type { NetworkNode, Subscriber } from "../../lib/types";
import { normalize } from "../../domain/formatters";
import { hasLocation, matchesNetwork, type NetworkFilters } from "../../lib/network-query";

export function selectNetworkNodes(nodes: readonly NetworkNode[], status: string, query: string) {
  return nodes.filter(n => (status === "Todos" || n.status === status) && normalize(`${n.name} ${n.pop} ${n.ip} ${n.type}`).includes(normalize(query)));
}
export function selectMapSubscribers(subscribers: readonly Subscriber[], filters: NetworkFilters, query: string) {
  const rows = subscribers.filter(s => matchesNetwork(s, filters, query));
  return { rows, located: rows.filter(hasLocation), online: rows.filter(s => s.connection === "Online").length };
}
