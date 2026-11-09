import { toast } from "sonner";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/features/shared/action";
import { fieldActionLabels, type FieldAction } from "./field-queue";
import { useFieldQueue, type SentFieldAction } from "./use-field-queue";

const stamp = (value: string) => new Date(value).toLocaleString("pt-BR");

function describe(action: FieldAction) {
  const body = action.body;
  if (action.kind === "note") return String(body.note ?? "");
  if (action.kind === "checklist_add")
    return Array.isArray(body.items) ? String(body.items[0] ?? "") : "";
  if (action.kind === "checklist_done")
    return body.done === true ? "Item concluído" : "Item reaberto";
  return "latitude" in body
    ? "Com localização do aparelho"
    : "Sem localização do aparelho";
}

/** Ações de campo guardadas neste aparelho, com estado e envio manual. */
export function FieldQueuePanel({ orderId }: { orderId?: string }) {
  const queue = useFieldQueue({ autoFlush: true });
  const items = queue.items.filter(
    (item) => !orderId || item.order_id === orderId,
  );
  const sent = queue.sent.filter(
    (item) => !orderId || item.order_id === orderId,
  );
  const pending = items.filter((item) => item.state !== "refused").length;
  if (!queue.ready) return null;
  if (!items.length && !sent.length && queue.online && !queue.storageError)
    return null;
  const row = (
    action: FieldAction | SentFieldAction,
    state: "pending" | "sending" | "sent" | "refused",
  ) => (
    <div className="erp-contract-card" key={`${state}:${action.key}`}>
      <strong>
        {fieldActionLabels[action.kind]} · OS {action.order_number}
      </strong>
      <small>
        Registrado no aparelho em {stamp(action.queued_at)}
        {"sent_at" in action ? ` · confirmado em ${stamp(action.sent_at)}` : ""}
      </small>
      {/* Depois de confirmado, o conteúdo passa a constar no histórico da OS. */}
      {state !== "sent" && (
        <p className="whitespace-pre-wrap">{describe(action)}</p>
      )}
      <div className="erp-inline-actions">
        <Badge
          variant={
            state === "sent"
              ? "success"
              : state === "refused"
                ? "destructive"
                : state === "sending"
                  ? "info"
                  : "warning"
          }
        >
          {
            {
              pending: "Pendente",
              sending: "Enviando",
              sent: "Enviado",
              refused: "Recusado",
            }[state]
          }
        </Badge>
        {state === "refused" && (
          <ActionButton
            label={`Descartar ${fieldActionLabels[action.kind].toLowerCase()} recusado da OS ${action.order_number}`}
            onClick={() => queue.discard(action.key)}
          >
            Descartar
          </ActionButton>
        )}
      </div>
      {state === "refused" && (
        <p role="alert">Motivo: {"reason" in action ? action.reason : ""}</p>
      )}
    </div>
  );
  return (
    <ProfileSection
      title="Ações de campo neste aparelho"
      caption={
        queue.online
          ? "Enviadas automaticamente ao reconectar. O horário oficial é o do servidor; o do aparelho fica como informação adicional."
          : "Sem conexão: as ações ficam guardadas neste aparelho e serão enviadas ao reconectar."
      }
      action={
        <ActionButton
          disabled={!queue.online || !pending}
          onClick={async () => {
            const result = await queue.flush();
            if (result?.interrupted)
              throw new Error(
                "Sem resposta do servidor; as ações continuam pendentes.",
              );
            if (result?.refused.length)
              toast.error(
                `${result.refused.length} ação(ões) recusada(s); confira o motivo.`,
              );
            else if (result?.sent.length)
              toast.success("Ações de campo enviadas.");
          }}
        >
          Enviar agora
        </ActionButton>
      }
    >
      {queue.storageError && <p role="alert">{queue.storageError}</p>}
      {!items.length && !sent.length && (
        <p className="profile-footnote">Nenhuma ação guardada.</p>
      )}
      {items.map((item) => row(item, item.state))}
      {sent.map((item) => row(item, "sent"))}
    </ProfileSection>
  );
}
