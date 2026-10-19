import useSWR from "swr";
import { useSearchParams } from "react-router-dom";
import { z } from "zod";
import { Clock3, MapPin, Phone } from "lucide-react";
import { Panel, PageHeading, Status } from "@/components/workspace-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { erpClient } from "@/platform/erp-client";
import { orderSchema, projectOrder } from "./models";

export function MyWork() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const result = useSWR(
    ["erp-orders", "mine-pending"],
    async () => {
      const response = await erpClient.request(
        "/work-orders?mine=1&status=pending&limit=50",
      );
      if (response.total === null)
        throw new Error("O servidor não informou a contagem de OS.");
      return {
        rows: z.array(orderSchema).parse(response.data),
        total: response.total,
        readAt: new Date().toISOString(),
      };
    },
    { refreshInterval: 30000 },
  );
  return (
    <>
      <ConnectedNotice demo={me?.demo} />
      <PageHeading
        title="Meu trabalho"
        description="Suas ordens pendentes, atualizadas a cada 30 segundos. Requer conexão com o provedor."
      />
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data && (
          <p className="profile-footnote">
            {result.data.rows.length} de {result.data.total} OS pendentes
            atribuídas a você · limite de 50 nesta consulta.
          </p>
        )}
        {!result.data?.rows.length && (
          <Panel title="Sua fila de trabalho">
            <p className="profile-footnote">
              Nenhuma OS pendente atribuída a você.
            </p>
          </Panel>
        )}
        <div className="profile-two-columns">
          {result.data?.rows.map((row) => {
            const order = projectOrder(row);
            return (
              <Panel
                key={row.id}
                title={`OS ${row.number} · ${order.type}`}
                action={<Status value={order.status} />}
              >
                <div className="erp-stack">
                  <strong>{row.subscriber_name}</strong>
                  <p className="erp-inline-actions">
                    <MapPin size={14} />
                    {row.service_address || "Endereço não informado"}
                  </p>
                  <div className="erp-inline-actions">
                    {row.service_address && (
                      <a
                        className="profile-text-action"
                        target="_blank"
                        rel="noreferrer"
                        href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(row.service_address)}`}
                      >
                        Abrir mapa
                      </a>
                    )}
                    {row.subscriber_phone && (
                      <a
                        className="profile-text-action"
                        href={`tel:${row.subscriber_phone.replace(/[^+\d]/g, "")}`}
                      >
                        <Phone size={14} />
                        {row.subscriber_phone}
                      </a>
                    )}
                  </div>
                  <p className="erp-inline-actions">
                    <Clock3 size={14} />
                    {order.time} · {order.duration} minutos
                    {order.late && (
                      <Badge variant="warning">Agendamento vencido</Badge>
                    )}
                  </p>
                  <p className="whitespace-pre-wrap">{row.description}</p>
                  <Button
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.set("ordem", row.id);
                      setParams(next);
                    }}
                  >
                    {row.status === "in_progress"
                      ? "Continuar atendimento"
                      : `Abrir OS ${row.number}`}
                  </Button>
                </div>
              </Panel>
            );
          })}
        </div>
      </QueryBoundary>
    </>
  );
}
