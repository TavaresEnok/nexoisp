import { querySections, type NetworkFilters } from "./network-query";

export const networkFilterKeys = [...querySections.flatMap(section => section.fields.map(([key]) => key)), "visibility"] as const;
const booleanKeys = new Set(["ipv6", "ipv6Pd", "onu", "fixedIp"]);

export function readNetworkFilters(params: Pick<URLSearchParams, "get">, initial: NetworkFilters): NetworkFilters {
  const filters = { ...initial };
  for (const key of networkFilterKeys) {
    const raw = params.get(`rede_${key}`);
    if (raw === null) continue;
    const value = raw.slice(0, 500);
    if (key === "visibility" && !["all", "online", "offline"].includes(value)) continue;
    if (booleanKeys.has(key) && value !== "" && !["yes", "no"].includes(value)) continue;
    filters[key] = value;
  }
  return filters;
}
