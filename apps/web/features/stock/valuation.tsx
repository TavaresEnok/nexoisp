import { useState } from "react";
import { OperationalCatalog } from "@/components/operational-catalog";
import { QueryBoundary } from "@/features/shared/feedback";
import { FormField } from "@/features/shared/form";
import { money } from "@/lib/format";
import { useStockValuation } from "./models";

// Relatório de valor do estoque por depósito, calculado pelo servidor com o
// custo médio ponderado global de cada material.
export function StockValuationReport() {
  const valuation = useStockValuation();
  const [place, setPlace] = useState("");
  const data = valuation.data;
  const lines = (data?.lines ?? []).filter(
    (line) => !place || (line.warehouse_id ?? "principal") === place,
  );
  return (
    <QueryBoundary
      loading={valuation.isLoading}
      error={valuation.error}
      retry={() => valuation.mutate()}
    >
      <div className="erp-stack">
        <OperationalCatalog
          title="Valor do estoque por depósito"
          description={`Total ${money((data?.total_cents ?? 0) / 100)}. Saldo de cada depósito multiplicado pelo custo médio ponderado do material, que é único para todos os depósitos.`}
          columns={["Depósito", "Materiais com saldo", "Valor do estoque"]}
          rows={(data?.warehouses ?? []).map((warehouse) => ({
            id: warehouse.warehouse_id ?? "principal",
            cells: [
              warehouse.name,
              warehouse.items,
              money(warehouse.value_cents / 100),
            ],
          }))}
          empty="Nenhum material com saldo."
        />
        <OperationalCatalog
          title="Materiais valorizados"
          description="Entradas com custo recalculam o custo médio; saídas, ajustes e transferências usam o custo médio vigente."
          columns={[
            "Depósito",
            "Material",
            "Saldo",
            "Custo médio",
            "Valor do estoque",
          ]}
          actions={
            <FormField label="Depósito do relatório">
              <select
                className="commercial-select"
                value={place}
                onChange={(event) => setPlace(event.target.value)}
              >
                <option value="">Todos os depósitos</option>
                {(data?.warehouses ?? []).map((warehouse) => (
                  <option
                    key={warehouse.warehouse_id ?? "principal"}
                    value={warehouse.warehouse_id ?? "principal"}
                  >
                    {warehouse.name}
                  </option>
                ))}
              </select>
            </FormField>
          }
          rows={lines.map((line) => ({
            id: `${line.warehouse_id ?? "principal"}-${line.item_id}`,
            cells: [
              line.warehouse_name,
              line.item_name,
              `${line.qty} ${line.unit}`,
              money(line.avg_cost_cents / 100),
              money(line.value_cents / 100),
            ],
          }))}
          empty="Nenhum material com saldo neste depósito."
        />
      </div>
    </QueryBoundary>
  );
}
