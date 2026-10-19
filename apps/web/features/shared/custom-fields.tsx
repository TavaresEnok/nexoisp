import { useState } from "react";
import useSWR from "swr";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { QueryBoundary } from "./feedback";
import { MutationForm, FormField } from "./form";
import { api } from "@/platform/erp-client";
type Definition = {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
};
export function EntityCustomFields({
  entity,
  id,
  values,
  refresh,
}: {
  entity: "subscriber" | "contract";
  id: string;
  values: Record<string, unknown>;
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const definitions = useSWR(`erp-${entity}-fields`, () =>
    api<Definition[]>(`/custom-fields?entity=${entity}`),
  );
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  if (!definitions.data?.length && !definitions.error) return null;
  return (
    <ProfileSection
      title="Campos personalizados"
      action={
        can(
          me,
          entity === "subscriber" ? "subscribers:write" : "contracts:write",
        ) &&
        !editing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing({ ...values })}
          >
            Editar campos
          </Button>
        )
      }
    >
      <QueryBoundary
        error={definitions.error}
        loading={definitions.isLoading}
        retry={() => definitions.mutate()}
      >
        {editing ? (
          <MutationForm
            onCancel={() => setEditing(null)}
            onSubmit={async () => {
              const changes: Record<string, unknown> = {};
              for (const def of definitions.data ?? []) {
                const next =
                  editing[def.key] === "" || editing[def.key] === undefined
                    ? null
                    : editing[def.key];
                if ((values[def.key] ?? null) !== next) changes[def.key] = next;
              }
              if (Object.keys(changes).length)
                await api(
                  `/${entity === "subscriber" ? "subscribers" : "contracts"}/${id}/custom`,
                  { method: "PUT", body: { values: changes } },
                );
              setEditing(null);
              await refresh();
            }}
          >
            {definitions.data?.map((def) => (
              <FormField key={def.key} label={def.label}>
                {["select", "boolean"].includes(def.type) ? (
                  <select
                    className="commercial-select"
                    required={def.required}
                    value={
                      editing[def.key] == null ? "" : String(editing[def.key])
                    }
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        [def.key]:
                          def.type === "boolean"
                            ? e.target.value === ""
                              ? null
                              : e.target.value === "true"
                            : e.target.value,
                      })
                    }
                  >
                    <option value="">—</option>
                    {(def.type === "boolean"
                      ? ["true", "false"]
                      : def.options
                    ).map((option) => (
                      <option key={option} value={option}>
                        {def.type === "boolean"
                          ? option === "true"
                            ? "Sim"
                            : "Não"
                          : option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={
                      def.type === "number"
                        ? "number"
                        : def.type === "date"
                          ? "date"
                          : "text"
                    }
                    required={def.required}
                    value={String(editing[def.key] ?? "")}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        [def.key]:
                          def.type === "number"
                            ? e.target.value === ""
                              ? null
                              : Number(e.target.value)
                            : e.target.value,
                      })
                    }
                  />
                )}
              </FormField>
            ))}
          </MutationForm>
        ) : (
          <ProfileFacts
            items={(definitions.data ?? []).map((def) => [
              def.label,
              values[def.key] == null
                ? "—"
                : typeof values[def.key] === "boolean"
                  ? values[def.key]
                    ? "Sim"
                    : "Não"
                  : String(values[def.key]),
            ])}
          />
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}
