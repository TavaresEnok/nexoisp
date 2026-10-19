import {
  TicketClassification,
  TicketClassificationSummary,
} from "./classification";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { toast } from "sonner";
import { TicketQueue, TicketDetails } from "@/components/support";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { MutationForm, FormField } from "@/features/shared/form";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { ServerPager, useUrlPage } from "@/features/shared/pagination";
import { SubscriberPicker } from "@/features/shared/subscriber-picker";
import {
  CreateWorkOrder,
  orderKinds,
  orderStates,
} from "@/features/field/create";
import { useSession } from "@/features/session/provider";
import { can, hasModule } from "@/features/session/model";
import { api, download, erpClient } from "@/platform/erp-client";
import { date } from "@/lib/format";
import { TicketCatalogFields } from "./catalogs";
import {
  ticketSchema,
  ticketDetailSchema,
  projectTicket,
  categoryLabels,
  priorityLabels,
} from "./models";
export function OperationalTickets() {
  return <TicketListing />;
}
export function SubscriberTickets({ id }: { id: string }) {
  return <TicketListing subscriberId={id} />;
}
function TicketListing({ subscriberId }: { subscriberId?: string }) {
  const { me } = useSession();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const { page, setPage, size, setSize } = useUrlPage();
  const embedded = Boolean(subscriberId);
  const statusLabel =
    params.get("situacao") ??
    (params.get("filtro") === "aguardando"
      ? "Aguardando o provedor"
      : "Pendentes");
  const status = embedded
    ? ""
    : ((
        {
          Pendentes: "pending",
          Todos: "",
          "Aguardando o provedor": "open",
          "Aguardando o assinante": "waiting",
          Encerrado: "closed",
        } as Record<string, string>
      )[statusLabel] ?? "pending");
  const subscriber = subscriberId ?? params.get("assinante") ?? "";
  const filters = new URLSearchParams({
    ...(status ? { status } : {}),
    ...(!embedded && params.get("busca") ? { q: params.get("busca")! } : {}),
    ...(subscriber ? { subscriber_id: subscriber } : {}),
    ...(!embedded && params.get("meus") === "1" ? { mine: "1" } : {}),
  });
  const path = `/tickets?${filters}&limit=${embedded ? 8 : size}&offset=${embedded ? 0 : page * size}`;
  const result = useSWR(
    ["erp-tickets", path],
    async ([, path]) => {
      const response = await erpClient.request(path);
      if (response.total === null)
        throw new Error("O servidor não informou a contagem de atendimentos.");
      return {
        rows: z.array(ticketSchema).parse(response.data),
        total: response.total,
      };
    },
    { refreshInterval: 15000 },
  );
  return (
    <>
      {!embedded && <ConnectedNotice demo={me?.demo} />}
      <TicketQueue
        operational
        embedded={embedded}
        tickets={(result.data?.rows ?? []).map(projectTicket)}
        total={result.data?.total}
        loading={result.isLoading}
        error={result.error}
        openSubscriber={(id) => navigate(`/assinantes?ficha=${id}`)}
        actions={
          can(me, "crm:write") && (
            <Button onClick={() => setCreating(true)}>Novo atendimento</Button>
          )
        }
        onOpen={(ticket) => {
          const next = new URLSearchParams(params);
          next.set("protocolo", ticket.id);
          setParams(next);
        }}
        onExport={() => {
          void download(
            `/tickets?${filters}&format=csv&limit=5000`,
            "atendimentos.csv",
          ).catch((error) => toast.error((error as Error).message));
        }}
        controls={
          !embedded && (
            <div className="commercial-toolbar">
              <Label className="erp-inline-actions">
                <input
                  type="checkbox"
                  checked={params.get("meus") === "1"}
                  onChange={(event) => {
                    const next = new URLSearchParams(params);
                    next.delete("pagina");
                    event.target.checked
                      ? next.set("meus", "1")
                      : next.delete("meus");
                    setParams(next, { replace: true });
                  }}
                />
                Somente meus atendimentos
              </Label>
              {subscriber && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.delete("assinante");
                    next.delete("pagina");
                    setParams(next, { replace: true });
                  }}
                >
                  Remover filtro do titular
                </Button>
              )}
            </div>
          )
        }
        pagination={
          embedded ? (
            <div className="erp-pagination">
              <span>
                Até 8 protocolos mais recentes · {result.data?.total ?? "—"} no
                titular
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate(
                    `/atendimentos?assinante=${subscriberId}&situacao=Todos`,
                  )
                }
              >
                Ver todos os atendimentos
              </Button>
            </div>
          ) : (
            <ServerPager
              page={page}
              setPage={setPage}
              size={size}
              setSize={setSize}
              total={result.data?.total ?? 0}
              loading={result.isLoading}
            />
          )
        }
      />
      {creating && (
        <TicketEditor
          subscriberId={subscriberId}
          onClose={() => setCreating(false)}
          onDone={async (id) => {
            setCreating(false);
            await result.mutate();
            const next = new URLSearchParams(params);
            next.set("protocolo", id);
            setParams(next);
          }}
        />
      )}
    </>
  );
}
function TicketEditor({
  subscriberId,
  onClose,
  onDone,
}: {
  subscriberId?: string;
  onClose: () => void;
  onDone: (id: string) => Promise<void>;
}) {
  const [catalogValues, setCatalogValues] = useState({
    type_id: "",
    classification_id: "",
    origin_id: "",
  });
  const [who, setWho] = useState({
    subscriber_id: subscriberId ?? "",
    contract_id: "",
  });
  const [form, setForm] = useState({
    subject: "",
    category: "technical",
    priority: "normal",
    body: "",
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Novo atendimento</DialogTitle>
          <DialogDescription>
            O protocolo e a mensagem inicial serão registrados no ERP.
          </DialogDescription>
        </DialogHeader>
        <MutationForm
          submit="Abrir atendimento"
          onCancel={onClose}
          onSubmit={async () => {
            const ticket = await api<{ id: string }>("/tickets", {
              body: {
                ...form,
                ...who,
                type_id: catalogValues.type_id || null,
                classification_id: catalogValues.classification_id || null,
                origin_id: catalogValues.origin_id || null,
                contract_id: who.contract_id || null,
              },
            });
            await onDone(ticket.id);
          }}
        >
          {!subscriberId && <SubscriberPicker value={who} onChange={setWho} />}
          <FormField label="Assunto do atendimento">
            <Textarea
              required
              maxLength={200}
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
            />
          </FormField>
          <div className="erp-columns">
            <FormField label="Categoria do atendimento">
              <select
                className="commercial-select"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
              >
                {Object.entries(categoryLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Prioridade do atendimento">
              <select
                className="commercial-select"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              >
                {Object.entries(priorityLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          <TicketCatalogFields
            values={catalogValues}
            onChange={setCatalogValues}
          />
          <FormField label="Relato inicial">
            <Textarea
              required
              maxLength={4000}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          </FormField>
        </MutationForm>
      </DialogContent>
    </Dialog>
  );
}
export function OperationalTicketOverlay() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const id = params.get("protocolo");
  if (!id || !can(me, "crm:read") || !hasModule(me, "crm")) return null;
  return (
    <LiveTicket
      key={id}
      id={id}
      onClose={() => {
        const next = new URLSearchParams(params);
        next.delete("protocolo");
        setParams(next, { replace: true });
      }}
    />
  );
}
function LiveTicket({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useSession();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();
  const result = useSWR(
    ["erp-ticket", id],
    async ([, id]) =>
      ticketDetailSchema.parse(await api(`/tickets/${encodeURIComponent(id)}`)),
    { refreshInterval: 10000 },
  );
  const writable = can(me, "crm:write");
  const assigneeAllowed =
    writable && can(me, "os:read") && hasModule(me, "field");
  const staff = useSWR(assigneeAllowed ? "erp-staff" : null, () =>
    api<{ id: string; name: string }[]>("/staff"),
  );
  const [assigning, setAssigning] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [order, setOrder] = useState(false);
  const ticket = result.data;
  const refresh = async () => {
    await Promise.all([
      result.mutate(),
      mutate((key) => Array.isArray(key) && key[0] === "erp-tickets"),
    ]);
  };
  const status = async (value: string) => {
    await api(`/tickets/${id}/status`, { body: { status: value } });
    await refresh();
  };
  return (
    <TicketDetails
      operational
      isOpen
      ticket={ticket ? projectTicket(ticket) : null}
      loading={result.isLoading}
      error={result.error}
      onClose={onClose}
      openSubscriber={(id) => navigate(`/assinantes?ficha=${id}`)}
    >
      {ticket && (
        <div className="erp-stack">
          <ProfileSection title="Vínculo do atendimento">
            {ticket.contract_id ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  navigate(`/contratos?contrato=${ticket.contract_id}`)
                }
              >
                Abrir contrato vinculado
              </Button>
            ) : (
              <p className="profile-footnote">
                Sem contrato específico; protocolo do titular.
              </p>
            )}
          </ProfileSection>
          {assigneeAllowed && (
            <ProfileSection
              title="Responsável pelo atendimento"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAssigning(true)}
                >
                  Atribuir responsável
                </Button>
              }
            >
              <QueryBoundary
                loading={staff.isLoading}
                error={staff.error}
                retry={() => staff.mutate()}
              >
                <p>{ticket.assignee_name ?? "Não atribuído"}</p>
              </QueryBoundary>
            </ProfileSection>
          )}
          <TicketClassificationSummary ticket={ticket} />
          {writable && (
            <Button variant="outline" onClick={() => setClassifying(true)}>
              Editar classificação do atendimento
            </Button>
          )}
          {classifying && (
            <TicketClassification
              ticket={ticket}
              onClose={() => setClassifying(false)}
              onDone={async () => {
                setClassifying(false);
                await refresh();
              }}
            />
          )}
          <ProfileSection title="Conversa e notas">
            <div className="erp-stack">
              {ticket.thread.map((message) => (
                <div className="erp-contract-card" key={message.id}>
                  <header>
                    <strong>
                      {message.author_name ??
                        (message.author_kind === "subscriber"
                          ? "Assinante"
                          : "Equipe")}
                    </strong>
                    {message.internal && (
                      <Badge variant="warning">Nota interna · equipe</Badge>
                    )}
                  </header>
                  <p className="whitespace-pre-wrap">{message.body}</p>
                  <small className="text-muted-foreground">
                    {date(message.at)}
                  </small>
                </div>
              ))}
            </div>
          </ProfileSection>
          {writable && ticket.status !== "closed" && (
            <ProfileSection title="Registrar interação">
              <MutationForm
                submit={
                  internal
                    ? "Salvar nota interna"
                    : "Enviar resposta ao assinante"
                }
                onSubmit={async () => {
                  await api(`/tickets/${id}/messages`, {
                    body: { body, internal },
                  });
                  setBody("");
                  await refresh();
                }}
              >
                <FormField label="Mensagem do atendimento">
                  <Textarea
                    required
                    maxLength={4000}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                </FormField>
                <Label className="erp-inline-actions">
                  <input
                    type="checkbox"
                    checked={internal}
                    onChange={(e) => setInternal(e.target.checked)}
                  />
                  Nota interna, visível apenas à equipe
                </Label>
              </MutationForm>
            </ProfileSection>
          )}
          <div className="erp-inline-actions">
            {writable &&
              (ticket.status === "closed" ? (
                <ActionButton onClick={() => status("open")}>
                  Reabrir atendimento
                </ActionButton>
              ) : (
                <ActionButton
                  danger
                  confirm="Encerrar este atendimento?"
                  onClick={() => status("closed")}
                >
                  Encerrar atendimento
                </ActionButton>
              ))}
            {writable &&
              can(me, "os:write") &&
              hasModule(me, "field") &&
              ticket.status !== "closed" && (
                <Button variant="outline" onClick={() => setOrder(true)}>
                  Abrir ordem de serviço
                </Button>
              )}
          </div>
          <ProfileSection title="Ordens de serviço vinculadas">
            {ticket.work_orders.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>OS</TableHead>
                    <TableHead>Serviço</TableHead>
                    <TableHead>Situação</TableHead>
                    <TableHead>Ação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ticket.work_orders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell>#{order.number}</TableCell>
                      <TableCell>
                        {orderKinds[order.kind] ?? order.kind}
                      </TableCell>
                      <TableCell>
                        {orderStates[order.status] ?? order.status}
                      </TableCell>
                      <TableCell>
                        {can(me, "os:read") && hasModule(me, "field") && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              navigate(`/ordens-de-servico?ordem=${order.id}`)
                            }
                          >
                            Abrir OS
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">
                Nenhuma ordem vinculada a este protocolo.
              </p>
            )}
          </ProfileSection>
          {assigning && (
            <RecordEditor
              loading={staff.isLoading}
              error={staff.error}
              retry={() => staff.mutate()}
              title="Responsável pelo atendimento"
              initial={{ assignee_id: ticket.assignee_id ?? "" }}
              fields={[
                {
                  key: "assignee_id",
                  label: "Responsável do protocolo",
                  type: "select",
                  options: [
                    { value: "", label: "Não atribuído" },
                    ...(staff.data ?? []).map((user) => ({
                      value: user.id,
                      label: user.name,
                    })),
                  ],
                },
              ]}
              onClose={() => setAssigning(false)}
              onSubmit={async (values) => {
                await api(`/tickets/${id}`, {
                  method: "PATCH",
                  body: { assignee_id: values.assignee_id || null },
                });
                setAssigning(false);
                await refresh();
              }}
            />
          )}
          {order && (
            <CreateWorkOrder
              subscriberId={ticket.subscriber_id}
              contractId={ticket.contract_id ?? undefined}
              ticketId={id}
              onClose={() => setOrder(false)}
              onDone={async () => {
                setOrder(false);
                await refresh();
              }}
            />
          )}
        </div>
      )}
    </TicketDetails>
  );
}
