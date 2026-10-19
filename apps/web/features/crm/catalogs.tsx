import useSWR from "swr";
import { z } from "zod";
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
const catalog = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  active: z.boolean(),
});
export function useTicketCatalogs() {
  return useSWR("erp-all-catalogs", async () =>
    z.array(catalog).parse(await api("/catalogs?all=1")),
  );
}
export function TicketCatalogFields({
  values,
  onChange,
}: {
  values: { type_id: string; classification_id: string; origin_id: string };
  onChange: (values: {
    type_id: string;
    classification_id: string;
    origin_id: string;
  }) => void;
}) {
  const result = useTicketCatalogs();
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      <div className="erp-columns">
        {(
          [
            {
              key: "type_id",
              kind: "ticket_type",
              label: "Tipo de ocorrência",
            },
            {
              key: "classification_id",
              kind: "classification",
              label: "Classificação da ocorrência",
            },
            { key: "origin_id", kind: "origin", label: "Origem da ocorrência" },
          ] as const
        ).map((field) => (
          <FormField key={field.key} label={field.label}>
            <select
              className="commercial-select"
              value={values[field.key]}
              onChange={(event) =>
                onChange({ ...values, [field.key]: event.target.value })
              }
            >
              <option value="">Sem classificação</option>
              {result.data
                ?.filter((item) => item.kind === field.kind && item.active)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </FormField>
        ))}
      </div>
    </QueryBoundary>
  );
}
