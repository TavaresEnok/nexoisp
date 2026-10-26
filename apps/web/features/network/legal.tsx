import { useState, useRef } from "react";
import useSWR from "swr";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MutationForm, FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { exportCsv, printDocument } from "@/platform/browser";
const nullable = z.string().nullable();
const identitySchema = z.object({
  subscriber_id: z.string(),
  name: z.string(),
  document: nullable,
  phone: nullable,
  email: nullable,
  address: nullable,
});
const sessionSchema = identitySchema.extend({
  login: z.string(),
  ip: z.string(),
  started_at: z.string(),
  stopped_at: nullable,
  mac: nullable,
  nas_ip: nullable,
  cgnat: z
    .object({
      public_ip: z.string(),
      port_start: z.number(),
      port_end: z.number(),
    })
    .nullish(),
});
const querySchema = z.object({
  ip: z.string(),
  port: z.number().nullable(),
  from: z.string(),
  to: z.string(),
  reference: z.string(),
  margin_minutes: z.number(),
});
const resultSchema = z.object({
  query: querySchema,
  mode: z.string(),
  notes: z.array(z.string()),
  generated_by: z.string(),
  generated_at: z.string(),
  records_since: nullable,
  subscribers: z.number(),
  sessions: z.array(sessionSchema),
  ipv6: z.array(
    identitySchema.extend({ prefix: z.string(), created_at: z.string(), released_at: nullable }),
  ),
  fixed: z.array(z.object({ ip: z.string(), name: z.string() })),
});
const historySchema = z.array(
  z.object({
    at: z.string(),
    user_name: nullable,
    detail: querySchema.extend({ subscribers: z.number() }),
  }),
);
const zones = [
  ["-03:00", "Brasília · UTC−3"],
  ["+00:00", "UTC / GMT"],
  ["-02:00", "Fernando de Noronha · UTC−2"],
  ["-04:00", "Manaus / Cuiabá · UTC−4"],
  ["-05:00", "Acre · UTC−5"],
];
export function legalStamp(value: string | null, offset: string) {
  if (!value) return "Em andamento";
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  const instant = new Date(Date.parse(value) + sign * (h * 60 + m) * 60000);
  return `${instant.toISOString().slice(0, 19).replace("T", " ")} UTC${offset}`;
}
export function LegalIpLookup() {
  const frame = useRef<HTMLIFrameElement>(null);
  const [printReady, setPrintReady] = useState(false);
  const navigate = useNavigate();
  const [values, setValues] = useState({
    ip: "",
    port: "",
    reference: "",
    start: "",
    end: "",
    zone: "-03:00",
    margin: "0",
  });
  const [report, setReport] = useState<{
    data: z.infer<typeof resultSchema>;
    zone: string;
  } | null>(null);
  const history = useSWR("erp-legal-history", async () =>
    historySchema.parse(await api("/legal/ip-lookup/history")),
  );
  const result = report?.data;
  const zone = report?.zone ?? "-03:00";
  const set = (key: keyof typeof values, value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));
  const csv = () => {
    if (!result) return;
    exportCsv(
      `consulta-ip-${result.query.ip}`,
      [
        "Referência",
        "Assinante",
        "Documento",
        "Telefone",
        "E-mail",
        "Endereço",
        "Login",
        "IP",
        "IP público",
        "Portas",
        "Início",
        "Fim",
        "MAC",
        "NAS",
      ],
      result.sessions.map((row) => [
        result.query.reference,
        row.name,
        row.document || "",
        row.phone || "",
        row.email || "",
        row.address || "",
        row.login,
        row.ip,
        row.cgnat?.public_ip || "",
        row.cgnat ? `${row.cgnat.port_start}–${row.cgnat.port_end}` : "",
        legalStamp(row.started_at, zone),
        row.stopped_at ? legalStamp(row.stopped_at, zone) : "Em andamento",
        row.mac || "",
        row.nas_ip || "",
      ]),
    );
  };
  return (
    <div className="erp-stack">
      <PageHeading
        eyebrow="RELATÓRIO · CONSULTA DE IP"
        title="Rastreabilidade de IP"
        description="Accounting, porta CGNAT e intervalo informado na requisição, com registro de auditoria."
      />
      <Panel
        title="Dados da requisição"
        description="No CGNAT, informe a porta para restringir o IP privado; sem porta, o resultado abrange todos os que compartilharam o IP. Até 92 dias por consulta."
      >
        <MutationForm
          submit="Pesquisar IP e período"
          onSubmit={async () => {
            const iso = (local: string) =>
              (local.length === 16 ? `${local}:00` : local) + values.zone;
            const from = iso(values.start),
              to = iso(values.end || values.start);
            if (Date.parse(to) < Date.parse(from))
              throw new Error("O fim deve ser igual ou posterior ao início.");
            setReport(null);
            setPrintReady(false);
            const data = resultSchema.parse(
              await api("/legal/ip-lookup", {
                body: {
                  ip: values.ip.trim(),
                  port: values.port ? Number(values.port) : null,
                  from,
                  to,
                  reference: values.reference.trim(),
                  margin_minutes: Number(values.margin),
                },
              }),
            );
            setReport({ data, zone: values.zone });
            await history.mutate();
          }}
        >
          <div className="erp-columns">
            <FormField label="Endereço IP da requisição">
              <Input
                required
                maxLength={45}
                value={values.ip}
                onChange={(event) => set("ip", event.target.value)}
              />
            </FormField>
            <FormField label="Porta de origem da requisição">
              <Input
                type="number"
                min={1}
                max={65535}
                value={values.port}
                onChange={(event) => set("port", event.target.value)}
              />
            </FormField>
            <FormField label="Número do ofício ou processo">
              <Input
                required
                minLength={3}
                maxLength={120}
                value={values.reference}
                onChange={(event) => set("reference", event.target.value)}
              />
            </FormField>
            <FormField label="Início do período consultado">
              <Input
                type="datetime-local"
                step="1"
                required
                value={values.start}
                onChange={(event) => set("start", event.target.value)}
              />
            </FormField>
            <FormField
              label="Fim do período consultado"
              hint="Em branco: mesmo instante do início."
            >
              <Input
                type="datetime-local"
                step="1"
                value={values.end}
                onChange={(event) => set("end", event.target.value)}
              />
            </FormField>
            <FormField label="Fuso da requisição">
              <select
                className="commercial-select"
                value={values.zone}
                onChange={(event) => set("zone", event.target.value)}
              >
                {zones.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Margem em minutos"
              hint="Aplicada para mais e para menos; zero conserva exatamente o período."
            >
              <Input
                type="number"
                min={0}
                max={60}
                required
                value={values.margin}
                onChange={(event) => set("margin", event.target.value)}
              />
            </FormField>
          </div>
        </MutationForm>
      </Panel>
      {result && (
        <Panel
          title={`Resultado · ${result.query.ip}${result.query.port ? `:${result.query.port}` : ""}`}
          description="Confronte os registros e os limites informados pelo servidor antes de responder à requisição."
          action={
            <div className="erp-inline-actions">
              <ActionButton
                disabled={!printReady}
                onClick={async () =>
                  printDocument(frame.current?.contentWindow)
                }
              >
                Imprimir relatório IP
              </ActionButton>
              {result.sessions.length > 0 && (
                <Button variant="outline" onClick={csv}>
                  Exportar resultado IP
                </Button>
              )}
            </div>
          }
        >
          <ProfileFacts
            items={[
              ["Referência", result.query.reference],
              [
                "Período",
                `${legalStamp(result.query.from, zone)} → ${legalStamp(result.query.to, zone)}`,
              ],
              ["Margem", `${result.query.margin_minutes} minuto(s)`],
              ["Consultado por", result.generated_by],
              ["Gerado em", legalStamp(result.generated_at, zone)],
              [
                "Modo",
                (
                  {
                    direct: "IP direto ou privado",
                    cgnat_port: "CGNAT com porta · IP privado identificado",
                    cgnat_shared: "CGNAT sem porta · IP compartilhado",
                    ipv6: "IPv6 · delegação cadastrada",
                  } as Record<string, string>
                )[result.mode] ?? result.mode,
              ],
            ]}
          />
          {result.notes.map((note, index) => (
            <p key={index} role="status" className="profile-footnote">
              {note}
            </p>
          ))}
          {result.mode === "ipv6" ? (
            <OperationalCatalog
              title="Delegações IPv6 encontradas"
              description="Períodos de titularidade preservados após a liberação do prefixo."
              columns={[
                "Assinante",
                "Documento",
                "Prefixo delegado",
                "Início da titularidade",
                "Fim da titularidade",
                "Contato / endereço",
              ]}
              rows={result.ipv6.map((row, index) => ({
                id: `${row.subscriber_id}/${index}`,
                cells: [
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      navigate(`/assinantes?ficha=${row.subscriber_id}`)
                    }
                  >
                    {row.name}
                  </Button>,
                  row.document || "—",
                  row.prefix,
                  legalStamp(row.created_at, zone),
                  row.released_at ? legalStamp(row.released_at, zone) : "Em uso",
                  <>
                    {[row.phone, row.email].filter(Boolean).join(" · ")}
                    <small className="table-subline">
                      {row.address || "—"}
                    </small>
                  </>,
                ],
              }))}
            />
          ) : (
            <OperationalCatalog
              title="Sessões no período"
              description={`${result.subscribers} assinante(s) em ${result.sessions.length} sessão(ões).`}
              columns={[
                "Assinante / documento",
                "Login",
                "IP / tradução",
                "Início",
                "Fim",
                "MAC / NAS",
                "Contato / endereço",
              ]}
              rows={result.sessions.map((row, index) => ({
                id: `${row.subscriber_id}/${index}`,
                cells: [
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        navigate(`/assinantes?ficha=${row.subscriber_id}`)
                      }
                    >
                      {row.name}
                    </Button>
                    <small className="table-subline">
                      {row.document || "—"}
                    </small>
                  </>,
                  row.login,
                  <>
                    {row.ip}
                    {row.cgnat && (
                      <small className="table-subline">
                        Público {row.cgnat.public_ip} · portas{" "}
                        {row.cgnat.port_start}–{row.cgnat.port_end}
                      </small>
                    )}
                  </>,
                  legalStamp(row.started_at, zone),
                  row.stopped_at ? (
                    legalStamp(row.stopped_at, zone)
                  ) : (
                    <Badge variant="outline">Em andamento</Badge>
                  ),
                  <>
                    {row.mac || "—"}
                    <small className="table-subline">{row.nas_ip || "—"}</small>
                  </>,
                  <>
                    {[row.phone, row.email].filter(Boolean).join(" · ")}
                    <small className="table-subline">
                      {row.address || "—"}
                    </small>
                  </>,
                ],
              }))}
              empty="Nenhuma sessão com este endereço no período."
            />
          )}
          {result.fixed.length > 0 && (
            <ProfileSection title="Reservas fixas atuais">
              <p className="profile-footnote">
                {result.fixed
                  .map((row) => `${row.ip} → ${row.name}`)
                  .join("; ")}
                . O cadastro atual não substitui as sessões históricas acima.
              </p>
            </ProfileSection>
          )}
          <p className="profile-footnote">
            Fonte: accounting do provedor
            {result.records_since
              ? ` disponível desde ${legalStamp(result.records_since, zone)}`
              : ". Não há data inicial disponível."}
          </p>
        </Panel>
      )}
      {result && (
        <iframe
          ref={frame}
          title="Relatório de impressão da consulta IP"
          className="erp-print-frame"
          sandbox="allow-same-origin allow-modals"
          srcDoc={legalPrint(result, zone)}
          onLoad={() => setPrintReady(true)}
        />
      )}
      <Panel title="Consultas anteriores">
        <QueryBoundary
          loading={history.isLoading}
          error={history.error}
          retry={() => history.mutate()}
        >
          <OperationalCatalog
            title="Histórico da consulta legal"
            description="Requisição, responsável e período registrados pela auditoria do servidor."
            columns={[
              "Quando",
              "Quem",
              "Referência",
              "IP / porta",
              "Período",
              "Assinantes",
            ]}
            rows={(history.data ?? []).map((row, index) => ({
              id: `${row.at}/${index}`,
              cells: [
                legalStamp(row.at, "-03:00"),
                row.user_name || "Não informado",
                row.detail.reference,
                `${row.detail.ip}${row.detail.port ? `:${row.detail.port}` : ""}`,
                `${legalStamp(row.detail.from, "-03:00")} → ${legalStamp(row.detail.to, "-03:00")}`,
                row.detail.subscribers,
              ],
            }))}
          />
        </QueryBoundary>
      </Panel>
    </div>
  );
}

