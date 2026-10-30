import useSWR, { useSWRConfig } from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { OrderDetailsDialog } from "@/components/field-operations";
import { ServiceOrderDetails } from "@/components/service-order-details";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can, hasModule } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { orderDetailSchema, projectOrder } from "./models";
import { WorkActions } from "./work-actions";
import { WorkCollaboration, WorkHistory } from "./work-log";
import { WorkMaterials } from "./work-materials";
import { WorkAttachments } from "./work-attachments";
import {
  formatDocument,
  formatPhone,
  shortCode,
} from "@/features/shared/format";
export function OperationalOrderOverlay() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const id = params.get("ordem");
  if (!id || !can(me, "os:read") || !hasModule(me, "field")) return null;
  return (
    <LiveOrder
      key={id}
      id={id}
      onClose={() => {
        const next = new URLSearchParams(params);
        next.delete("ordem");
        setParams(next, { replace: true });
      }}
    />
  );
}
function LiveOrder({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useSession();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();
  const result = useSWR(["erp-order", id], async ([, id]) =>
    orderDetailSchema.parse(
      await api(`/work-orders/${encodeURIComponent(id)}`),
    ),
  );
  const staff = useSWR("erp-staff", () =>
    api<{ id: string; name: string }[]>("/staff"),
  );
  const order = result.data;
  const refresh = async () => {
    await mutate((key) =>
      typeof key === "string"
        ? ["erp-stock-items", "erp-install-kits"].includes(key)
        : Array.isArray(key) &&
          typeof key[0] === "string" &&
          [
            "erp-order",
            "erp-work-attachments",
            "erp-orders",
            "erp-ticket",
            "erp-unit-search",
            "erp-contract-equipment",
            "erp-agenda",
            "erp-stock-units",
            "erp-stock-moves",
            "erp-stock-events",
          ].includes(key[0]),
    );
  };
  const stamp = (value: string | null) =>
    value ? new Date(value).toLocaleString("pt-BR") : "Não informado";
  return (
    <OrderDetailsDialog
      open
      order={order ? projectOrder(order) : null}
      onClose={onClose}
      description="Registro operacional da visita, conectado ao ERP."
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {order && (
          <ServiceOrderDetails
            key={order.id}
            operational
            order={projectOrder(order)}
            subscriber={{
              id: order.subscriber_id,
              name: order.subscriber_name,
              code: shortCode(order.subscriber_id),
              address:
                order.subscriber_address || "Endereço cadastral não informado",
              phone: order.subscriber_phone || "Telefone não informado",
            }}
            provider={me?.tenant?.name ?? "Provedor"}
            reference={order.created_at}
            printContext={{
              operational: true,
              contractId: order.contract_id,
              serviceAddress: order.service_address,
            }}
            onOpenSubscriber={() =>
              navigate(`/assinantes?ficha=${order.subscriber_id}`)
            }
            facts={
              <ProfileFacts
                items={[
                  ["Serviço solicitado", projectOrder(order).type],
                  [
                    "Técnico responsável",
                    order.assignee_name ?? "Não atribuído",
                  ],
                  ["Agendada para", stamp(order.scheduled_for)],
                  ["Duração prevista", `${order.estimated_minutes} minutos`],
                  [
                    "Endereço do serviço",
                    order.service_address || "Não informado",
                  ],
                  [
                    "Origem do endereço",
                    (
                      {
                        subscriber: "Cadastro do titular",
                        contract: "Instalação do contrato",
                        manual: "Informado na OS",
                      } as Record<string, string>
                    )[order.address_origin] ?? order.address_origin,
                  ],
                  [
                    "Telefone do titular",
                    order.subscriber_phone || "Não informado",
                  ],
                  [
                    "Abertura",
                    `${stamp(order.created_at)} · ${order.created_by_name ?? "Sistema"}`,
                  ],
                  ["Motivo do serviço", order.reason_name || "Não informado"],
                  [
                    "Contrato",
                    order.contract_id
                      ? `Contrato #${shortCode(order.contract_id)}`
                      : "Sem contrato específico",
                  ],
                  [
                    "Protocolo de origem",
                    order.ticket_id
                      ? `Atendimento #${shortCode(order.ticket_id)}`
                      : "Sem protocolo vinculado",
                  ],
                ]}
              />
            }
            execution={
              <>
                <ProfileFacts
                  items={[
                    ["Saída para o local", stamp(order.en_route_at)],
                    ["Início da execução", stamp(order.started_at)],
                    ["Finalização", stamp(order.finished_at)],
                    ["Motivo da espera", order.awaiting_reason || "—"],
                    [
                      "Prazo",
                      order.sla_due_at
                        ? stamp(order.sla_due_at)
                        : "Sem prazo definido",
                    ],
                    [
                      "Relato ou motivo final",
                      order.resolution || "Ainda não registrado",
                    ],
                  ]}
                />
                {order.sla_breached && (
                  <Badge variant="warning">
                    Prazo estourado registrado no ERP
                  </Badge>
                )}
                <QueryBoundary
                  loading={staff.isLoading}
                  error={staff.error}
                  retry={() => staff.mutate()}
                >
                  <WorkActions
                    order={order}
                    staff={staff.data ?? []}
                    refresh={refresh}
                  />
                </QueryBoundary>
              </>
            }
            technical={
              <ProfileSection title="Vínculos da visita">
                <div className="erp-inline-actions">
                  {order.contract_id && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        navigate(`/contratos?contrato=${order.contract_id}`)
                      }
                    >
                      Abrir contrato da OS
                    </Button>
                  )}
                  {order.ticket_id &&
                    can(me, "crm:read") &&
                    hasModule(me, "crm") && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          navigate(`/atendimentos?protocolo=${order.ticket_id}`)
                        }
                      >
                        Abrir protocolo de origem
                      </Button>
                    )}
                </div>
                <p className="profile-footnote">
                  A situação desta visita é independente da confirmação do
                  acesso no equipamento.
                </p>
              </ProfileSection>
            }
            attachments={
              <WorkAttachments id={order.id} status={order.status} />
            }
            sections={
              <div className="commercial-detail-body">
                <div className="profile-two-columns">
                  <div className="erp-stack">
                    <WorkCollaboration
                      order={order}
                      staff={staff.data ?? []}
                      refresh={refresh}
                    />
                    <WorkMaterials order={order} refresh={refresh} />
                  </div>
                  <WorkHistory order={order} refresh={refresh} />
                </div>
              </div>
            }
          />
        )}
      </QueryBoundary>
    </OrderDetailsDialog>
  );
}
