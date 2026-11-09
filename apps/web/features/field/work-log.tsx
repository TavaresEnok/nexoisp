import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField, MutationForm } from "@/features/shared/form";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { date } from "@/lib/format";
import { orderStates } from "./labels";
import type { OrderDetail } from "./models";
import { formatDistance } from "./field-model";
import type { FieldAction } from "./field-queue";
import { useFieldQueue } from "./use-field-queue";

const queuedNotice = "Sem conexão: registro guardado na fila deste aparelho.";
export function WorkCollaboration({
  order,
  staff,
  refresh,
}: {
  order: OrderDetail;
  staff: { id: string; name: string }[];
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const writable =
    can(me, "os:write") && !["done", "canceled"].includes(order.status);
  const [adding, setAdding] = useState(false);
  const [kit, setKit] = useState("");
  const [label, setLabel] = useState("");
  const queue = useFieldQueue();
  const target = { id: order.id, number: order.number };
  const kits = useSWR(
    writable && can(me, "stock:read") ? "erp-install-kits" : null,
    () => api<{ id: string; name: string; active: boolean }[]>("/install-kits"),
  );
  return (
    <div className="erp-stack">
      <ProfileSection
        title="Equipe da visita"
        action={
          writable && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              Adicionar auxiliar
            </Button>
          )
        }
      >
        <div className="erp-inline-actions">
          {order.helpers.length ? (
            order.helpers.map((helper) => (
              <div className="erp-inline-actions" key={helper.user_id}>
                <Badge variant="outline">{helper.name}</Badge>
                {writable && (
                  <ActionButton
                    onClick={async () => {
                      await api(
                        `/work-orders/${order.id}/helpers/${helper.user_id}`,
                        { method: "DELETE" },
                      );
                      await refresh();
                    }}
                  >
                    Remover {helper.name}
                  </ActionButton>
                )}
              </div>
            ))
          ) : (
            <p className="profile-footnote">Nenhum auxiliar vinculado.</p>
          )}
        </div>
      </ProfileSection>
      <ProfileSection title="Checklist da visita">
        <div className="erp-stack">
          {order.checklist.map((item) => (
            <ChecklistItem
              key={item.id}
              item={item}
              writable={writable}
              queued={queue.items.filter(
                (action) =>
                  action.kind === "checklist_done" &&
                  action.state !== "refused" &&
                  action.path.endsWith(
                    `/checklist/${encodeURIComponent(String(item.id))}`,
                  ),
              )}
              onToggle={async (done) => {
                const outcome = await queue.submit(target, {
                  kind: "checklist_done",
                  item_id: String(item.id),
                  done,
                });
                if (outcome === "queued") toast.info(queuedNotice);
                else await refresh();
              }}
            />
          ))}
          {!order.checklist.length && (
            <p className="profile-footnote">Nenhum item de checklist.</p>
          )}
          {queue.items
            .filter(
              (action) =>
                action.order_id === order.id &&
                action.kind === "checklist_add" &&
                action.state !== "refused",
            )
            .map((action) => (
              <small className="text-muted-foreground" key={action.key}>
                {Array.isArray(action.body.items)
                  ? String(action.body.items[0])
                  : "Item"}{" "}
                · aguardando envio
              </small>
            ))}
          {writable && (
            <MutationForm
              submit="Adicionar ao checklist"
              onSubmit={async () => {
                const outcome = await queue.submit(target, {
                  kind: "checklist_add",
                  label,
                });
                setLabel("");
                if (outcome === "queued") toast.info(queuedNotice);
                else await refresh();
              }}
            >
              <FormField label="Novo item do checklist">
                <Input
                  required
                  minLength={2}
                  maxLength={160}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </FormField>
            </MutationForm>
          )}
        </div>
      </ProfileSection>
      {writable && can(me, "stock:read") && (
        <ProfileSection
          title="Kit de instalação"
          caption="A aplicação registra a saída dos materiais do kit nesta OS."
        >
          <QueryBoundary
            loading={kits.isLoading}
            error={kits.error}
            retry={() => kits.mutate()}
          >
            <FormField label="Kit para aplicar">
              <select
                className="commercial-select"
                value={kit}
                onChange={(e) => setKit(e.target.value)}
              >
                <option value="">Selecione um kit</option>
                {kits.data
                  ?.filter((kit) => kit.active)
                  .map((kit) => (
                    <option key={kit.id} value={kit.id}>
                      {kit.name}
                    </option>
                  ))}
              </select>
            </FormField>
            <ActionButton
              disabled={!kit}
              confirm="Registrar a saída de todos os itens do kit nesta OS?"
              onClick={async () => {
                await api(`/work-orders/${order.id}/kit`, {
                  body: { kit_id: kit },
                });
                setKit("");
                await refresh();
              }}
            >
              Aplicar kit
            </ActionButton>
          </QueryBoundary>
        </ProfileSection>
      )}
      {adding && (
        <RecordEditor
          title="Adicionar auxiliar"
          initial={{ user_id: "" }}
          fields={[
            {
              key: "user_id",
              label: "Técnico auxiliar",
              type: "select",
              required: true,
              options: [
                { value: "", label: "Selecione um técnico" },
                ...staff
                  .filter(
                    (user) =>
                      user.id !== order.assignee_id &&
                      !order.helpers.some(
                        (helper) => helper.user_id === user.id,
                      ),
                  )
                  .map((user) => ({ value: user.id, label: user.name })),
              ],
            },
          ]}
          onClose={() => setAdding(false)}
          onSubmit={async (values) => {
            await api(`/work-orders/${order.id}/helpers`, { body: values });
            setAdding(false);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
function ChecklistItem({
  item,
  writable,
  queued,
  onToggle,
}: {
  item: OrderDetail["checklist"][number];
  writable: boolean;
  queued: FieldAction[];
  onToggle: (done: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [pendingDone, setPendingDone] = useState<boolean | null>(null);
  const last = queued.at(-1);
  const queuedDone = last ? last.body.done === true : null;
  return (
    <div>
      <Label className="erp-inline-actions">
        <input
          type="checkbox"
          checked={pendingDone ?? queuedDone ?? item.done}
          disabled={!writable || busy}
          onChange={async (e) => {
            const done = e.target.checked;
            setPendingDone(done);
            setBusy(true);
            try {
              await onToggle(done);
            } catch (error) {
              toast.error((error as Error).message);
            } finally {
              setPendingDone(null);
              setBusy(false);
            }
          }}
        />
        {item.label}
      </Label>
      {last && (
        <small className="text-muted-foreground">Aguardando envio</small>
      )}
      {item.done && !last && (
        <small className="text-muted-foreground">
          {item.done_by_name ?? "Equipe"} ·{" "}
          {item.done_at ? date(item.done_at) : ""}
        </small>
      )}
    </div>
  );
}
export function WorkHistory({
  order,
  refresh,
}: {
  order: OrderDetail;
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const [note, setNote] = useState("");
  const queue = useFieldQueue();
  const located = (detail: Record<string, unknown>) =>
    typeof detail.distance_m === "number"
      ? `A ${formatDistance(detail.distance_m)} da instalação`
      : detail.located === true
        ? "Localização registrada"
        : "Sem localização do aparelho";
  const labels: Record<string, string> = {
    created: "OS aberta",
    status: "Situação alterada",
    assigned: "Responsável alterado",
    scheduled: "Agendamento alterado",
    note: "Anotação",
    material: "Material registrado",
    sla_breached: "Prazo excedido",
    helper_added: "Auxiliar incluído",
    helper_removed: "Auxiliar removido",
    checklist: "Checklist atualizado",
    checklist_done: "Item concluído",
    checklist_undone: "Item reaberto",
    check_in: "Check-in no local",
    check_out: "Check-out",
    signature: "Assinatura do cliente",
    visits_closed: "Presenças encerradas com a OS",
  };
  return (
    <ProfileSection title="Histórico da ordem">
      {can(me, "os:write") && (
        <MutationForm
          submit="Anotar na OS"
          onSubmit={async () => {
            const outcome = await queue.submit(
              { id: order.id, number: order.number },
              { kind: "note", note },
            );
            setNote("");
            if (outcome === "queued") toast.info(queuedNotice);
            else await refresh();
          }}
        >
          <FormField label="Anotação da OS">
            <Input
              required
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </FormField>
        </MutationForm>
      )}
      <div className="profile-recent">
        {order.events.map((event, index) => (
          <div key={index}>
            <span className="timeline-dot" />
            <div>
              <strong>{labels[event.event] ?? event.event}</strong>
              <p>
                {event.event === "status"
                  ? `${orderStates[String(event.detail.from)] ?? event.detail.from} → ${orderStates[String(event.detail.to)] ?? event.detail.to}`
                  : event.event === "assigned"
                    ? String(event.detail.to ?? "Sem responsável")
                    : event.event === "scheduled"
                      ? event.detail.for
                        ? new Date(String(event.detail.for)).toLocaleString(
                            "pt-BR",
                          )
                        : "Agendamento removido"
                      : event.event === "note"
                        ? String(event.detail.note ?? "")
                        : event.event === "check_in" ||
                            event.event === "check_out"
                          ? located(event.detail)
                          : event.event === "signature"
                            ? "Assinatura registrada como documento privado da OS"
                            : event.event === "visits_closed"
                              ? `${String(event.detail.count ?? "")} presença(s) em aberto encerrada(s)`
                              : event.event === "material"
                                ? `${event.detail.item ?? "Material"} × ${event.detail.qty ?? ""}${event.detail.serial ? ` · ${event.detail.serial}` : ""}`
                                : String(
                                    event.detail.item ??
                                      event.detail.name ??
                                      "",
                                  )}
              </p>
              <small>
                {new Date(event.at).toLocaleString("pt-BR")} ·{" "}
                {event.actor_name ?? "Sistema"}
              </small>
            </div>
          </div>
        ))}
      </div>
    </ProfileSection>
  );
}
