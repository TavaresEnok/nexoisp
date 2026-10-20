import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { toast } from "sonner";
import { PageHeading, Panel } from "@/components/workspace-ui";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { FormField } from "@/features/shared/form";
import { useSession } from "@/features/session/provider";
import { can, hasModule } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { localDateTime } from "@/features/field/models";
import { stamp } from "./models";
import { useDevices } from "./queries";
import { useCreateRequest } from "@/features/shared/create-request";
const maintenanceSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  message: z.string(),
  severity: z.string(),
  device_name: z.string().nullable(),
  starts_at: z.string(),
  ends_at: z.string(),
  state: z.enum(["scheduled", "active", "ended", "canceled"]),
  affected_subscribers: z.coerce.number(),
  notified_start_at: z.string().nullable(),
  notified_resolved_at: z.string().nullable(),
});
const states = {
  scheduled: "Agendada",
  active: "Em andamento",
  ended: "Encerrada",
  canceled: "Cancelada",
};
const severities: Record<string, string> = {
  info: "Informativo",
  degraded: "Lentidão ou instabilidade",
  outage: "Sem acesso",
};
export function NetworkMaintenance() {
  const { me } = useSession();
  const write = can(me, "network:write");
  useCreateRequest("aviso", () => setCreating(true), write);
  const result = useSWR(
    "erp-maintenance",
    async () =>
      z.array(maintenanceSchema).parse(await api("/maintenance-notices")),
    { refreshInterval: 10000 },
  );
  const devices = useDevices();
  const channels = useSWR(
    write && hasModule(me, "messages") ? "erp-maintenance-channels" : null,
    () => api<{ id: string; name: string }[]>("/maintenance-notices/channels"),
  );
  const [channel, setChannel] = useState("");
  const [creating, setCreating] = useState(false);
  const selected =
    channels.data?.find((item) => item.id === channel) ?? channels.data?.[0];
  const notify = async (id: string, phase: string) => {
    const response = await api<{
      queued: number;
      skipped_no_consent: number;
      already_sent: number;
    }>(`/maintenance-notices/${id}/notify`, {
      body: { channel_id: selected!.id, phase },
    });
    toast.success(
      `${response.queued} aviso(s) na fila; ${response.skipped_no_consent} sem consentimento; ${response.already_sent} já processado(s).`,
    );
    await result.mutate();
  };
  return (
    <>
      <PageHeading
        title="Manutenções"
        description="Avisos no portal dos assinantes atingidos pela janela de manutenção."
        actions={
          write && (
            <Button onClick={() => setCreating(true)}>
              Novo aviso de manutenção
            </Button>
          )
        }
      />
      <Panel
        title="Avisos de manutenção"
        description="O portal apresenta o aviso enquanto estiver em andamento e nos sete dias anteriores ao início."
      >
        {write && hasModule(me, "messages") && (
          <QueryBoundary
            loading={channels.isLoading}
            error={channels.error}
            retry={() => channels.mutate()}
          >
            {channels.data?.length ? (
              <FormField label="Canal para avisar afetados">
                <select
                  className="commercial-select"
                  value={selected?.id ?? ""}
                  onChange={(event) => setChannel(event.target.value)}
                >
                  {channels.data.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </FormField>
            ) : (
              <p className="profile-footnote">
                Nenhum canal de envio disponível. Os avisos continuam visíveis
                no portal.
              </p>
            )}
          </QueryBoundary>
        )}
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {result.data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "Aviso",
                    "Quem é atingido",
                    "Período",
                    "Situação",
                    "Ações",
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <strong>{item.title}</strong>
                      <small className="table-subline">
                        {severities[item.severity] ?? item.severity} ·{" "}
                        {item.message}
                      </small>
                    </TableCell>
                    <TableCell>
                      {item.device_name
                        ? `Via ${item.device_name}`
                        : "Todos os assinantes"}
                      <small className="table-subline">
                        {item.affected_subscribers} assinante(s)
                      </small>
                    </TableCell>
                    <TableCell>
                      {stamp(item.starts_at)}
                      <small className="table-subline">
                        até {stamp(item.ends_at)}
                      </small>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          item.state === "active" ? "warning" : "outline"
                        }
                      >
                        {states[item.state]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="erp-inline-actions">
                        {write &&
                          selected &&
                          item.state !== "canceled" &&
                          (!item.notified_start_at ? (
                            <ActionButton
                              confirm={`Enviar o aviso a ${item.affected_subscribers} assinante(s) afetado(s) pelo canal ${selected.name}? Somente quem consentiu receberá.`}
                              onClick={() => notify(item.id, "start")}
                            >
                              Avisar afetados
                            </ActionButton>
                          ) : (
                            !item.notified_resolved_at && (
                              <ActionButton
                                confirm="Avisar aos mesmos assinantes que o serviço foi normalizado?"
                                onClick={() => notify(item.id, "resolved")}
                              >
                                Avisar normalização
                              </ActionButton>
                            )
                          ))}
                        {write &&
                          ["scheduled", "active"].includes(item.state) && (
                            <ActionButton
                              danger
                              confirm="Cancelar este aviso? Ele deixa de aparecer no portal."
                              onClick={async () => {
                                await api(
                                  `/maintenance-notices/${item.id}/cancel`,
                                  { method: "POST" },
                                );
                                await result.mutate();
                              }}
                            >
                              Cancelar aviso
                            </ActionButton>
                          )}
                      </div>
                      {item.notified_start_at && (
                        <small className="table-subline">
                          Início avisado em {stamp(item.notified_start_at)}
                          {item.notified_resolved_at
                            ? ` · normalização ${stamp(item.notified_resolved_at)}`
                            : ""}
                        </small>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="profile-footnote">Nenhum aviso de manutenção.</p>
          )}
        </QueryBoundary>
      </Panel>
      {creating && (
        <RecordEditor
          title="Novo aviso de manutenção"
          description="O aviso será apresentado no portal do público escolhido. O envio por canal exige uma solicitação separada."
          loading={devices.isLoading}
          error={devices.error}
          retry={() => devices.mutate()}
          initial={{
            title: "",
            message: "",
            severity: "info",
            device_id: "",
            starts_at: localDateTime(
              new Date(Date.now() + 3600000).toISOString(),
            ),
            ends_at: localDateTime(
              new Date(Date.now() + 10800000).toISOString(),
            ),
          }}
          fields={[
            {
              key: "title",
              label: "Título do aviso",
              required: true,
              maxLength: 120,
            },
            {
              key: "message",
              label: "Mensagem ao assinante",
              type: "textarea",
              required: true,
              maxLength: 1000,
            },
            {
              key: "severity",
              label: "Efeito esperado",
              type: "select",
              options: Object.entries(severities).map(([value, label]) => ({
                value,
                label,
              })),
            },
            {
              key: "device_id",
              label: "Quem é atingido",
              type: "select",
              options: [
                { value: "", label: "Todos os assinantes" },
                ...(devices.data ?? [])
                  .filter((d) => !d.driver.startsWith("olt"))
                  .map((d) => ({
                    value: d.id,
                    label: `Quem se conecta por ${d.name}`,
                  })),
              ],
            },
            {
              key: "starts_at",
              label: "Início da manutenção",
              type: "datetime-local",
              required: true,
            },
            {
              key: "ends_at",
              label: "Fim da manutenção",
              type: "datetime-local",
              required: true,
            },
          ]}
          submit="Publicar aviso"
          onClose={() => setCreating(false)}
          onSubmit={async (values) => {
            const starts = new Date(values.starts_at);
            const ends = new Date(values.ends_at);
            if (
              !Number.isFinite(starts.getTime()) ||
              !Number.isFinite(ends.getTime()) ||
              ends <= starts
            )
              throw new Error(
                "O fim deve ser posterior ao início da manutenção.",
              );
            await api("/maintenance-notices", {
              body: {
                title: values.title,
                message: values.message,
                severity: values.severity,
                device_id: values.device_id || null,
                starts_at: starts.toISOString(),
                ends_at: ends.toISOString(),
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
