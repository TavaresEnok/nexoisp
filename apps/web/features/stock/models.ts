import { z } from "zod";
import useSWR, { useSWRConfig } from "swr";
import { cents } from "@/features/shared/schema";
import { api } from "@/platform/erp-client";

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
  warehouse_name: z.string().optional(),
  purchase_order_number: z.number().nullable().optional(),
});
export const warehouseSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  active: z.boolean(),
});
export type Warehouse = z.infer<typeof warehouseSchema>;
export const unitEventSchema = z.object({
  at: z.string(),
  event: z.string(),
  actor_name: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
});
// Custo médio global por material; valor por depósito = saldo × custo médio.
export const valuationSchema = z.object({
  total_cents: cents(),
  warehouses: z.array(
    z.object({
      warehouse_id: z.string().nullable(),
      name: z.string(),
      items: z.number(),
      value_cents: cents(),
    }),
  ),
  lines: z.array(
    z.object({
      warehouse_id: z.string().nullable(),
      warehouse_name: z.string(),
      item_id: z.string(),
      item_name: z.string(),
      unit: z.string(),
      qty: z.number(),
      avg_cost_cents: cents(),
      value_cents: cents(),
    }),
  ),
  items: z.array(
    z.object({
      item_id: z.string(),
      name: z.string(),
      unit: z.string(),
      active: z.boolean(),
      avg_cost_cents: cents(),
      balance: z.number(),
      value_cents: cents(),
    }),
  ),
});
export type StockValuation = z.infer<typeof valuationSchema>;
export const useStockValuation = () =>
  useSWR("erp-stock-valuation", async () =>
    valuationSchema.parse(await api("/stock/valuation")),
  );
export const itemCostsSchema = z.object({
  avg_cost_cents: cents(),
  balance: z.number(),
  value_cents: cents(),
  movements: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      unit_cost_cents: cents(),
      avg_cost_cents: cents(),
      cost_source: z.enum(["entry", "average"]),
      value_cents: cents(),
    }),
  ),
});
export const movementLabels: Record<string, string> = {
  in: "Entrada",
  out: "Saída",
  adjust: "Ajuste",
  transfer: "Transferência",
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
        key === "erp-stock-valuation" ||
        (Array.isArray(key) &&
          typeof key[0] === "string" &&
          [
            "erp-stock-units",
            "erp-stock-moves",
            "erp-stock-costs",
            "erp-stock-events",
            "erp-unit-search",
            "erp-contract-equipment",
          ].includes(key[0])),
    );
  };
}
