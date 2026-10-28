import useSWR from "swr";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { stamp } from "./models";

const count = z.number().int().nonnegative();
const instant = z.string().min(1).nullable();
const nasSchema = z.object({
  device_id: z.string().min(1),
  name: z.string(),
  nas_ip: z.string().min(1).nullable(),
  acct_interim_seconds: count.nullable(),
  threshold_seconds: count,
  threshold_source: z.enum(["interim", "default"]),
  last_packet_at: instant,
  last_accounting_at: instant,
  open_sessions: count,
  overdue_sessions: count,
  oldest_open_seen_at: instant,
  events_24h: count,
  max_reported_delay_seconds_24h: count.nullable(),
  quarantined_events: count,
  pending_usage_sessions: count,
});
const telemetrySchema = z.object({
  items: z.array(nasSchema),
  generated_at: instant,
  last_usage_applied_at: instant,
  limit: z.number().int().positive(),
  source: z.literal("radius_acct"),
  open_accounting_is_online_proof: z.literal(false),
  packet_recency_is_policy_proof: z.literal(false),
});

function thresholdOrigin(source: "interim" | "default") {
  return source === "interim" ? "interim configurado" : "padrão 15 min";
}

export function RadiusAccountingTelemetry() {
  const path = "/radius/accounting/telemetry";
  const result = useSWR(["erp-radius-telemetry", path], async () =>
    telemetrySchema.parse(await api(path)),
  );
  const data = result.data;
  return (
    <ProfileSection
      title="Telemetria de accounting"
      caption="Atraso, recência e pendências de apuração por concentrador."
    >
      <p className="profile-footnote">
        Contabilização aberta não comprova sessão online e recência de pacote
        não comprova política aplicada no concentrador.
      </p>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <>
            <p className="max-w-full text-sm leading-relaxed">
              {data.last_usage_applied_at
                ? `Consumo apurado até ${stamp(data.last_usage_applied_at)}`
                : "ainda não apurado"}
            </p>
            {data.generated_at && (
              <p className="profile-footnote">
                Consulta gerada em {stamp(data.generated_at)}.
              </p>
            )}
            {data.items.length === 0 ? (
              <p className="profile-footnote">
                Nenhum concentrador RADIUS para esta telemetria.
              </p>
            ) : (
              <div className="grid max-w-full grid-cols-[minmax(0,1fr)]">
                <div className="min-w-0 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {[
                          "Nome / IP",
                          "Último pacote",
                          "Última contabilização",
                          "Sessões abertas",
                          "Sem atualização além do limite",
                          "Maior atraso informado pelo NAS em 24 h",
                          "Eventos em quarentena",
                          "Contabilizações pendentes de apuração de consumo",
                        ].map((label) => (
                          <TableHead key={label}>{label}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.items.map((item) => {
                        const attention =
                          item.overdue_sessions > 0 ||
                          item.pending_usage_sessions > 0;
                        return (
                          <TableRow key={item.device_id}>
                            <TableCell>
                              <strong>{item.name || "Sem nome"}</strong>
                              <small className="table-subline">
                                {item.nas_ip ?? "IP não informado"}
                              </small>
                              {attention && (
                                <Badge
                                  variant="warning"
                                  className="mt-2 h-auto whitespace-normal"
                                >
                                  {item.overdue_sessions > 0 &&
                                  item.pending_usage_sessions > 0
                                    ? "Sem atualização além do limite e apuração pendente"
                                    : item.overdue_sessions > 0
                                      ? "Sem atualização além do limite"
                                      : "Contabilizações pendentes de apuração de consumo"}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell>{stamp(item.last_packet_at)}</TableCell>
                            <TableCell>
                              {stamp(item.last_accounting_at)}
                            </TableCell>
                            <TableCell>{item.open_sessions}</TableCell>
                            <TableCell>
                              {item.overdue_sessions}
                              <small className="table-subline">
                                limite {item.threshold_seconds} s ·{" "}
                                {thresholdOrigin(item.threshold_source)}
                              </small>
                            </TableCell>
                            <TableCell>
                              {item.max_reported_delay_seconds_24h === null
                                ? "Não informado"
                                : `${item.max_reported_delay_seconds_24h} s`}
                              <small className="table-subline">
                                Eventos em 24 h: {item.events_24h}
                              </small>
                            </TableCell>
                            <TableCell>{item.quarantined_events}</TableCell>
                            <TableCell>{item.pending_usage_sessions}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </>
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}
