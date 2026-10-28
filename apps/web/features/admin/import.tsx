import { useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { api } from "@/platform/erp-client";
import { money } from "@/lib/format";
import {
  preview,
  totals,
  fieldLabels,
  kindLabels,
  type ImportKind,
} from "./import-models";
import { ImportResults, ImportBatches } from "./import-batches";
import { cents } from "@/features/shared/schema";
const importPreview = preview.extend({
  totals: totals.extend({ conflicts: z.coerce.number().optional() }),
});
const device = z.object({
  id: z.string(),
  name: z.string(),
  driver: z.string(),
});
const plan = z.object({
  id: z.string(),
  name: z.string(),
  price_cents: cents(),
  active: z.boolean(),
});
export function DataImport() {
  const devices = useSWR("erp-import-devices", async () =>
    z.array(device).parse(await api("/devices")),
  );
  const plans = useSWR("erp-import-plans", async () =>
    z.array(plan).parse(await api("/plans")),
  );
  const { mutate } = useSWRConfig();
  const [kind, setKind] = useState<ImportKind>("subscribers");
  const [source, setSource] = useState("csv-intermediario");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [mapping, setMapping] = useState<Record<string, string> | undefined>();
  const [planMap, setPlanMap] = useState<Record<string, string>>({});
  const [result, setResult] = useState<z.infer<typeof importPreview> | null>(
    null,
  );
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const fileVersion = useRef(0);
  const body = {
    kind,
    source,
    filename: file?.name ?? "",
    csv: file?.text ?? "",
    device_id: ["subscribers", "contracts"].includes(kind)
      ? deviceId || null
      : null,
    ...(mapping ? { mapping } : {}),
    plan_map: planMap,
  };
  const currentSignature = importSignature(body);
  const stale = Boolean(result && signature !== currentSignature);
  const reset = () => {
    setResult(null);
    setMapping(undefined);
    setPlanMap({});
    setSignature("");
    setError(null);
  };
  const run = async (apply: boolean) => {
    if (locked.current) return;
    if (
      apply &&
      (!result || stale || result.applied || result.missing_required.length)
    )
      throw new Error("Simule novamente e confira a prévia antes de aplicar.");
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = importPreview.parse(
        await api(`/import/${apply ? "apply" : "preview"}`, { body }),
      );
      const normalized = Object.fromEntries(
        Object.entries(response.mapping).map(([key, value]) => [
          key,
          value ?? "",
        ]),
      );
      setMapping(normalized);
      setResult(response);
      setSignature(importSignature({ ...body, mapping: normalized }));
      if (apply)
        await mutate((key) =>
          typeof key === "string"
            ? key === "erp-import-batches"
            : Array.isArray(key) &&
              [
                "erp-subscribers",
                "erp-contracts",
                "erp-invoices",
                "erp-tickets",
                "erp-orders",
                "erp-search",
              ].includes(key[0]),
        );
    } catch (reason) {
      setError((reason as Error).message);
      throw reason;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading
        title="Importação de dados"
        description="Importe um grupo, confira os resultados e solicite o provisionamento separadamente no momento da virada."
      />
      <div className="erp-stack">
        <Panel
          title="Arquivo e origem"
          description="CSV intermediário do NexoISP: UTF-8, separado por ponto e vírgula ou vírgula, com cabeçalho. Exportações nativas de SGP ou MK-Auth exigem conversão e validação para esta estrutura; não há migração universal automática."
        >
          <div className="erp-columns">
            <FormField label="Conteúdo da importação">
              <select
                className="commercial-select"
                value={kind}
                disabled={busy}
                onChange={(event) => {
                  setKind(event.target.value as ImportKind);
                  reset();
                }}
              >
                {Object.entries(kindLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Origem da importação"
              hint="Identificador estável: 2 a 40 letras minúsculas, números ou hífen. Reuse a mesma origem ao reimportar os mesmos identificadores."
            >
              <Input
                value={source}
                disabled={busy}
                minLength={2}
                maxLength={40}
                pattern="[a-z0-9-]{2,40}"
                onChange={(event) => {
                  setSource(event.target.value);
                  setResult(null);
                }}
              />
            </FormField>
            <FormField label="Arquivo CSV">
              <Input
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={async (event) => {
                  const selected = event.target.files?.[0];
                  const version = ++fileVersion.current;
                  setFile(null);
                  reset();
                  if (!selected) return;
                  if (selected.size > 15 * 1024 * 1024) {
                    setError("Escolha um arquivo de até 15 MB.");
                    return;
                  }
                  setBusy(true);
                  try {
                    const text = await selected.text();
                    if (version === fileVersion.current)
                      setFile({ name: selected.name, text });
                  } catch {
                    setError("Não foi possível ler o arquivo.");
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </FormField>
            {["subscribers", "contracts"].includes(kind) && (
              <FormField
                label="Equipamento das contas PPPoE"
                hint="Sem equipamento, não são criadas contas PPPoE. A importação não aplica a configuração no concentrador."
              >
                <QueryBoundary
                  loading={devices.isLoading}
                  error={devices.error}
                  retry={() => devices.mutate()}
                >
                  <select
                    className="commercial-select"
                    disabled={busy}
                    value={deviceId}
                    onChange={(event) => {
                      setDeviceId(event.target.value);
                      setResult(null);
                    }}
                  >
                    <option value="">Não criar contas PPPoE</option>
                    {devices.data
                      ?.filter((item) => !item.driver.startsWith("olt"))
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </QueryBoundary>
              </FormField>
            )}
          </div>
          <Button
            disabled={!file || busy || !/^[a-z0-9-]{2,40}$/.test(source)}
            onClick={() => {
              void run(false).catch(() => {});
            }}
          >
            {busy ? "Processando arquivo…" : "Simular importação"}
          </Button>
          <p className="profile-footnote">
            A simulação executa as validações do servidor e desfaz a transação;
            ela não grava um lote. O arquivo permanece somente na memória desta
            tela durante a importação.
          </p>
          {error && <p role="alert">{error}</p>}
        </Panel>
        {result && (
          <>
            <Panel
              title="Mapa de campos"
              description="Associe cada informação à coluna do arquivo. Alterar o mapa exige uma nova simulação antes de aplicar."
            >
              {result.missing_required.length > 0 && (
                <p role="alert">
                  Campos obrigatórios sem coluna:{" "}
                  {result.missing_required
                    .map((key) => fieldLabels[key] ?? key)
                    .join(", ")}
                  .
                </p>
              )}
              <div className="erp-columns">
                {result.fields.map((key) => (
                  <FormField
                    key={key}
                    label={`Coluna de ${fieldLabels[key] ?? key}`}
                  >
                    <select
                      className="commercial-select"
                      disabled={busy}
                      value={mapping?.[key] ?? ""}
                      onChange={(event) =>
                        setMapping((previous) => ({
                          ...previous,
                          [key]: event.target.value,
                        }))
                      }
                    >
                      <option value="">Não importar este campo</option>
                      {result.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </FormField>
                ))}
              </div>
              {result.totals.plans_unmatched.length > 0 && (
                <QueryBoundary
                  loading={plans.isLoading}
                  error={plans.error}
                  retry={() => plans.mutate()}
                >
                  <div className="erp-columns">
                    {result.totals.plans_unmatched.map((name) => (
                      <FormField
                        key={name}
                        label={`Plano correspondente a ${name}`}
                      >
                        <select
                          className="commercial-select"
                          disabled={busy}
                          value={planMap[name] ?? ""}
                          onChange={(event) =>
                            setPlanMap((previous) => ({
                              ...previous,
                              [name]: event.target.value,
                            }))
                          }
                        >
                          <option value="">Deixar sem correspondência</option>
                          {plans.data
                            ?.filter((item) => item.active)
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name} · {money(item.price_cents / 100)}
                              </option>
                            ))}
                        </select>
                      </FormField>
                    ))}
                  </div>
                </QueryBoundary>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void run(false).catch(() => {});
                }}
              >
                Simular novamente com este mapa
              </Button>
            </Panel>
            <Panel
              title={
                result.applied
                  ? "Resultado da importação"
                  : "Prévia da importação"
              }
              description={
                result.applied
                  ? "Linhas válidas foram gravadas. Corrija as linhas com erro e reimporte com a mesma origem para evitar duplicação."
                  : "Confira quantidades, valores e avisos antes de aplicar. Nenhum lote foi gravado."
              }
            >
              <p>
                {result.totals.rows} linhas · {result.totals.created} novos ·{" "}
                {result.totals.updated} atualizados · {result.totals.unchanged}{" "}
                sem alteração · {result.totals.error} com erro
                {(result.totals.conflicts ?? 0) > 0 && (
                  <>
                    {" · "}
                    <Badge variant="warning">
                      {result.totals.conflicts ?? 0} divergentes da origem (não
                      alterados)
                    </Badge>
                  </>
                )}
              </p>
              {(result.totals.conflicts ?? 0) > 0 && (
                <p className="profile-footnote">
                  Divergências não sobrescrevem o Nexo; concilie pelo título.
                </p>
              )}
              {kind === "subscribers" ? (
                <p>
                  {result.totals.contracts_created} contratos ·{" "}
                  {result.totals.accounts_created} contas PPPoE ·{" "}
                  {result.totals.accounts_without_secret} contas sem senha
                </p>
              ) : kind === "history" ? (
                <p>
                  {result.totals.history_tickets ?? 0} atendimentos ·{" "}
                  {result.totals.history_work_orders ?? 0} OS ·{" "}
                  {result.totals.history_notes ?? 0} anotações
                </p>
              ) : (
                <p>
                  Novos títulos: {money(result.totals.amount_cents_total / 100)}{" "}
                  · {result.totals.invoices_paid ?? 0} pagos ·{" "}
                  {result.totals.invoices_partial ?? 0} parciais ·{" "}
                  {result.totals.invoices_canceled ?? 0} cancelados
                </p>
              )}
              {stale && (
                <p role="status">
                  A configuração mudou. Simule novamente para atualizar esta
                  prévia.
                </p>
              )}
              {!result.applied && (
                <ActionButton
                  disabled={busy || stale || result.missing_required.length > 0}
                  confirm={`Aplicar esta importação? A prévia indica ${result.totals.created} novos, ${result.totals.updated} atualizados e ${result.totals.error} linhas com erro que ficarão de fora. O servidor revalida todos os registros ao aplicar.`}
                  onClick={() => run(true)}
                >
                  Aplicar importação
                </ActionButton>
              )}
              {result.totals.accounts_without_secret > 0 && (
                <p className="profile-footnote">
                  Contas sem senha não poderão ser provisionadas até receber uma
                  credencial na ficha do acesso.
                </p>
              )}
            </Panel>
            <ImportResults rows={result.rows} />
            <ImportResults
              rows={result.sample}
              title="Amostra das primeiras vinte linhas"
            />
          </>
        )}
        <ImportBatches />
      </div>
    </>
  );
}

function importSignature(value: {
  kind: string;
  source: string;
  filename: string;
  csv: string;
  device_id: string | null;
  mapping?: Record<string, string>;
  plan_map: Record<string, string>;
}) {
  return JSON.stringify([
    value.kind,
    value.source,
    value.filename,
    value.csv,
    value.device_id,
    Object.entries(value.mapping ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(value.plan_map).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}
