import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api, download } from "@/platform/erp-client";
const city = z.object({
  city: z.string().nullable(),
  state: z.string().nullable(),
  contratos: z.coerce.number(),
});
const plan = z.object({ id: z.string(), name: z.string() });
const report = z.object({
  rows: z.array(
    z.object({
      cnpj: z.string(),
      ibge_code: z.string(),
      tipo_cliente: z.string(),
      tipo_atendimento: z.string(),
      meio: z.string(),
      tecnologia: z.string(),
      velocidade_mbps: z.coerce.number(),
      acessos: z.coerce.number(),
    }),
  ),
  pending: z.object({
    sem_cnpj: z.coerce.number(),
    sem_municipio: z.coerce.number(),
    total: z.coerce.number(),
    cities_without_code: z.array(city),
    plans_without_technology: z.array(plan),
  }),
});
const technologies: Record<string, string> = {
  FTTH: "FTTH · fibra até a casa",
  FTTB: "FTTB · fibra até o prédio",
  HFC: "HFC · cabo coaxial",
  XDSL: "xDSL · par metálico",
  ETHERNET: "Ethernet",
  RADIO: "Rádio",
  LTE: "LTE/4G",
  SATELITE: "Satélite",
  OUTRA: "Outra",
};
export function AnatelCollection() {
  const [competence, setCompetence] = useState(() => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.toISOString().slice(0, 7);
  });
  const [draft, setDraft] = useState(competence);
  const path = `/anatel/dici?competence=${competence}`;
  const result = useSWR(["erp-anatel", competence], async () =>
    report.parse(await api(path)),
  );
  const { mutate } = useSWRConfig();
  const [editing, setEditing] = useState<
    | { kind: "city"; item: z.infer<typeof city> }
    | { kind: "plan"; item: z.infer<typeof plan> }
    | null
  >(null);
  const total =
    result.data?.rows.reduce((sum, item) => sum + item.acessos, 0) ?? 0;
  return (
    <>
      <PageHeading
        title="Coleta ANATEL · DICI"
        description="Acessos em serviço no último dia do mês. Gere e confira o arquivo; o envio à ANATEL é feito pelo provedor."
        actions={
          <>
            <form
              className="erp-inline-actions"
              onSubmit={(event) => {
                event.preventDefault();
                setCompetence(draft);
              }}
            >
              <Input
                aria-label="Competência DICI"
                type="month"
                required
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button type="submit" variant="outline">
                Consultar competência
              </Button>
            </form>
            <ActionButton
              disabled={!result.data}
              onClick={() =>
                download(`${path}&format=csv`, `dici-acessos-${competence}.csv`)
              }
            >
              Baixar arquivo DICI
            </ActionButton>
          </>
        }
      />
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data && (
          <div className="erp-stack">
            <Panel
              title="Conferência da coleta"
              description="A coleta agrupa por CNPJ, município, tipo de cliente, área, meio, tecnologia e velocidade."
            >
              <p>
                {total} acessos no arquivo · {result.data.pending.total - total}{" "}
                contratos fora do arquivo por falta de dados
              </p>
              {result.data.pending.sem_cnpj > 0 && (
                <p className="profile-footnote">
                  {result.data.pending.sem_cnpj} contratos sem CNPJ. Cadastre
                  uma empresa com CNPJ e confira o vínculo do contrato em{" "}
                  <a
                    className="profile-text-action"
                    href="/administracao/empresas"
                  >
                    Empresas faturadoras
                  </a>
                  .
                </p>
              )}
              <p className="profile-footnote">
                Confira o leiaute e os dados antes de enviar no sistema de
                coleta da ANATEL. Esta aplicação não transmite a declaração.
              </p>
            </Panel>
            {result.data.pending.cities_without_code.length > 0 && (
              <OperationalCatalog
                title="Municípios sem código IBGE"
                description={`${result.data.pending.sem_municipio} contratos sem município identificado. O endereço vem da instalação ou, se ausente, do assinante.`}
                columns={["Município", "UF", "Contratos"]}
                rows={result.data.pending.cities_without_code.map((item) => ({
                  id: `${item.state}|${item.city}`,
                  cells: [
                    item.city || "Sem cidade no endereço",
                    item.state || "Sem UF",
                    item.contratos,
                  ],
                  actions: item.city && item.state && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing({ kind: "city", item })}
                    >
                      Informar código IBGE
                    </Button>
                  ),
                }))}
              />
            )}
            {result.data.pending.plans_without_technology.length > 0 && (
              <OperationalCatalog
                title="Planos sem tecnologia"
                description="Classificação da tecnologia de acesso usada na coleta."
                columns={["Plano"]}
                rows={result.data.pending.plans_without_technology.map(
                  (item) => ({
                    id: item.id,
                    cells: [item.name],
                    actions: (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditing({ kind: "plan", item })}
                      >
                        Informar tecnologia
                      </Button>
                    ),
                  }),
                )}
              />
            )}
            <OperationalCatalog
              title="Prévia do arquivo DICI"
              description={`Competência ${competence}. Somente acessos com dados completos entram no arquivo.`}
              columns={[
                "CNPJ",
                "Código IBGE",
                "Cliente",
                "Área",
                "Meio",
                "Tecnologia",
                "Velocidade (Mbps)",
                "Acessos",
              ]}
              rows={result.data.rows.map((item, index) => ({
                id: String(index),
                cells: [
                  item.cnpj,
                  item.ibge_code,
                  item.tipo_cliente,
                  item.tipo_atendimento,
                  item.meio,
                  item.tecnologia,
                  item.velocidade_mbps,
                  item.acessos,
                ],
              }))}
            />
          </div>
        )}
      </QueryBoundary>
      {editing && (
        <RecordEditor
          title={
            editing.kind === "city"
              ? "Código IBGE do município"
              : "Tecnologia do plano"
          }
          description={
            editing.kind === "city"
              ? `${editing.item.city} / ${editing.item.state}`
              : editing.item.name
          }
          initial={
            editing.kind === "city"
              ? { ibge_code: "" }
              : { access_technology: "" }
          }
          fields={
            editing.kind === "city"
              ? [
                  {
                    key: "ibge_code",
                    label: "Código IBGE",
                    required: true,
                    maxLength: 7,
                    hint: "Sete dígitos.",
                  },
                ]
              : [
                  {
                    key: "access_technology",
                    label: "Tecnologia de acesso",
                    type: "select",
                    required: true,
                    options: [
                      { value: "", label: "Selecione a tecnologia" },
                      ...Object.entries(technologies).map(([value, label]) => ({
                        value,
                        label,
                      })),
                    ],
                  },
                ]
          }
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            if (editing.kind === "city")
              await api("/anatel/municipalities", {
                method: "PUT",
                body: {
                  name: editing.item.city,
                  state: editing.item.state,
                  ibge_code: values.ibge_code,
                },
              });
            else
              await api(`/plans/${editing.item.id}/technology`, {
                method: "PUT",
                body: { access_technology: values.access_technology },
              });
            setEditing(null);
            await Promise.all([
              result.mutate(),
              mutate(
                (key) =>
                  Array.isArray(key) && String(key[0]).startsWith("erp-plan"),
              ),
            ]);
          }}
        />
      )}
    </>
  );
}
