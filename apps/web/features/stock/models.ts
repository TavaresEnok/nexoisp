import { z } from "zod";
import { useSWRConfig } from "swr";

export const stockItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sku: z.string().nullable(),
  unit: z.string(),
  serialized: z.boolean(),
  min_qty: z.coerce.number(),
  active: z.boolean(),
  balance: z.coerce.number(),
  with_tech: z.coerce.number(),
  low: z.boolean(),
});
export type StockItem = z.infer<typeof stockItemSchema>;
export const stockUnitSchema = z.object({
  id: z.string().uuid(),
  serial: z.string(),
  status: z.enum([
    "in_stock",
    "with_tech",
    "installed",
    "defective",
    "written_off",
  ]),
  holder_id: z.string().nullable(),
  holder_name: z.string().nullable(),
  contract_id: z.string().nullable(),
  contract_mode: z.string().nullable(),
  subscriber_name: z.string().nullable(),
  work_order_id: z.string().nullable(),
  work_order_number: z.coerce.number().nullable(),
});
export type StockUnit = z.infer<typeof stockUnitSchema>;
export const movementSchema = z.object({
  id: z.union([z.string(), z.number()]),
  kind: z.string(),
  qty: z.coerce.number(),
  note: z.string().nullable(),
  created_at: z.string(),
  created_by_name: z.string().nullable(),
  work_order_id: z.string().nullable(),
  work_order_number: z.coerce.number().nullable(),
});
export const unitEventSchema = z.object({
  at: z.string(),
  event: z.string(),
  actor_name: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export const movementLabels: Record<string, string> = {
  in: "Entrada",
  out: "Saída",
  adjust: "Ajuste",
};
export const unitLabels: Record<StockUnit["status"], string> = {
  in_stock: "No almoxarifado",
  with_tech: "Com técnico",
  installed: "Instalada",
  defective: "Com defeito",
  written_off: "Baixada",
};
export function useStockRefresh() {
  const { mutate } = useSWRConfig();
  return async () => {
    await mutate(
      (key) =>
        key === "erp-stock-items" ||
        (Array.isArray(key) &&
          typeof key[0] === "string" &&
          [
            "erp-stock-units",
            "erp-stock-moves",
            "erp-stock-events",
            "erp-unit-search",
            "erp-contract-equipment",
          ].includes(key[0])),
    );
  };
}
