import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { PageHeading } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
const companySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  document: z.string().nullable(),
  contracts: z.coerce.number(),
  active: z.boolean(),
  is_default: z.boolean(),
});
export function CompanyDirectory() {
  const { me } = useSession();
  const { mutate } = useSWRConfig();
  const result = useSWR("erp-companies", async () =>
    z.array(companySchema).parse(await api("/companies")),
  );
  const [creating, setCreating] = useState(false);
  const write = can(me, "settings:manage");
  const refresh = async () => {
    await Promise.all([
      result.mutate(),
      mutate(
        (key) =>
          Array.isArray(key) &&
          ["erp-contract", "erp-contracts", "erp-invoices"].includes(key[0]),
      ),
    ]);
  };
  return (
    <>
      <PageHeading
        title="Empresas faturadoras"
        description="CNPJs de matriz e filiais. A fatura conserva a empresa do contrato na emissão."
        actions={
          write && (
            <Button onClick={() => setCreating(true)}>
              Nova empresa faturadora
            </Button>
          )
        }
      />
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Empresas do provedor"
          description="Sem empresa cadastrada, o provedor fatura por um único CNPJ. Faturas emitidas não mudam quando a empresa padrão é alterada."
          columns={["Empresa", "CNPJ", "Contratos", "Situação"]}
          rows={(result.data ?? []).map((company) => ({
            id: company.id,
            cells: [
              <>
                <strong>{company.name}</strong>
                {company.is_default && <Badge variant="outline">Padrão</Badge>}
              </>,
              company.document || "Não informado",
              company.contracts,
              company.active ? "Ativa" : "Inativa",
            ],
            actions: write && !company.is_default && (
              <div className="erp-inline-actions">
                {company.active && (
                  <ActionButton
                    onClick={async () => {
                      await api(`/companies/${company.id}`, {
                        method: "PATCH",
                        body: { is_default: true },
                      });
                      await refresh();
                    }}
                  >
                    Tornar padrão
                  </ActionButton>
                )}
                <ActionButton
                  onClick={async () => {
                    await api(`/companies/${company.id}`, {
                      method: "PATCH",
                      body: { active: !company.active },
                    });
                    await refresh();
                  }}
                >
                  {company.active ? "Desativar empresa" : "Ativar empresa"}
                </ActionButton>
              </div>
            ),
          }))}
        />
      </QueryBoundary>
      {creating && (
        <RecordEditor
          title="Nova empresa faturadora"
          initial={{ name: "", document: "" }}
          fields={[
            {
              key: "name",
              label: "Nome da empresa",
              required: true,
              maxLength: 120,
            },
            {
              key: "document",
              label: "CNPJ da empresa",
              maxLength: 18,
              hint: "Opcional. Se informado, use quatorze dígitos.",
            },
          ]}
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            await api("/companies", {
              body: { name: values.name, document: values.document },
            });
            setCreating(false);
            await refresh();
          }}
        />
      )}
    </>
  );
}
