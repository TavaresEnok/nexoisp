import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RecordEditor } from "@/features/shared/record-editor";
import { QueryBoundary } from "@/features/shared/feedback";
import { ServerPager, useUrlPage } from "@/features/shared/pagination";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api, erpClient } from "@/platform/erp-client";
const audit = z.object({
  id: z.union([z.string(), z.number()]),
  at: z.string(),
  actor_name: z.string().nullable(),
  actor_type: z.string(),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.union([z.string(), z.number()]).nullable(),
  result: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});
const retention = z.object({
  auth_log_days: z.number().nullable(),
  sessions_days: z.number().nullable(),
  notice_log_days: z.number().nullable(),
  defaults: z.record(z.string(), z.number()),
  limits: z.record(z.string(), z.tuple([z.number(), z.number()])),
  kept: z.string(),
});
const retentionLabels: Record<string, string> = {
  auth_log_days: "Tentativas de autenticação (dias)",
  sessions_days: "Registro de conexões (dias)",
  notice_log_days: "Registro de avisos (dias)",
};
export function AuditDirectory() {
  const { me } = useSession();
  const { page, setPage } = useUrlPage();
  const path = `/audit?limit=8&offset=${page * 8}`;
  const result = useSWR(["erp-audit", path], async ([, path]) => {
    const response = await erpClient.request(path);
    if (response.total === null)
      throw new Error("O servidor não informou a contagem de auditoria.");
    return { rows: z.array(audit).parse(response.data), total: response.total };
  });
  return (
    <>
      <PageHeading
        title="Auditoria"
        description="Ações e resultados registrados pelo Go no contexto do provedor."
      />
      <div className="erp-stack">
        {can(me, "settings:manage") && <RetentionSettings />}
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          <OperationalCatalog
            title="Registros de auditoria"
            description="Ações de suporte são identificadas junto ao autor. A rotina de retenção preserva a auditoria."
            columns={[
              "Quando",
              "Autor",
              "Ação",
              "Entidade",
              "Resultado",
              "Detalhe",
            ]}
            rows={(result.data?.rows ?? []).map((item) => ({
              id: String(item.id),
              cells: [
                new Date(item.at).toLocaleString("pt-BR"),
                <>
                  {item.actor_name ??
                    (item.actor_type === "agent" ? "Agente" : "Rotina")}
                  {item.detail?.support_access === true && (
                    <Badge variant="warning">Suporte</Badge>
                  )}
                </>,
                item.action,
                [item.entity_type, item.entity_id].filter(Boolean).join(" · "),
                item.result === "ok"
                  ? "Concluído"
                  : item.result === "denied"
                    ? "Negado"
                    : item.result,
                <details>
                  <summary>Ver detalhe</summary>
                  <pre className="whitespace-pre-wrap break-words">
                    {JSON.stringify(item.detail ?? {}, null, 2)}
                  </pre>
                </details>,
              ],
            }))}
          />
          <ServerPager
            page={page}
            setPage={setPage}
            total={result.data?.total ?? 0}
            loading={result.isLoading}
          />
        </QueryBoundary>
      </div>
    </>
  );
}
function RetentionSettings() {
  const result = useSWR("erp-retention", async () =>
    retention.parse(await api("/settings/retention")),
  );
  const [editing, setEditing] = useState(false);
  const data = result.data;
  return (
    <Panel
      title="Retenção de dados"
      description="A limpeza periódica usa os prazos do provedor ou os padrões da instalação."
      action={
        <Button
          variant="outline"
          disabled={!data}
          onClick={() => setEditing(true)}
        >
          Editar prazos de retenção
        </Button>
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <>
            <dl className="erp-columns">
              {Object.entries(retentionLabels).map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>
                    {data[
                      key as
                        | "auth_log_days"
                        | "sessions_days"
                        | "notice_log_days"
                    ] ?? data.defaults[key]}{" "}
                    dias
                    {data[
                      key as
                        | "auth_log_days"
                        | "sessions_days"
                        | "notice_log_days"
                    ] == null
                      ? " · padrão da instalação"
                      : ""}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="profile-footnote">{data.kept}</p>
          </>
        )}
      </QueryBoundary>
      {editing && data && (
        <RecordEditor
          title="Prazos de retenção"
          description="Deixe vazio para usar o padrão da instalação. O Go valida os limites antes de salvar."
          initial={Object.fromEntries(
            Object.keys(retentionLabels).map((key) => [
              key,
              String(
                data[
                  key as "auth_log_days" | "sessions_days" | "notice_log_days"
                ] ?? "",
              ),
            ]),
          )}
          fields={Object.entries(retentionLabels).map(([key, label]) => ({
            key,
            label,
            type: "number" as const,
            min: data.limits[key][0],
            max: data.limits[key][1],
            hint: `Padrão: ${data.defaults[key]} dias. De ${data.limits[key][0]} a ${data.limits[key][1]} dias.`,
          }))}
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            await api("/settings/retention", {
              method: "PUT",
              body: Object.fromEntries(
                Object.keys(retentionLabels).map((key) => [
                  key,
                  values[key].trim() ? Number(values[key]) : null,
                ]),
              ),
            });
            setEditing(false);
            await result.mutate();
          }}
        />
      )}
    </Panel>
  );
}
