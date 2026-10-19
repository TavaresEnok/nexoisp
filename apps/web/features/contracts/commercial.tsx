import { useState } from "react";
import useSWR from "swr";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { RecordEditor } from "@/features/shared/record-editor";
import { EntityCustomFields } from "@/features/shared/custom-fields";
import { MutationForm, FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import type { ContractDetail } from "./models";
type Lookup = {
  id: string;
  name: string;
  active: boolean;
  is_default?: boolean;
};
export function ContractCommercial({
  contract,
  refresh,
}: {
  contract: ContractDetail;
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const writable = can(me, "contracts:write") && contract.status === "active";
  const pops = useSWR("erp-pops", () => api<Lookup[]>("/pops"));
  const companies = useSWR("erp-companies", () => api<Lookup[]>("/companies"));
  const [edit, setEdit] = useState(false);
  const [address, setAddress] = useState(false);
  const done = async () => {
    setEdit(false);
    setAddress(false);
    await refresh();
  };
  return (
    <div className="erp-stack">
      <ProfileSection
        title="Vínculos e área de atendimento"
        action={
          writable && (
            <Button variant="outline" size="sm" onClick={() => setEdit(true)}>
              Editar vínculos
            </Button>
          )
        }
      >
        <QueryBoundary
          loading={pops.isLoading || companies.isLoading}
          error={pops.error || companies.error}
          retry={() => Promise.all([pops.mutate(), companies.mutate()])}
        >
          <ProfileFacts
            items={[
              [
                "POP",
                pops.data?.find((pop) => pop.id === contract.pop_id)?.name ??
                  (contract.pop_id
                    ? "POP não disponível nesta consulta"
                    : "Sem POP"),
              ],
              [
                "Empresa faturadora",
                companies.data?.find(
                  (company) => company.id === contract.company_id,
                )?.name ??
                  companies.data?.find((company) => company.is_default)?.name ??
                  "Padrão do provedor",
              ],
              ["Área", contract.service_area === "rural" ? "Rural" : "Urbana"],
            ]}
          />
        </QueryBoundary>
        <p className="profile-footnote">
          A empresa é aplicada às faturas futuras; as faturas emitidas preservam
          seu vínculo.
        </p>
      </ProfileSection>
      <ProfileSection
        title="Endereço específico de instalação"
        action={
          writable && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddress(true)}
            >
              Editar instalação
            </Button>
          )
        }
      >
        <ProfileFacts
          items={[
            ["Logradouro", contract.install_street || "Não informado"],
            ["Número", contract.install_number || "—"],
            ["Bairro", contract.install_district || "—"],
            [
              "Cidade/UF",
              [contract.install_city, contract.install_state]
                .filter(Boolean)
                .join(" / ") || "—",
            ],
            ["CEP", contract.install_zip || "—"],
          ]}
        />
      </ProfileSection>
      <Tags contract={contract} refresh={refresh} />
      <EntityCustomFields
        entity="contract"
        id={contract.id}
        values={contract.custom ?? {}}
        refresh={refresh}
      />
      {edit && (
        <RecordEditor
          title="Editar vínculos do contrato"
          initial={{
            pop: contract.pop_id ?? "",
            company: contract.company_id ?? "",
            area: contract.service_area,
          }}
          fields={[
            {
              key: "pop",
              label: "POP",
              type: "select",
              options: [
                { value: "", label: "Sem POP" },
                ...(pops.data ?? [])
                  .filter((pop) => pop.active || pop.id === contract.pop_id)
                  .map((pop) => ({ value: pop.id, label: pop.name })),
              ],
            },
            {
              key: "company",
              label: "Empresa faturadora",
              type: "select",
              options: [
                { value: "", label: "Padrão do provedor" },
                ...(companies.data ?? [])
                  .filter(
                    (company) =>
                      company.active || company.id === contract.company_id,
                  )
                  .map((company) => ({
                    value: company.id,
                    label: company.name,
                  })),
              ],
            },
            {
              key: "area",
              label: "Área de atendimento",
              type: "select",
              options: [
                { value: "urban", label: "Urbana" },
                { value: "rural", label: "Rural" },
              ],
            },
          ]}
          onClose={() => setEdit(false)}
          onSubmit={async (values) => {
            try {
              if ((contract.pop_id ?? "") !== values.pop)
                await api(`/contracts/${contract.id}/pop`, {
                  method: "PUT",
                  body: { pop_id: values.pop || null },
                });
              if ((contract.company_id ?? "") !== values.company)
                await api(`/contracts/${contract.id}/company`, {
                  method: "PUT",
                  body: { company_id: values.company || null },
                });
              if (contract.service_area !== values.area)
                await api(`/contracts/${contract.id}/service-area`, {
                  method: "PUT",
                  body: { service_area: values.area },
                });
              setEdit(false);
            } finally {
              await refresh();
            }
          }}
        />
      )}
      {address && (
        <RecordEditor
          title="Endereço de instalação"
          initial={{
            street: contract.install_street ?? "",
            number: contract.install_number ?? "",
            district: contract.install_district ?? "",
            city: contract.install_city ?? "",
            state: contract.install_state ?? "",
            zip: contract.install_zip ?? "",
          }}
          fields={[
            { key: "street", label: "Logradouro" },
            { key: "number", label: "Número" },
            { key: "district", label: "Bairro" },
            { key: "city", label: "Cidade" },
            { key: "state", label: "UF", maxLength: 2 },
            { key: "zip", label: "CEP" },
          ]}
          onClose={() => setAddress(false)}
          onSubmit={async (values) => {
            await api(`/contracts/${contract.id}/install-address`, {
              method: "PUT",
              body: Object.fromEntries(
                Object.entries(values).map(([key, value]) => [
                  key,
                  value || null,
                ]),
              ),
            });
            await done();
          }}
        />
      )}
    </div>
  );
}
function Tags({
  contract,
  refresh,
}: {
  contract: ContractDetail;
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const [editing, setEditing] = useState(false);
  const catalog = useSWR(editing ? "erp-tags" : null, () =>
    api<{ id: string; name: string }[]>("/tags"),
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  return (
    <ProfileSection
      title="Etiquetas"
      action={
        can(me, "contracts:write") && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelected(contract.tags.map((tag) => tag.id));
              setEditing(true);
            }}
          >
            Editar etiquetas
          </Button>
        )
      }
    >
      <div className="erp-inline-actions">
        {contract.tags.length ? (
          contract.tags.map((tag) => (
            <Badge key={tag.id} variant="outline">
              {tag.name}
            </Badge>
          ))
        ) : (
          <p className="profile-footnote">Sem etiquetas.</p>
        )}
      </div>
      {editing && (
        <Dialog open onOpenChange={setEditing}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Etiquetas do contrato</DialogTitle>
              <DialogDescription>
                Selecione as etiquetas que identificam este vínculo.
              </DialogDescription>
            </DialogHeader>
            <QueryBoundary
              loading={catalog.isLoading}
              error={catalog.error}
              retry={() => catalog.mutate()}
            >
              <MutationForm
                onCancel={() => setEditing(false)}
                onSubmit={async () => {
                  await api(`/contracts/${contract.id}/tags`, {
                    method: "PUT",
                    body: { tag_ids: selected },
                  });
                  setEditing(false);
                  await refresh();
                }}
              >
                <div className="erp-stack">
                  {catalog.data?.map((tag) => (
                    <Label className="erp-inline-actions" key={tag.id}>
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={selected.includes(tag.id)}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, tag.id]
                              : selected.filter((id) => id !== tag.id),
                          )
                        }
                      />
                      {tag.name}
                    </Label>
                  ))}
                </div>
                <FormField label="Nova etiqueta">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </FormField>
                <ActionButton
                  disabled={name.trim().length < 2}
                  onClick={async () => {
                    const tag = await api<{ id: string }>("/tags", {
                      body: { name: name.trim() },
                    });
                    setName("");
                    setSelected((current) => [...current, tag.id]);
                    await catalog.mutate();
                  }}
                >
                  Criar etiqueta
                </ActionButton>
              </MutationForm>
            </QueryBoundary>
          </DialogContent>
        </Dialog>
      )}
    </ProfileSection>
  );
}
