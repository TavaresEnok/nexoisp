import { useState } from "react";
import useSWR from "swr";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/features/shared/form";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import {
  acsTemplateListSchema,
  acsTemplateSchema,
  acsVariables,
  dataModelLabel,
  formatParamLines,
  parseParamLines,
  type AcsTemplate,
} from "./acs-templates-model";

const informLabel = (seconds: number | null) =>
  seconds == null ? "Não altera" : `${seconds} s`;
export function AcsTemplates() {
  const { me } = useSession();
  // A escrita vale para todo o provedor; o servidor recusa sessões limitadas por POP.
  const write = can(me, "network:write");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [editor, setEditor] = useState<AcsTemplate | "create" | null>(null);
  const [detail, setDetail] = useState<AcsTemplate | null>(null);
  const params = new URLSearchParams({ status });
  if (q.trim()) params.set("q", q.trim());
  const result = useSWR(
    ["acs-templates", params.toString()],
    async ([, query]) =>
      acsTemplateListSchema.parse(await api(`/acs/templates?${query}`)),
  );
  const editing = editor && editor !== "create" ? editor : null;
  return (
    <>
      <PageHeading
        eyebrow="REDE ÓPTICA · ACS"
        title="Templates ACS"
        description="Provisionamento TR-069 por fabricante, modelo e firmware. A aplicação ocorre na ficha do contrato e gera uma intenção durável, confirmada somente por leitura do roteador."
      />
      <Panel
        title="Variáveis disponíveis"
        description="Use nos valores do tipo xsd:string. Senhas só entram por variável e nunca são exibidas em claro."
      >
        <div className="erp-inline-actions">
          {acsVariables.map(([name, label]) => (
            <Badge key={name} variant="outline" title={label}>
              {`{{${name}}}`}
            </Badge>
          ))}
        </div>
      </Panel>
      <Panel title="Templates de provisionamento">
        <div className="erp-columns">
          <FormField label="Buscar templates">
            <Input
              value={q}
              maxLength={100}
              onChange={(event) => setQ(event.target.value)}
            />
          </FormField>
          <FormField label="Situação dos templates">
            <select
              className="commercial-select"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="all">Todos</option>
              <option value="active">Ativos</option>
              <option value="archived">Inativos</option>
            </select>
          </FormField>
        </div>
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          <OperationalCatalog
            title="Templates ACS"
            description={`${result.data?.total ?? 0} template(s). O mais específico que casa com o roteador é sugerido na ficha do contrato.`}
            columns={[
              "Template",
              "Fabricante · modelo · firmware",
              "Modelo de dados",
              "Parâmetros",
              "Inform periódico",
              "Situação",
            ]}
            actions={
              write && (
                <Button onClick={() => setEditor("create")}>
                  Novo template ACS
                </Button>
              )
            }
            empty="Nenhum template ACS cadastrado."
            rows={(result.data?.items ?? []).map((item) => ({
              id: item.id,
              cells: [
                item.name,
                `${item.manufacturer} · ${item.model} · ${item.firmware}`,
                dataModelLabel(item.data_model),
                String(item.parameters.length),
                informLabel(item.inform_interval),
                item.active ? "Ativo" : "Inativo",
              ],
              actions: (
                <div className="erp-inline-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setDetail(item)}
                  >
                    Consultar
                  </Button>
                  {write && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditor(item)}
                      >
                        Editar template
                      </Button>
                      <ActionButton
                        confirm={
                          item.active
                            ? `Inativar ${item.name}? Ele deixa de ser sugerido e não pode ser aplicado.`
                            : `Reativar ${item.name}?`
                        }
                        onClick={async () => {
                          await api(`/acs/templates/${item.id}`, {
                            method: "PATCH",
                            body: { active: !item.active },
                          });
                          await result.mutate();
                        }}
                      >
                        {item.active ? "Inativar" : "Reativar"}
                      </ActionButton>
                      <ActionButton
                        danger
                        label={`Excluir ${item.name}`}
                        confirm={`Excluir ${item.name}? Intenções já registradas preservam a própria cópia do comando.`}
                        onClick={async () => {
                          await api(`/acs/templates/${item.id}`, {
                            method: "DELETE",
                          });
                          await result.mutate();
                        }}
                      >
                        Excluir
                      </ActionButton>
                    </>
                  )}
                </div>
              ),
            }))}
          />
        </QueryBoundary>
      </Panel>
      {detail && (
        <RecordEditor
          title="Consultar template ACS"
          initial={{}}
          fields={[]}
          onClose={() => setDetail(null)}
          onSubmit={async () => setDetail(null)}
          submit="Fechar"
          description={`${detail.name} · revisão ${detail.revision} · ${dataModelLabel(detail.data_model)} · casa com ${detail.manufacturer} / ${detail.model} / ${detail.firmware} · inform periódico: ${informLabel(detail.inform_interval)} · parâmetros: ${
            detail.parameters
              .map((p) => `${p.path} = ${p.value} (${p.type})`)
              .join("; ") || "nenhum"
          }`}
        />
      )}
      {editor && (
        <RecordEditor
          title={editing ? "Editar template ACS" : "Novo template ACS"}
          description="Curingas * e ? em fabricante, modelo e firmware. Um parâmetro por linha: caminho = valor ; tipo (xsd:string quando omitido)."
          initial={{
            name: editing?.name ?? "",
            manufacturer: editing?.manufacturer ?? "*",
            model: editing?.model ?? "*",
            firmware: editing?.firmware ?? "*",
            inform_interval: editing?.inform_interval?.toString() ?? "",
            parameters: editing ? formatParamLines(editing.parameters) : "",
          }}
          fields={[
            {
              key: "name",
              label: "Nome do template",
              required: true,
              maxLength: 120,
            },
            {
              key: "manufacturer",
              label: "Fabricante (curingas permitidos)",
              maxLength: 100,
            },
            {
              key: "model",
              label: "Modelo (curingas permitidos)",
              maxLength: 100,
            },
            {
              key: "firmware",
              label: "Versão de firmware (curingas permitidos)",
              maxLength: 100,
            },
            {
              key: "inform_interval",
              label: "Intervalo de inform periódico (segundos)",
              type: "number",
              min: 60,
              max: 86400,
              hint: "De 60 a 86400. Em branco, o template não altera o inform.",
            },
            {
              key: "parameters",
              label: "Parâmetros TR-069",
              type: "textarea",
              hint: "Ex.: InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID = {{wifi_ssid}}",
            },
          ]}
          onClose={() => setEditor(null)}
          onSubmit={async (values) => {
            const parameters = parseParamLines(values.parameters);
            const inform = values.inform_interval.trim();
            const interval = inform ? Number(inform) : null;
            if (
              interval !== null &&
              (!Number.isInteger(interval) || interval < 60 || interval > 86400)
            )
              throw new Error(
                "O intervalo de inform deve ser um número inteiro de 60 a 86400 segundos.",
              );
            if (!parameters.length && interval === null)
              throw new Error(
                "Informe ao menos um parâmetro ou o intervalo de inform periódico.",
              );
            const body = {
              name: values.name.trim(),
              manufacturer: values.manufacturer.trim() || "*",
              model: values.model.trim() || "*",
              firmware: values.firmware.trim() || "*",
              inform_interval: interval,
              parameters,
            };
            acsTemplateSchema.parse(
              await api(
                editing ? `/acs/templates/${editing.id}` : "/acs/templates",
                { method: editing ? "PATCH" : "POST", body },
              ),
            );
            setEditor(null);
            await result.mutate();
          }}
        />
      )}
    </>
  );
}
