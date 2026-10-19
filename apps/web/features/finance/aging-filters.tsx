import useSWR from "swr";
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";

export type AgingFilterValues = {
  plan_id: string;
  pop_id: string;
  tag: string;
};
type Named = { id: string; name: string };
export function AgingFilters({
  values,
  onChange,
}: {
  values: AgingFilterValues;
  onChange: (values: AgingFilterValues) => void;
}) {
  const result = useSWR("erp-aging-options", async () => {
    const [plans, pops, tags] = await Promise.all([
      api<Named[]>("/plans"),
      api<Named[]>("/pops"),
      api<Named[]>("/tags"),
    ]);
    return { plan_id: plans, pop_id: pops, tag: tags };
  });
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      <div className="erp-columns">
        {(
          [
            ["plan_id", "Plano da carteira"],
            ["pop_id", "POP da carteira"],
            ["tag", "Etiqueta da carteira"],
          ] as const
        ).map(([key, label]) => (
          <FormField key={key} label={label}>
            <select
              className="commercial-select"
              value={values[key]}
              onChange={(event) =>
                onChange({ ...values, [key]: event.target.value })
              }
            >
              <option value="">Todos</option>
              {result.data?.[key].map((row) => (
                <option value={row.id} key={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </FormField>
        ))}
      </div>
    </QueryBoundary>
  );
}