function legalPrint(result: z.infer<typeof resultSchema>, zone: string) {
  const escape = (value: unknown) =>
    String(value ?? "—").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  const rows =
    result.mode === "ipv6"
      ? result.ipv6.map((row) => [
          row.name,
          row.document,
          row.prefix,
          legalStamp(row.created_at, zone),
                  row.released_at ? legalStamp(row.released_at, zone) : "Em uso",
          [row.phone, row.email, row.address].filter(Boolean).join(" · "),
        ])
      : result.sessions.map((row) => [
          row.name,
          row.document,
          row.login,
          row.ip,
          row.cgnat
            ? `${row.cgnat.public_ip}:${row.cgnat.port_start}–${row.cgnat.port_end}`
            : "—",
          legalStamp(row.started_at, zone),
          row.stopped_at ? legalStamp(row.stopped_at, zone) : "Em andamento",
          row.mac,
          row.nas_ip,
          [row.phone, row.email, row.address].filter(Boolean).join(" · "),
        ]);
  const columns =
    result.mode === "ipv6"
      ? ["Assinante", "Documento", "Prefixo", "Desde", "Até", "Contato / endereço"]
      : [
          "Assinante",
          "Documento",
          "Login",
          "IP",
          "Tradução",
          "Início",
          "Fim",
          "MAC",
          "NAS",
          "Contato / endereço",
        ];
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Consulta IP · ${escape(result.query.reference)}</title><style>@page{size:A4 landscape;margin:12mm}body{font:11px/1.5 Arial;color:#171717}table{width:100%;border-collapse:collapse}td,th{padding:7px;border-bottom:1px solid #ccc;text-align:left;overflow-wrap:anywhere}thead{display:table-header-group}h1{font-size:20px}p{white-space:pre-wrap}tr{break-inside:avoid}</style></head><body><h1>NexoISP · Rastreabilidade de IP</h1><p>Referência: ${escape(result.query.reference)} · IP ${escape(result.query.ip)}${result.query.port ? `:${escape(result.query.port)}` : ""}<br>Período: ${escape(legalStamp(result.query.from, zone))} → ${escape(legalStamp(result.query.to, zone))} · margem ${result.query.margin_minutes} min<br>Consultado por ${escape(result.generated_by)} em ${escape(legalStamp(result.generated_at, zone))}</p>${result.notes.map((note) => `<p>${escape(note)}</p>`).join("")}<table><thead><tr>${columns.map((label) => `<th>${escape(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table><p>${result.subscribers} assinante(s). Fonte: accounting do provedor${result.records_since ? `, disponível desde ${escape(legalStamp(result.records_since, zone))}` : ""}. Reservas atuais não substituem evidência de sessões históricas.</p></body></html>`;
}
