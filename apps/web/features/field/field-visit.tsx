import { useState } from "react";
import { toast } from "sonner";
import {
  ProfileFacts,
  ProfileSection,
} from "@/components/subscriber-profile-sections";
import { Label } from "@/components/ui/label";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { describeLocation, formatDuration } from "./field-model";
import { useWorkVisits } from "./field-hooks";
import { pendingPresence, type FieldLocation } from "./field-queue";
import { useFieldQueue } from "./use-field-queue";
import type { OrderDetail } from "./models";

const stamp = (value: string) => new Date(value).toLocaleString("pt-BR");

/** Posição do aparelho, opcional: recusa ou demora não impedem o registro. */
function currentLocation(): Promise<FieldLocation | null> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator))
    return Promise.resolve(null);
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy_m: Math.min(Math.max(position.coords.accuracy, 0), 100000),
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    ),
  );
}

export function FieldVisit({ order }: { order: OrderDetail }) {
  const visits = useWorkVisits(order.id);
  const queue = useFieldQueue();
  const [share, setShare] = useState(true);
  const data = visits.data;
  const presence = pendingPresence(queue.items, order.id);
  const open = presence.checkIn
    ? !presence.checkOut
    : Boolean(data?.open_visit_id) && !presence.checkOut;
  const allowed = Boolean(data && (data.can_check_in || data.can_check_out));
  const closed = ["done", "canceled"].includes(order.status);
  const canCheckIn =
    allowed && !open && !closed && order.status !== "awaiting_schedule";
  const canCheckOut = allowed && open;
  const act = async (kind: "check_in" | "check_out") => {
    const location = share ? await currentLocation() : null;
    if (share && !location)
      toast.info(
        "Localização do aparelho indisponível; a presença segue sem coordenadas.",
      );
    const outcome = await queue.submit(
      { id: order.id, number: order.number },
      { kind, location },
    );
    if (outcome === "sent")
      toast.success(
        kind === "check_in" ? "Check-in registrado." : "Check-out registrado.",
      );
    else toast.info("Sem conexão: ação guardada na fila deste aparelho.");
  };
  return (
    <ProfileSection
      title="Presença no local"
      caption="Check-in e check-out com horário do servidor. A localização do aparelho é opcional e mede a distância até a instalação."
    >
      <QueryBoundary
        loading={visits.isLoading}
        error={data ? undefined : visits.error}
        retry={() => visits.mutate()}
      >
        {data && (
          <div className="erp-stack">
            {visits.error && (
              <p className="profile-footnote">
                Sem resposta do servidor: exibindo a última consulta.
              </p>
            )}
            <ProfileFacts
              items={[
                [
                  "Tempo em atendimento",
                  formatDuration(data.attendance_seconds),
                ],
                [
                  "Coordenada da instalação",
                  data.site_located
                    ? "Cadastrada no contrato"
                    : "Não cadastrada",
                ],
              ]}
            />
            {data.items.map((visit) => (
              <div className="erp-contract-card" key={visit.id}>
                <strong>{visit.technician_name}</strong>
                <small>
                  Check-in em {stamp(visit.check_in_at)} ·{" "}
                  {describeLocation(
                    visit.check_in_located,
                    visit.check_in_distance_m,
                    visit.check_in_accuracy_m,
                    data.site_located,
                  )}
                </small>
                <small>
                  {visit.check_out_at
                    ? `Check-out em ${stamp(visit.check_out_at)} · ${
                        visit.check_out_reason === "os_finished"
                          ? "encerrado com a OS"
                          : describeLocation(
                              visit.check_out_located,
                              visit.check_out_distance_m,
                              visit.check_out_accuracy_m,
                              data.site_located,
                            )
                      }`
                    : "Em atendimento"}
                </small>
                <small>
                  Duração: {formatDuration(visit.seconds)}
                  {visit.check_in_device_at
                    ? ` · horário do aparelho no check-in: ${stamp(visit.check_in_device_at)}`
                    : ""}
                </small>
              </div>
            ))}
            {!data.items.length && (
              <p className="profile-footnote">Nenhuma presença registrada.</p>
            )}
            {(presence.checkIn || presence.checkOut) && (
              <p className="profile-footnote">
                Há presença aguardando envio na fila deste aparelho.
              </p>
            )}
            {(canCheckIn || canCheckOut) && (
              <>
                <Label className="erp-inline-actions">
                  <input
                    type="checkbox"
                    checked={share}
                    onChange={(event) => setShare(event.target.checked)}
                  />
                  Enviar a localização do aparelho
                </Label>
                <div className="erp-inline-actions">
                  {canCheckIn && (
                    <ActionButton onClick={() => act("check_in")}>
                      Fazer check-in
                    </ActionButton>
                  )}
                  {canCheckOut && (
                    <ActionButton onClick={() => act("check_out")}>
                      Fazer check-out
                    </ActionButton>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}
