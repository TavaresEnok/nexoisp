import { ConvertToExistingSubscriber } from "./convert";
import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { PageHeading, Panel, Status } from "@/components/workspace-ui";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import {
  RecordEditor,
  type EditorField,
} from "@/features/shared/record-editor";
import { MutationForm, FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { ServerPager, useUrlPage } from "@/features/shared/pagination";
import { useQueryState } from "@/lib/use-query-state";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api, erpClient } from "@/platform/erp-client";
import { date } from "@/lib/format";
import {
  leadSchema,
  leadDetailSchema,
  stageLabels,
  type LeadDetail,
} from "./models";
export function OperationalLeads() {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [stage, setStage] = useQueryState(
    "etapa",
    "open",
    ["open", "", "new", "contacted", "proposal", "won", "lost"],
    { resetPage: true },
  );
  const [query, setQuery] = useQueryState("busca", "", undefined, {
    resetPage: true,
  });
  const { page, setPage } = useUrlPage();
  const path = `/leads?${new URLSearchParams({ stage, q: query, limit: "8", offset: String(page * 8) })}`;
  const list = useSWR(["erp-leads", path], async ([, path]) => {
    const result = await erpClient.request(path);
    if (result.total === null)
      throw new Error("O servidor não informou a contagem de prospectos.");
    return {
      rows: z.array(leadSchema).parse(result.data),
      total: result.total,
    };
  });
  const summary = useSWR("erp-leads-summary", () =>
    api<{
      new: number;
      contacted: number;
      proposal: number;
      won_month: number;
      lost_month: number;
    }>("/leads/summary"),
  );
  const refresh = async () => {
    await Promise.all([list.mutate(), summary.mutate()]);
  };
  return (
    <>
      <PageHeading
        title="Prospectos"
        description="Acompanhe cada oportunidade até o cadastro do assinante."
        actions={
          can(me, "crm:write") && (
            <Button onClick={() => setCreating(true)}>Novo prospecto</Button>
          )
        }
      />
      <ConnectedNotice demo={me?.demo} />
      <QueryBoundary
        loading={summary.isLoading}
        error={summary.error}
        retry={() => summary.mutate()}
      >
        {summary.data && (
          <div className="commercial-metrics">
            {[
              ["Novos", summary.data.new, "Em negociação"],
              ["Contatados", summary.data.contacted, "Em negociação"],
              ["Propostas", summary.data.proposal, "Em negociação"],
              [
                "Convertidos no mês",
                summary.data.won_month,
                `${summary.data.lost_month} perdido(s) no mês`,
              ],
            ].map(([label, value, detail]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>{detail}</small>
              </div>
            ))}
          </div>
        )}
      </QueryBoundary>
      <Panel
        title="Funil comercial"
        description="Indicadores do provedor e consulta paginada das oportunidades."
        className="list-panel"
      >
        <div className="commercial-toolbar">
          <FormField label="Etapa do prospecto">
            <select
              className="commercial-select"
              value={stage}
              onChange={(e) => setStage(e.target.value)}
            >
              <option value="open">Em negociação</option>
              <option value="">Todas as etapas</option>
              {Object.entries(stageLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
          <Input
            aria-label="Buscar prospectos"
            maxLength={100}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nome, telefone ou e-mail"
          />
        </div>
        <QueryBoundary
          loading={list.isLoading}
          error={list.error}
          retry={() => list.mutate()}
        >
          {list.data?.rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Contato</TableHead>
                  <TableHead>Cidade</TableHead>
                  <TableHead>Plano de interesse</TableHead>
                  <TableHead>Origem</TableHead>
                  <TableHead>Etapa</TableHead>
                  <TableHead>Ação</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.rows.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell>{lead.name}</TableCell>
                    <TableCell>
                      {[lead.phone, lead.email].filter(Boolean).join(" · ") ||
                        "—"}
                    </TableCell>
                    <TableCell>{lead.address_city || "—"}</TableCell>
                    <TableCell>{lead.plan_name || "—"}</TableCell>
                    <TableCell>{lead.source || "—"}</TableCell>
                    <TableCell>
                      <Status value={stageLabels[lead.stage]} />
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Abrir prospecto ${lead.name}`}
                        onClick={() => {
                          const next = new URLSearchParams(params);
                          next.set("prospecto", lead.id);
                          setParams(next);
                        }}
                      >
                        Abrir
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="commercial-detail-body">
              <p className="profile-footnote">
                Nenhum prospecto nesta seleção.
              </p>
            </div>
          )}
        </QueryBoundary>
        <ServerPager
          page={page}
          setPage={setPage}
          total={list.data?.total ?? 0}
          loading={list.isLoading}
        />
      </Panel>
      {creating && (
        <LeadEditor
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await refresh();
          }}
        />
      )}
      {params.get("prospecto") && (
        <LeadSheet
          key={params.get("prospecto")}
          id={params.get("prospecto")!}
          onClose={() => {
            const next = new URLSearchParams(params);
            next.delete("prospecto");
            setParams(next, { replace: true });
            void refresh();
          }}
        />
      )}
    </>
  );
}
function LeadEditor({
  initial,
  onClose,
  onDone,
}: {
  initial?: LeadDetail;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const plans = useSWR("erp-plans", () =>
    api<{ id: string; name: string; active: boolean }[]>("/plans"),
  );
  const fields: EditorField[] = [
    { key: "name", label: "Nome do prospecto", required: true, maxLength: 160 },
    { key: "document", label: "CPF/CNPJ" },
    { key: "phone", label: "Telefone" },
    { key: "email", label: "E-mail", type: "email" },
    { key: "address_street", label: "Logradouro" },
    { key: "address_number", label: "Número" },
    { key: "address_district", label: "Bairro" },
    { key: "address_city", label: "Cidade" },
    { key: "address_state", label: "UF", maxLength: 2 },
    { key: "address_zip", label: "CEP" },
    { key: "source", label: "Origem da oportunidade", maxLength: 80 },
    {
      key: "plan_id",
      label: "Plano de interesse",
      type: "select",
      options: [
        { value: "", label: "Não definido" },
        ...(plans.data ?? [])
          .filter((plan) => plan.active || plan.id === initial?.plan_id)
          .map((plan) => ({ value: plan.id, label: plan.name })),
      ],
    },
    { key: "notes", label: "Observações", type: "textarea", maxLength: 2000 },
  ];
  return (
    <RecordEditor
      loading={plans.isLoading}
      error={plans.error}
      retry={() => plans.mutate()}
      title={initial ? "Editar prospecto" : "Novo prospecto"}
      description="Informe ao menos um telefone ou e-mail para contato. O plano de interesse não cria um contrato."
      fields={fields}
      initial={Object.fromEntries(
        fields.map((field) => [
          field.key,
          String(initial?.[field.key as keyof LeadDetail] ?? ""),
        ]),
      )}
      onClose={onClose}
      onSubmit={async (values) => {
        if (plans.error) throw plans.error;
        await api(initial ? `/leads/${initial.id}` : "/leads", {
          method: initial ? "PATCH" : "POST",
          body: {
            ...Object.fromEntries(
              Object.entries(values).map(([key, value]) => [
                key,
                value || null,
              ]),
            ),
            owner_id: initial?.owner_id ?? null,
          },
        });
        await onDone();
      }}
    />
  );
}
function LeadSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { me } = useSession();
  const navigate = useNavigate();
  const { mutate } = useSWRConfig();
  const result = useSWR(["erp-lead", id], async ([, id]) =>
    leadDetailSchema.parse(await api(`/leads/${encodeURIComponent(id)}`)),
  );
  const [editing, setEditing] = useState(false);
  const [lost, setLost] = useState(false);
  const [converting, setConverting] = useState(false);
  const [note, setNote] = useState("");
  const lead = result.data;
  const writable = can(me, "crm:write") && lead?.stage !== "won";
  const refresh = async () => {
    await Promise.all([
      result.mutate(),
      mutate("erp-leads-summary"),
      mutate((key) => Array.isArray(key) && key[0] === "erp-leads"),
    ]);
  };
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="commercial-sheet erp-contract-sheet">
        <SheetHeader>
          <p className="eyebrow">COMERCIAL / PROSPECTO</p>
          <SheetTitle>{lead?.name ?? "Prospecto"}</SheetTitle>
          <SheetDescription>
            Histórico e condições da oportunidade comercial.
          </SheetDescription>
          {lead && <Status value={stageLabels[lead.stage]} />}
        </SheetHeader>
        <div className="commercial-detail-body">
          <QueryBoundary
            loading={result.isLoading}
            error={result.error}
            retry={() => result.mutate()}
          >
            {lead && (
              <>
                <ProfileSection title="Dados de contato">
                  <ProfileFacts
                    items={[
                      ["Telefone", lead.phone || "—"],
                      ["E-mail", lead.email || "—"],
                      ["Documento", lead.document || "—"],
                      [
                        "Endereço",
                        [
                          lead.address_street,
                          lead.address_number,
                          lead.address_district,
                          lead.address_city,
                          lead.address_state,
                          lead.address_zip,
                        ]
                          .filter(Boolean)
                          .join(", ") || "—",
                      ],
                      ["Origem", lead.source || "—"],
                      ["Plano de interesse", lead.plan_name || "—"],
                      ["Responsável", lead.owner_name || "Não atribuído"],
                      ["Motivo da perda", lead.lost_reason || "—"],
                    ]}
                  />
                  {lead.notes && (
                    <p className="whitespace-pre-wrap">{lead.notes}</p>
                  )}
                  {lead.subscriber_id && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        navigate(`/assinantes?ficha=${lead.subscriber_id}`)
                      }
                    >
                      Abrir assinante convertido
                    </Button>
                  )}
                </ProfileSection>
                {writable && (
                  <div className="erp-inline-actions">
                    <Button variant="outline" onClick={() => setEditing(true)}>
                      Editar prospecto
                    </Button>
                    {["new", "contacted", "proposal"]
                      .filter((stage) => stage !== lead.stage)
                      .map((stage) => (
                        <ActionButton
                          key={stage}
                          onClick={async () => {
                            await api(`/leads/${id}/stage`, {
                              body: { stage, lost_reason: null },
                            });
                            await refresh();
                          }}
                        >
                          Marcar {stageLabels[stage]}
                        </ActionButton>
                      ))}
                    <Button variant="destructive" onClick={() => setLost(true)}>
                      Marcar perdido
                    </Button>
                    {can(me, "subscribers:write") && (
                      <ActionButton
                        confirm="Criar o cadastro de assinante com os dados deste prospecto?"
                        onClick={async () => {
                          const converted = await api<{
                            subscriber_id: string;
                          }>(`/leads/${id}/convert`, { body: {} });
                          await refresh();
                          navigate(
                            `/assinantes?ficha=${converted.subscriber_id}`,
                          );
                        }}
                      >
                        Converter em assinante
                      </ActionButton>
                    )}
                    {can(me, "subscribers:write") && (
                      <Button
                        variant="outline"
                        onClick={() => setConverting(true)}
                      >
                        Vincular a assinante existente
                      </Button>
                    )}
                  </div>
                )}
                <ProfileSection title="Histórico de contato">
                  {can(me, "crm:write") && (
                    <MutationForm
                      submit="Registrar contato"
                      onSubmit={async () => {
                        await api(`/leads/${id}/notes`, { body: { note } });
                        setNote("");
                        await refresh();
                      }}
                    >
                      <FormField label="Contato ou anotação">
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
                    {lead.events.map((event, index) => (
                      <div key={index}>
                        <span className="timeline-dot" />
                        <div>
                          <strong>
                            {(
                              {
                                created: "Prospecto cadastrado",
                                stage: "Etapa alterada",
                                note: "Contato registrado",
                                converted: "Convertido em assinante",
                              } as Record<string, string>
                            )[event.event] ?? event.event}
                          </strong>
                          <p>
                            {event.event === "stage"
                              ? `${stageLabels[String(event.detail.from)] ?? event.detail.from} → ${stageLabels[String(event.detail.to)] ?? event.detail.to}${event.detail.reason ? ` · ${event.detail.reason}` : ""}`
                              : event.event === "note"
                                ? String(event.detail.note ?? "")
                                : ""}
                          </p>
                          <small>
                            {date(event.at)} · {event.actor_name ?? "Sistema"}
                          </small>
                        </div>
                      </div>
                    ))}
                  </div>
                </ProfileSection>
              </>
            )}
          </QueryBoundary>
        </div>
        {editing && lead && (
          <LeadEditor
            initial={lead}
            onClose={() => setEditing(false)}
            onDone={async () => {
              setEditing(false);
              await refresh();
            }}
          />
        )}
        {converting && (
          <ConvertToExistingSubscriber
            leadId={id}
            onClose={() => setConverting(false)}
            onDone={async (subscriberId) => {
              setConverting(false);
              await refresh();
              navigate(`/assinantes?ficha=${subscriberId}`);
            }}
          />
        )}
        {lost && (
          <RecordEditor
            title="Marcar prospecto perdido"
            initial={{ reason: "" }}
            fields={[
              {
                key: "reason",
                label: "Motivo da perda",
                required: true,
                maxLength: 300,
              },
            ]}
            onClose={() => setLost(false)}
            onSubmit={async (values) => {
              await api(`/leads/${id}/stage`, {
                body: { stage: "lost", lost_reason: values.reason },
              });
              setLost(false);
              await refresh();
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
