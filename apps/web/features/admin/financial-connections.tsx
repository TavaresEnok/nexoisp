import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { RecordEditor } from "@/features/shared/record-editor";
import { api } from "@/platform/erp-client";

const providers = [
  ["demo", "Demonstração"],
  ["efi", "Efí / sejaefi"],
  ["asaas", "Asaas"],
  ["inter", "Inter"],
  ["sicredi", "Sicredi"],
  ["mercado_pago", "Mercado Pago"],
  ["pagbank", "PagBank / PagSeguro"],
  ["stripe", "Stripe"],
  ["kobana", "Kobana (alternativa)"],
  ["shipay", "Shipay (alternativa)"],
  ["tuna", "Tuna (alternativa)"],
];
const schema = z.object({
  id: z.string(),
  company_id: z.string().nullable(),
  provider: z.string(),
  environment: z.string(),
  account_ref: z.string(),
  name: z.string(),
  status: z.string(),
  is_default: z.boolean(),
  legacy_demo: z.boolean(),
  has_webhook_secret: z.boolean(),
});
export function FinancialConnections() {
  const result = useSWR("erp-financial-connections", async () =>
    z.array(schema).parse(await api("/financial-connections")),
  );
  const companies = useSWR("erp-financial-connection-companies", async () =>
    z
      .array(z.object({ id: z.string(), name: z.string() }))
      .parse(await api("/companies")),
  );
  const pending = useSWR("erp-financial-connection-pending", async () =>
    z
      .array(
        z.object({
          entity: z.string(),
          id: z.string(),
          provider: z.string().nullable(),
          reason: z.string(),
        }),
      )
      .parse(await api("/financial-connections/pending")),
  );
  const [creating, setCreating] = useState(false);
  return (
    <>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Conexões financeiras"
          description="Uma conexão identifica empresa, conta e ambiente. Cadastrar um fornecedor não habilita cobrança real; apenas a demonstração sandbox pode ser ativada."
          columns={[
            "Nome",
            "Empresa",
            "Fornecedor",
            "Ambiente",
            "Conta",
            "Situação",
            "Padrão",
            "Credencial",
          ]}
          actions={
            <Button onClick={() => setCreating(true)}>
              Nova conexão financeira
            </Button>
          }
          rows={(result.data ?? []).map((item) => ({
            id: item.id,
            cells: [
              item.name,
              companies.data?.find((c) => c.id === item.company_id)?.name ??
                item.company_id ??
                "Sem empresa vinculada",
              providers.find(([id]) => id === item.provider)?.[1] ??
                item.provider,
              item.environment === "production" ? "Produção" : "Sandbox",
              item.account_ref,
              { active: "Ativa", disabled: "Desativada", pending: "Pendente" }[
                item.status
              ] ?? item.status,
              item.is_default ? "Sim" : "Não",
              item.has_webhook_secret
                ? "Configurada"
                : item.legacy_demo
                  ? "Demonstração preservada"
                  : "Não configurada",
            ],
            actions: (
              <>
                <ActionButton
                  confirm={`${item.status === "active" ? "Desativar" : "Ativar"} ${item.name}? As referências financeiras existentes serão preservadas.`}
                  onClick={async () => {
                    await api(`/financial-connections/${item.id}`, {
                      method: "PATCH",
                      body: {
                        status:
                          item.status === "active" ? "disabled" : "active",
                      },
                    });
                    await result.mutate();
                  }}
                >
                  {item.status === "active" ? "Desativar" : "Ativar"}
                </ActionButton>
                {!item.is_default && (
                  <ActionButton
                    confirm={`Usar ${item.name} nas próximas cobranças desta empresa e fornecedor? As cobranças anteriores mantêm a conexão original.`}
                    onClick={async () => {
                      await api(`/financial-connections/${item.id}`, {
                        method: "PATCH",
                        body: { status: item.status, is_default: true },
                      });
                      await result.mutate();
                    }}
                  >
                    Usar como padrão
                  </ActionButton>
                )}
              </>
            ),
          }))}
        />
      </QueryBoundary>
      <QueryBoundary
        loading={pending.isLoading}
        error={pending.error}
        retry={() => pending.mutate()}
      >
        <OperationalCatalog
          title="Vínculos financeiros pendentes"
          description="Registros antigos sem origem de conta comprovada permanecem bloqueados para associação automática. A revisão deve preservar os identificadores e os recebimentos."
          columns={["Registro", "Identificador", "Fornecedor", "Motivo"]}
          rows={(pending.data ?? []).map((item) => ({
            id: `${item.entity}:${item.id}`,
            cells: [
              {
                invoice: "Fatura",
                payment: "Pagamento",
                event: "Evento",
                demo_charge: "Cobrança demonstrativa",
              }[item.entity] ?? item.entity,
              item.id,
              item.provider ?? "Não identificado",
              item.reason === "invoice_not_found"
                ? "Fatura não localizada"
                : "Conta de origem não comprovada",
            ],
          }))}
        />
      </QueryBoundary>
      {creating && (
        <RecordEditor
          title="Nova conexão financeira"
          description="A identidade da conexão não pode ser alterada depois do cadastro. O segredo não será exibido na listagem. A conta é uma referência, nunca uma senha."
          initial={{
            name: "",
            company_id: "",
            provider: "demo",
            environment: "sandbox",
            account_ref: "",
            is_default: "false",
            webhook_secret: "",
          }}
          loading={companies.isLoading}
          error={companies.error}
          retry={() => companies.mutate()}
          fields={[
            {
              key: "name",
              label: "Nome da conexão",
              required: true,
              maxLength: 120,
            },
            {
              key: "company_id",
              label: "Empresa da conexão",
              type: "select",
              options: [
                { value: "", label: "Sem empresa vinculada" },
                ...(companies.data ?? []).map((c) => ({
                  value: c.id,
                  label: c.name,
                })),
              ],
            },
            {
              key: "provider",
              label: "Fornecedor",
              type: "select",
              options: providers.map(([value, label]) => ({ value, label })),
            },
            {
              key: "environment",
              label: "Ambiente",
              type: "select",
              options: [
                { value: "sandbox", label: "Sandbox" },
                { value: "production", label: "Produção (cadastro apenas)" },
              ],
            },
            {
              key: "account_ref",
              label: "Referência da conta",
              required: true,
              maxLength: 120,
            },
            {
              key: "is_default",
              label: "Padrão para esta empresa e fornecedor",
              type: "select",
              options: [
                { value: "false", label: "Não" },
                { value: "true", label: "Sim" },
              ],
            },
            {
              key: "webhook_secret",
              label: "Segredo do webhook demonstrativo",
              type: "password",
              when: (v) => v.provider === "demo",
              hint: "Ao menos 32 caracteres para permitir a ativação sandbox.",
            },
          ]}
          onClose={() => setCreating(false)}
          submit="Cadastrar conexão"
          onSubmit={async (values) => {
            await api("/financial-connections", {
              body: {
                name: values.name,
                company_id: values.company_id || null,
                provider: values.provider,
                environment: values.environment,
                account_ref: values.account_ref,
                is_default: values.is_default === "true",
                ...(values.provider === "demo" && values.webhook_secret
                  ? { webhook_secret: values.webhook_secret }
                  : {}),
              },
            });
            setCreating(false);
            await result.mutate();
          }}
        />
      )}
    </>
  );
}
