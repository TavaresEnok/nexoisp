import { matchesNetwork, validIpQuery } from "./network-query";
import type { Subscriber } from "./types";

export function parseIpTargets(value: string): { targets: string[]; error?: string } {
  const targets = [...new Set(value.split(/[\s,;]+/).filter(Boolean))];
  if (!targets.length) return { targets, error: "Informe pelo menos um endereço IPv4 ou bloco CIDR." };
  if (targets.length > 100) return { targets, error: "Consulte no máximo 100 endereços ou blocos por vez." };
  if (targets.some(target => !validIpQuery(target))) return { targets, error: "Há um endereço inválido. Utilize IPv4 ou bloco CIDR, como 100.64.0.0/16." };
  return { targets };
}

export function findCurrentIpAssignments(subscribers: Subscriber[], targets: string[], onlineOnly: boolean) {
  return subscribers.filter(s => targets.some(ip => matchesNetwork(s, { ip, ...(onlineOnly ? { visibility: "online" } : {}) })));
}
