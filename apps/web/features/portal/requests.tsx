import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Panel } from "@/components/workspace-ui";
import { OperationalCatalog } from "@/components/operational-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { RecordEditor } from "@/features/shared/record-editor";
import { MutationForm, FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { api } from "@/platform/erp-client";
import { acceptance, ticket, ticketDetail, portalDate } from "./models";
import { useCreateRequest } from "@/features/shared/create-request";
const ticketState = (value: string) =>
  (
    ({
      open: "Em análise",
      waiting: "Aguardando sua resposta",
      closed: "Encerrado",
    }) as Record<string, string>
  )[value] ?? value;
export function PortalAcceptances({
  standalone,
}: { standalone?: boolean } = {}) {
  const result = useSWR(
    "portal-acceptances",
    async () => z.array(acceptance).parse(await api("/portal/acceptances")),
    { refreshInterval: 30000 },
  );
  const [opened, setOpened] = useState<z.infer<typeof acceptance> | null>(null);
  const [agree, setAgree] = useState(false);
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {(standalone || Boolean(result.data?.length)) && (
        <Panel
          title="Meus documentos"
          description="Até cinquenta pedidos de aceite não cancelados, conforme a consulta do provedor."
        >
          {!result.data?.length && <p>Nenhum documento aguardando aceite.</p>}
          <div className="erp-stack">
            {result.data?.map((item) => (
              <div className="erp-contract-card" key={item.id}>
                <header>
                  <strong>{item.title}</strong>
                  <span>
                    {item.status === "accepted"
                      ? `Aceito em ${portalDate(item.accepted_at!)}`
                      : "Aguardando sua leitura"}
                  </span>
                </header>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setOpened(item);
                    setAgree(false);
                  }}
                >
                  {item.status === "pending"
                    ? "Ler e aceitar"
                    : "Ler documento aceito"}
                </Button>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {opened && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setOpened(null);
          }}
        >
          <DialogContent className="erp-editor">
            <DialogHeader>
              <DialogTitle>{opened.title}</DialogTitle>
              <DialogDescription>
                {opened.status === "pending"
                  ? "Leia o texto completo antes de concordar."
                  : "Texto registrado no pedido de aceite."}
              </DialogDescription>
            </DialogHeader>
            <p className="whitespace-pre-wrap">{opened.body}</p>
            {opened.status === "pending" && (
              <MutationForm
                submit="Aceitar documento"
                onCancel={() => setOpened(null)}
                onSubmit={async () => {
                  if (!agree)
                    throw new Error("Confirme que leu e concorda com o texto.");
                  await api(`/portal/acceptances/${opened.id}/accept`, {
                    body: { agree: true },
                  });
                  setOpened(null);
                  await result.mutate();
                }}
              >
                <label className="erp-inline-actions">
                  <input
                    type="checkbox"
                    required
                    checked={agree}
                    onChange={(event) => setAgree(event.target.checked)}
                  />
                  Li o texto acima e concordo.
                </label>
                <p className="profile-footnote">
                  O aceite simples registra o texto, a data, a hora e o endereço
                  de rede da sessão autenticada.
                </p>
              </MutationForm>
            )}
          </DialogContent>
        </Dialog>
      )}
    </QueryBoundary>
  );
}
export function PortalSurveys({ standalone }: { standalone?: boolean } = {}) {
  const result = useSWR("portal-surveys", async () =>
    z
      .array(z.object({ id: z.string(), work_order_number: z.coerce.number() }))
      .parse(await api("/portal/surveys")),
  );
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <QueryBoundary
      loading={result.isLoading}
      error={result.error}
      retry={() => result.mutate()}
    >
      {(standalone || Boolean(result.data?.length)) && (
        <Panel
          title="Como foi o atendimento?"
          description="Avalie as ordens de serviço concluídas."
        >
          {!result.data?.length && (
            <p>Nenhuma ordem de serviço aguardando avaliação.</p>
          )}
          <div className="erp-stack">
            {result.data?.map((item) => (
              <div className="erp-contract-card" key={item.id}>
                <header>
                  <strong>Ordem de serviço #{item.work_order_number}</strong>
                </header>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(item.id)}
                >
                  Avaliar OS {item.work_order_number}
                </Button>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {editing && (
        <RecordEditor
          title="Avaliar atendimento"
          initial={{ score: "", comment: "" }}
          fields={[
            {
              key: "score",
              label: "Nota do atendimento",
              type: "select",
              required: true,
              options: [
                { value: "", label: "Selecione a nota" },
                ...[1, 2, 3, 4, 5].map((value) => ({
                  value: String(value),
                  label: `${value} de 5`,
                })),
              ],
            },
            {
              key: "comment",
              label: "Comentário da avaliação",
              type: "textarea",
              maxLength: 500,
            },
          ]}
          onClose={() => setEditing(null)}
          submit="Enviar avaliação"
          onSubmit={async (values) => {
            await api(`/portal/surveys/${editing}`, {
              body: {
                score: Number(values.score),
                comment: values.comment || null,
              },
            });
            setEditing(null);
            await result.mutate();
          }}
        />
      )}
    </QueryBoundary>
  );
}
export function PortalTickets() {
  const result = useSWR(
    "portal-tickets",
    async () => z.array(ticket).parse(await api("/portal/tickets")),
    { refreshInterval: 20000 },
  );
  const [creating, setCreating] = useState(false);
  useCreateRequest("chamado", () => setCreating(true));
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <OperationalCatalog
          title="Meus atendimentos"
          description="Até cinquenta protocolos do seu cadastro. As notas internas da equipe não são exibidas no portal."
          columns={["Protocolo", "Assunto", "Situação", "Atualizado"]}
          actions={
            <Button onClick={() => setCreating(true)}>Abrir chamado</Button>
          }
          rows={(result.data ?? []).map((item) => ({
            id: item.id,
            cells: [
              `#${item.number}`,
              item.subject,
              ticketState(item.status),
              portalDate(item.updated_at),
            ],
            actions: (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOpened(item.id)}
              >
                Ver protocolo {item.number}
              </Button>
            ),
          }))}
        />
      </QueryBoundary>
      {creating && (
        <RecordEditor
          title="Abrir chamado"
          initial={{ subject: "", category: "technical", body: "" }}
          fields={[
            {
              key: "subject",
              label: "Assunto do chamado",
              required: true,
              maxLength: 200,
            },
            {
              key: "category",
              label: "Categoria do chamado",
              type: "select",
              options: [
                { value: "technical", label: "Técnico" },
                { value: "financial", label: "Financeiro" },
                { value: "commercial", label: "Comercial" },
                { value: "other", label: "Outro" },
              ],
            },
            {
              key: "body",
              label: "Descrição do chamado",
              type: "textarea",
              required: true,
              maxLength: 4000,
            },
          ]}
          onClose={() => setCreating(false)}
          submit="Enviar chamado"
          onSubmit={async (values) => {
            const item = await api<{ id: string }>("/portal/tickets", {
              body: values,
            });
            setCreating(false);
            await result.mutate();
            setOpened(item.id);
          }}
        />
      )}
      {opened && (
        <PortalThread
          key={opened}
          id={opened}
          onClose={() => {
            setOpened(null);
            void result.mutate();
          }}
        />
      )}
    </>
  );
}
function PortalThread({ id, onClose }: { id: string; onClose: () => void }) {
  const result = useSWR(
    ["portal-ticket", id],
    async () => ticketDetail.parse(await api(`/portal/tickets/${id}`)),
    { refreshInterval: 10000 },
  );
  const [body, setBody] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>
            {result.data
              ? `Protocolo ${result.data.number}`
              : "Protocolo de atendimento"}
          </DialogTitle>
          <DialogDescription>
            {result.data?.subject ??
              "Consulta da conversa registrada com o provedor."}
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {result.data && (
            <div className="erp-stack">
              <p>{ticketState(result.data.status)}</p>
              {result.data.thread.map((message) => (
                <div className="erp-contract-card" key={message.id}>
                  <header>
                    <strong>
                      {message.author_kind === "subscriber"
                        ? "Você"
                        : "Atendimento"}
                    </strong>
                    <small>{portalDate(message.at)}</small>
                  </header>
                  <p className="whitespace-pre-wrap">{message.body}</p>
                </div>
              ))}
              {result.data.status === "closed" ? (
                <p>Chamado encerrado. Se precisar de ajuda, abra um novo.</p>
              ) : (
                <MutationForm
                  submit="Enviar mensagem"
                  onSubmit={async () => {
                    await api(`/portal/tickets/${id}/messages`, {
                      body: { body },
                    });
                    setBody("");
                    await result.mutate();
                  }}
                >
                  <FormField label="Mensagem ao provedor">
                    <Input
                      value={body}
                      required
                      maxLength={4000}
                      onChange={(event) => setBody(event.target.value)}
                    />
                  </FormField>
                </MutationForm>
              )}
            </div>
          )}
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
