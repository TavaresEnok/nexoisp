import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Panel } from "@/components/workspace-ui";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { api } from "@/platform/erp-client";
import { stamp } from "./models";
const n = z.coerce.number();
const itemSchema = z.object({
  id: z.string(),
  contract_id: z.string().nullable().optional(),
  subscriber_name: z.string().nullable().optional(),
  target: z.string().nullable().optional(),
  serial: z.string().nullable().optional(),
  device_id: z.string().nullable().optional(),
  device_name: z.string().nullable().optional(),
  pon_port: z.string().nullable().optional(),
  observed_rx_dbm: z.coerce.number().nullable().optional(),
  action: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  observed_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
export const overviewSchema = z.object({
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
      kind: z.string().optional(),
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

/** Limiares usados nos alertas de rede (Rede › Cadastros › Limiares). */
export function NocThresholds() {
  const { me } = useSession();
  const result = useSWR(
    "erp-noc",
    async () => overviewSchema.parse(await api("/noc/overview")),
    { refreshInterval: 10000 },
  );
  const [editing, setEditing] = useState(false);
  const data = result.data;
  return (
    <Panel
      title="Limiares dos alertas"
      action={
        can(me, "network:write") &&
        data && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            Editar
          </Button>
        )
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <ProfileFacts
            items={[
              [
                "Sinal fraco da ONU",
                data.settings.onu_rx_min_dbm == null
                  ? "Sem limite"
                  : `Abaixo de ${data.settings.onu_rx_min_dbm} dBm`,
              ],
              [
                "Falha coletiva na PON",
                `${data.settings.pon_outage_min} ONUs e metade da porta sem sinal`,
              ],
              [
                "Contrato encerrado",
                data.settings.onu_remove_on_contract_end
                  ? "Desautoriza a ONU automaticamente"
                  : "ONU removida manualmente",
              ],
            ]}
          />
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
    </Panel>
  );
}
