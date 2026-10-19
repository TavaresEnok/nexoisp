import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
const eventLabels: Record<string, string> = {
  "ticket.opened": "Chamado pelo portal",
  "ticket.subscriber_reply": "Resposta do assinante",
  "work_order.created": "OS aberta",
  "work_order.assigned": "OS atribuída",
};
const notification = z.object({
  webhook_url: z.string().nullable(),
  recent: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      created_at: z.string(),
      event: z.string(),
      text: z.string(),
      status: z.string(),
      attempts: z.coerce.number(),
      last_error: z.string().nullable(),
    }),
  ),
});
export function TeamNotices() {
  const result = useSWR(
    "erp-notifications",
    async () => notification.parse(await api("/notifications")),
    { refreshInterval: 10000 },
  );
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <>
      <PageHeading
        title="Avisos à equipe"
        description="Eventos de atendimento e ordens de serviço enviados ao canal interno do provedor."
      />
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <div className="erp-stack">
          <Panel
            title="Canal da equipe"
            description="O destino recebe POST JSON com o campo text. As mensagens incluem o nome do assinante; use um canal restrito à equipe."
            action={
              <Button variant="outline" onClick={() => setEditing(true)}>
                Configurar webhook da equipe
              </Button>
            }
          >
            <p>{result.data?.webhook_url ?? "Avisos desligados."}</p>
            <div className="erp-inline-actions">
              <ActionButton
                disabled={!result.data?.webhook_url}
                confirm="Enviar uma mensagem de teste ao canal da equipe configurado?"
                onClick={async () => {
                  await api("/notifications/test", { body: {} });
                  setMessage("O destino recebeu o aviso de teste.");
                }}
              >
                Enviar aviso de teste
              </ActionButton>
              <ActionButton
                confirm="Entregar os avisos pendentes ao canal configurado?"
                onClick={async () => {
                  const response = await api<{ sent: number; failed: number }>(
                    "/notifications/deliver",
                    { body: {} },
                  );
                  setMessage(
                    `${response.sent} entregue(s), ${response.failed} com falha.`,
                  );
                  await result.mutate();
                }}
              >
                Entregar avisos pendentes
              </ActionButton>
            </div>
            {message && <p role="status">{message}</p>}
          </Panel>
          <OperationalCatalog
            title="Últimos avisos da equipe"
            description="A entrega periódica depende dos jobs habilitados. Após cinco tentativas sem sucesso, o aviso é marcado como falha."
            columns={[
              "Quando",
              "Evento",
              "Mensagem",
              "Situação",
              "Tentativas / erro",
            ]}
            rows={(result.data?.recent ?? []).map((item) => ({
              id: String(item.id),
              cells: [
                new Date(item.created_at).toLocaleString("pt-BR"),
                eventLabels[item.event] ?? item.event,
                item.text,
                (
                  {
                    pending: "Pendente",
                    sent: "Entregue",
                    failed: "Falhou",
                  } as Record<string, string>
                )[item.status] ?? item.status,
                `${item.attempts}${item.last_error ? ` · ${item.last_error}` : ""}`,
              ],
            }))}
          />
        </div>
      </QueryBoundary>
      {editing && (
        <RecordEditor
          title="Webhook da equipe"
          description="Deixe vazio para desligar os avisos. O servidor valida os destinos permitidos."
          initial={{ url: result.data?.webhook_url ?? "" }}
          fields={[
            {
              key: "url",
              label: "Endereço do webhook da equipe",
              maxLength: 500,
            },
          ]}
          onClose={() => setEditing(false)}
          onSubmit={async (values) => {
            await api("/notifications/settings", {
              method: "PUT",
              body: { webhook_url: values.url || null },
            });
            setEditing(false);
            await result.mutate();
          }}
        />
      )}
    </>
  );
}
