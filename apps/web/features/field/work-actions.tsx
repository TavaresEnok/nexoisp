import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { localDateTime, type OrderDetail } from "./models";
export function WorkActions({
  order,
  staff,
  refresh,
}: {
  order: OrderDetail;
  staff: { id: string; name: string }[];
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const [editor, setEditor] = useState<
    "assign" | "awaiting_schedule" | "done" | "canceled" | null
  >(null);
  const writable =
    can(me, "os:write") && !["done", "canceled"].includes(order.status);
  const move = async (status: string) => {
    await api(`/work-orders/${order.id}/status`, { body: { status } });
    await refresh();
  };
  if (!writable) return null;
  return (
    <>
      <div className="erp-inline-actions">
        <Button variant="outline" size="sm" onClick={() => setEditor("assign")}>
          Responsável e agendamento
        </Button>
        {order.status === "open" && (
          <ActionButton onClick={() => move("analysis")}>
            Em análise
          </ActionButton>
        )}
        {["open", "analysis", "scheduled"].includes(order.status) && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditor("awaiting_schedule")}
            >
              Aguardar agendamento
            </Button>
            <ActionButton
              disabled={!order.assignee_id}
              onClick={() => move("en_route")}
            >
              Saí para o local
            </ActionButton>
          </>
        )}
        {!["in_progress", "awaiting_schedule"].includes(order.status) && (
          <ActionButton onClick={() => move("in_progress")}>
            Iniciar execução
          </ActionButton>
        )}
        {order.status === "in_progress" && (
          <>
            <ActionButton onClick={() => move("open")}>
              Devolver para a fila
            </ActionButton>
            <Button onClick={() => setEditor("done")}>Concluir serviço</Button>
          </>
        )}
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setEditor("canceled")}
        >
          Cancelar OS
        </Button>
      </div>
      {editor === "assign" && (
        <RecordEditor
          title="Responsável e agendamento"
          initial={{
            assignee: order.assignee_id ?? "",
            scheduled: localDateTime(order.scheduled_for),
          }}
          fields={[
            {
              key: "assignee",
              label: "Técnico responsável",
              type: "select",
              options: [
                { value: "", label: "Não atribuído" },
                ...staff.map((user) => ({ value: user.id, label: user.name })),
              ],
            },
            {
              key: "scheduled",
              label: "Agendada para",
              type: "datetime-local",
            },
          ]}
          onClose={() => setEditor(null)}
          onSubmit={async (values) => {
            const changes: Record<string, unknown> = {};
            if (values.assignee !== (order.assignee_id ?? ""))
              changes.assignee_id = values.assignee || null;
            if (values.scheduled !== localDateTime(order.scheduled_for))
              changes.scheduled_for = values.scheduled
                ? new Date(values.scheduled).toISOString()
                : null;
            if (Object.keys(changes).length)
              await api(`/work-orders/${order.id}`, {
                method: "PATCH",
                body: changes,
              });
            setEditor(null);
            await refresh();
          }}
        />
      )}
      {editor && editor !== "assign" && (
        <RecordEditor
          title={
            editor === "done"
              ? "Concluir ordem de serviço"
              : editor === "canceled"
                ? "Cancelar ordem de serviço"
                : "Aguardar agendamento"
          }
          description={
            editor === "done"
              ? "Descreva o serviço executado. A conclusão será registrada com seu usuário."
              : "Informe o motivo para registrar a mudança no histórico."
          }
          initial={{ reason: "" }}
          fields={[
            {
              key: "reason",
              label:
                editor === "done"
                  ? "Relato da execução"
                  : "Motivo da alteração",
              type: "textarea",
              required: true,
              maxLength: editor === "awaiting_schedule" ? 300 : 2000,
            },
          ]}
          onClose={() => setEditor(null)}
          submit="Confirmar alteração"
          onSubmit={async (values) => {
            await api(`/work-orders/${order.id}/status`, {
              body: {
                status: editor,
                ...(editor === "awaiting_schedule"
                  ? { reason: values.reason }
                  : { resolution: values.reason }),
              },
            });
            setEditor(null);
            await refresh();
          }}
        />
      )}
    </>
  );
}
