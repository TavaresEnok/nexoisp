import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { can } from "@/features/session/model";
import { useSession } from "@/features/session/provider";
import {
  canonicalErpPath,
  canAccessPath,
} from "@/features/operations/navigation";
import { api } from "@/platform/erp-client";
import { stamp } from "./models";
const n = z.coerce.number();
const itemSchema = z.object({
  id: z.string(),
  contract_id: z.string().nullable().optional(),
  subscriber_name: z.string().nullable().optional(),
  target: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
  device_name: z.string().nullable().optional(),
  pon_port: z.string().nullable().optional(),
  observed_rx_dbm: z.coerce.number().nullable().optional(),
  action: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  observed_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
const overviewSchema = z.object({
  generated_at: z.string(),
  counters: z.object({
    agents_offline: n,
    sessions: n,
    accounts: n,
    suspended: n,
    onus_down: n,
    onus: n,
    work_orders: n,
    work_orders_late: n,
    tickets_technical: n,
  }),
  settings: z.object({
    onu_rx_min_dbm: n.nullable(),
    pon_outage_min: n,
    onu_remove_on_contract_end: z.boolean(),
  }),
  alerts: z.array(
    z.object({
      severity: z.string(),
      title: z.string(),
      detail: z.string().optional(),
      link: z.string().optional(),
      items: z.array(itemSchema).optional(),
    }),
  ),
  pons: z.array(
    z.object({
      device_id: z.string(),
      device_name: z.string(),
      pon_port: z.string(),
      total: n,
      down: n,
      outage: z.boolean(),
      read_at: z.string().nullable(),
    }),
  ),
});
export function Severity({ value }: { value: string }) {
  return (
    <Badge
      variant={
        value === "critical"
          ? "destructive"
          : value === "warning"
            ? "warning"
            : "outline"
      }
    >
      {(
        {
          critical: "Crítico",
          warning: "Atenção",
          info: "Informação",
          ok: "OK",
        } as Record<string, string>
      )[value] ?? value}
    </Badge>
  );
}
export function NetworkNoc() {
  const { me } = useSession();
  const navigate = useNavigate();
  const result = useSWR(
    "erp-noc",
    async () => overviewSchema.parse(await api("/noc/overview")),
    { refreshInterval: 10000 },
  );
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const data = result.data;
  const c = data?.counters;
  const open = (path: string) => {
    const [pathname, query] = path.split("?");
    const canonical = canonicalErpPath(pathname);
    if (canAccessPath(me, canonical))
      navigate(`${canonical}${query ? `?${query}` : ""}`);
  };
  return (
    <>
      <PageHeading
        title="NOC"
        description="Leituras e alertas da operação de rede."
        actions={
          can(me, "network:write") &&
          data && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              Limiares e regras
            </Button>
          )
        }
      />
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && c && (
          <>
            <p className="profile-footnote">
              Atualizado em {stamp(data.generated_at)} · os alertas usam regras
              sobre as leituras dos agentes e não alteram a rede.
            </p>
            <section className="metrics-grid" aria-label="Indicadores do NOC">
              {[
                [c.agents_offline, "Agentes offline"],
                [`${c.sessions} / ${c.accounts}`, "Sessões online / acessos"],
                [c.suspended, "Acessos suspensos"],
                [`${c.onus_down} / ${c.onus}`, "ONUs sem sinal / total"],
                [
                  c.work_orders,
                  `OS em aberto · ${c.work_orders_late} vencida(s)`,
                ],
                [c.tickets_technical, "Atendimentos técnicos abertos"],
              ].map(([value, label]) => (
                <div className="metric-card" key={label}>
                  <div className="metric-heading">
                    <span>{label}</span>
                  </div>
                  <div className="metric-main">
                    <strong>{value}</strong>
                  </div>
                </div>
              ))}
            </section>
            <div className="erp-stack">
              <Panel title={`Alertas (${data.alerts.length})`}>
                {data.alerts.length ? (
                  data.alerts.map((alert, index) => (
                    <ProfileSection
                      key={index}
                      title={alert.title}
                      caption={alert.detail}
                      action={<Severity value={alert.severity} />}
                    >
                      <div className="erp-inline-actions">
                        {alert.items && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setExpanded(expanded === index ? null : index)
                            }
                          >
                            {expanded === index
                              ? "Ocultar itens"
                              : `Ver ${alert.items.length} item(ns)`}
                          </Button>
                        )}
                        {alert.link &&
                          canAccessPath(
                            me,
                            canonicalErpPath(alert.link.split("?")[0]),
                          ) && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => open(alert.link!)}
                            >
                              Abrir destino
                            </Button>
                          )}
                      </div>
                      {expanded === index &&
                        alert.items?.map((item) => (
                          <div key={item.id} className="erp-contract-card">
                            <strong>
                              {item.subscriber_name ||
                                item.target ||
                                item.serial ||
                                item.id}
                            </strong>
                            <p className="profile-footnote">
                              {[
                                item.device_name,
                                item.pon_port && `PON ${item.pon_port}`,
                                item.observed_rx_dbm != null &&
                                  `RX ${item.observed_rx_dbm} dBm`,
                                item.action,
                                item.status,
                                item.note,
                              ]
                                .filter(Boolean)
                                .join(" · ")}{" "}
                              ·{" "}
                              {stamp(
                                item.observed_at ?? item.updated_at ?? null,
                              )}
                            </p>
                            {item.contract_id && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  navigate(
                                    `/contratos?contrato=${item.contract_id}`,
                                  )
                                }
                              >
                                Abrir contrato
                              </Button>
                            )}
                          </div>
                        ))}
                    </ProfileSection>
                  ))
                ) : (
                  <p className="profile-footnote">Nenhum alerta agora.</p>
                )}
              </Panel>
              <Panel title="Portas PON">
                {data.pons.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {[
                          "OLT",
                          "Porta PON",
                          "ONUs autorizadas",
                          "Sem sinal",
                          "Situação",
                          "Última leitura",
                        ].map((label) => (
                          <TableHead key={label}>{label}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.pons.map((row) => (
                        <TableRow key={`${row.device_id}/${row.pon_port}`}>
                          <TableCell>{row.device_name}</TableCell>
                          <TableCell>{row.pon_port}</TableCell>
                          <TableCell>{row.total}</TableCell>
                          <TableCell>{row.down}</TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                row.outage
                                  ? "destructive"
                                  : row.down
                                    ? "warning"
                                    : "outline"
                              }
                            >
                              {row.outage
                                ? "Possível falha coletiva"
                                : row.down
                                  ? "Falhas isoladas"
                                  : "Normal"}
                            </Badge>
                          </TableCell>
                          <TableCell>{stamp(row.read_at)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="profile-footnote">
                    Nenhuma porta PON com leitura.
                  </p>
                )}
                <p className="profile-footnote">
                  Sinal fraco:{" "}
                  {data.settings.onu_rx_min_dbm == null
                    ? "sem limite definido pelo provedor"
                    : `abaixo de ${data.settings.onu_rx_min_dbm} dBm`}
                  . Falha coletiva: ao menos {data.settings.pon_outage_min} ONUs
                  e metade da porta.
                </p>
              </Panel>
            </div>
          </>
        )}
      </QueryBoundary>
      {editing && data && (
        <RecordEditor
          title="Limiares e regras de rede"
          description="Os limites dependem do equipamento e do projeto óptico do provedor."
          initial={{
            rx:
              data.settings.onu_rx_min_dbm == null
                ? ""
                : String(data.settings.onu_rx_min_dbm),
            pon: String(data.settings.pon_outage_min),
            remove: String(data.settings.onu_remove_on_contract_end),
          }}
          fields={[
            {
              key: "rx",
              label: "RX mínimo da ONU em dBm",
              hint: "Em branco: mostra o sinal sem classificá-lo.",
            },
            {
              key: "pon",
              label: "Mínimo de ONUs sem sinal na mesma PON",
              type: "number",
              min: 2,
              max: 500,
              required: true,
            },
            {
              key: "remove",
              label: "Desautorizar ONU ao encerrar contrato",
              type: "select",
              options: [
                { value: "false", label: "Não · remoção manual" },
                {
                  value: "true",
                  label: "Sim · solicitar desautorização automaticamente",
                },
              ],
            },
          ]}
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            const rx =
              values.rx === "" ? null : Number(values.rx.replace(",", "."));
            if (rx !== null && !Number.isFinite(rx))
              throw new Error("Informe um RX válido.");
            await api("/noc/settings", {
              method: "PUT",
              body: {
                onu_rx_min_dbm: rx,
                pon_outage_min: Number(values.pon),
                onu_remove_on_contract_end: values.remove === "true",
              },
            });
            setEditing(false);
            await result.mutate();
          }}
        />
      )}
    </>
  );
}
const diagnosisSchema = z.object({
  severity: z.string(),
  verdict: z.string(),
  limits: z.string(),
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.string(),
      title: z.string(),
      suggestion: z.string().optional(),
      evidence: z.array(
        z.object({
          label: z.string(),
          value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
          at: z.string().optional(),
        }),
      ),
    }),
  ),
});
export function ContractDiagnosis({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const result = useSWR(["erp-diagnosis", id], async () =>
    diagnosisSchema.parse(await api(`/contracts/${id}/diagnosis`)),
  );
  const data = result.data;
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Diagnóstico do acesso</DialogTitle>
          <DialogDescription>
            Evidências registradas pelo servidor; esta consulta não executa
            comandos na rede.
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {data && (
            <>
              <div className="erp-inline-actions">
                <Severity value={data.severity} />
                <strong>{data.verdict}</strong>
              </div>
              {data.findings.map((finding) => (
                <ProfileSection
                  key={finding.code}
                  title={finding.title}
                  action={<Severity value={finding.severity} />}
                >
                  <ProfileFacts
                    items={finding.evidence.map((item) => [
                      item.label,
                      `${item.value ?? "Não informado"}${item.at ? ` · ${stamp(item.at)}` : ""}`,
                    ])}
                  />
                  {finding.suggestion && (
                    <p className="profile-footnote">{finding.suggestion}</p>
                  )}
                </ProfileSection>
              ))}
              <p className="profile-footnote">{data.limits}</p>
              <ActionButton
                onClick={async () => {
                  await result.mutate();
                }}
              >
                Atualizar diagnóstico
              </ActionButton>
            </>
          )}
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
export function ContractDiagnosisButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Diagnosticar acesso
      </Button>
      {open && <ContractDiagnosis id={id} onClose={() => setOpen(false)} />}
    </>
  );
}
