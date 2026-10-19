import {
  RecordEditor,
  type EditorField,
} from "@/features/shared/record-editor";
import { useTicketCatalogs } from "./catalogs";
import { categoryLabels, priorityLabels, type TicketDetail } from "./models";
import { api } from "@/platform/erp-client";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
import { QueryBoundary } from "@/features/shared/feedback";

export function TicketClassificationSummary({
  ticket,
}: {
  ticket: TicketDetail;
}) {
  const catalog = useTicketCatalogs();
  const name = (id: string | null) =>
    id
      ? (catalog.data?.find((item) => item.id === id)?.name ??
        "Item não disponível nesta consulta")
      : "Não informada";
  return (
    <ProfileSection title="Classificação do atendimento">
      <QueryBoundary
        error={catalog.error}
        loading={catalog.isLoading}
        retry={() => catalog.mutate()}
      >
        <ProfileFacts
          items={[
            ["Categoria", categoryLabels[ticket.category] ?? ticket.category],
            ["Prioridade", priorityLabels[ticket.priority] ?? ticket.priority],
            ["Tipo", name(ticket.type_id)],
            ["Classificação", name(ticket.classification_id)],
            ["Causa-raiz", name(ticket.root_cause_id)],
          ]}
        />
      </QueryBoundary>
    </ProfileSection>
  );
}

export function TicketClassification({
  ticket,
  onClose,
  onDone,
}: {
  ticket: TicketDetail;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const catalog = useTicketCatalogs();
  const fields: EditorField[] = [
    {
      key: "category",
      label: "Categoria do protocolo",
      type: "select",
      options: Object.entries(categoryLabels).map(([value, label]) => ({
        value,
        label,
      })),
    },
    {
      key: "priority",
      label: "Prioridade do protocolo",
      type: "select",
      options: Object.entries(priorityLabels).map(([value, label]) => ({
        value,
        label,
      })),
    },
    ...(
      [
        ["type_id", "ticket_type", "Tipo do protocolo"],
        ["classification_id", "classification", "Classificação do protocolo"],
        ["root_cause_id", "root_cause", "Causa-raiz do protocolo"],
      ] as const
    ).map(([key, kind, label]) => ({
      key,
      label,
      type: "select" as const,
      options: [
        { value: "", label: "Não informada" },
        ...(catalog.data ?? [])
          .filter(
            (item) =>
              item.kind === kind && (item.active || item.id === ticket[key]),
          )
          .map((item) => ({ value: item.id, label: item.name })),
      ],
    })),
  ];
  return (
    <RecordEditor
      title="Classificação do atendimento"
      description="A alteração de prioridade ou tipo pode atualizar o prazo de SLA conforme as regras do Go."
      initial={{
        category: ticket.category,
        priority: ticket.priority,
        type_id: ticket.type_id ?? "",
        classification_id: ticket.classification_id ?? "",
        root_cause_id: ticket.root_cause_id ?? "",
      }}
      fields={fields}
      loading={catalog.isLoading}
      error={catalog.error}
      retry={() => catalog.mutate()}
      onClose={onClose}
      onSubmit={async (values) => {
        await api(`/tickets/${ticket.id}`, {
          method: "PATCH",
          body: {
            ...values,
            type_id: values.type_id || null,
            classification_id: values.classification_id || null,
            root_cause_id: values.root_cause_id || null,
          },
        });
        await onDone();
      }}
    />
  );
}
