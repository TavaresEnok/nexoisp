import useSWR from "swr";
import { erpClient } from "@/platform/erp-client";

/** Contagem por aba de situação, com os mesmos filtros da lista e uma linha por consulta. */
export function useStatusCounts(
  key: string,
  endpoint: string,
  filters: URLSearchParams,
  statuses: Record<string, string>,
  enabled = true,
) {
  const base = new URLSearchParams(filters);
  base.delete("status");
  const signature = `${endpoint}?${base}`;
  return useSWR(enabled ? [key, "counts", signature] : null, async () => {
    const entries = await Promise.all(
      Object.entries(statuses).map(async ([label, status]) => {
        const query = new URLSearchParams(base);
        if (status) query.set("status", status);
        const response = await erpClient.request(
          `${endpoint}?${query}&limit=1`,
        );
        return [label, response.total ?? 0] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<string, number>;
  }).data;
}
