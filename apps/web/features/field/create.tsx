import { useState } from "react";
import useSWR from "swr";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { SubscriberPicker } from "@/features/shared/subscriber-picker";
import { api } from "@/platform/erp-client";
import { readSubscriber } from "@/data/erp/subscribers";
import { orderKinds } from "./labels";
export { orderKinds, orderStates } from "./labels";
export function CreateWorkOrder({
  subscriberId,
  contractId,
  ticketId,
  onClose,
  onDone,
}: {
  subscriberId?: string;
  contractId?: string;
  ticketId?: string;
  onClose: () => void;
  onDone: (order: { id: string; number: number }) => Promise<void>;
}) {
  const subscriber = useSWR(
    subscriberId && !contractId ? ["erp-subscriber", subscriberId] : null,
    ([, id]) => readSubscriber(id),
  );
  const staff = useSWR("erp-staff", () =>
    api<{ id: string; name: string }[]>("/staff"),
  );
  const reasons = useSWR("erp-os-reasons", () =>
    api<{ id: string; name: string }[]>("/catalogs?kind=os_reason"),
  );
  const [who, setWho] = useState({
    subscriber_id: subscriberId ?? "",
    contract_id: contractId ?? "",
  });
  const [form, setForm] = useState({
    kind: "repair",
    description: "",
    assignee_id: "",
    scheduled_for: "",
    reason_id: "",
    estimated_minutes: "60",
    address_origin: "subscriber",
    address_text: "",
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
          <DialogTitle>Nova ordem de serviço</DialogTitle>
          <DialogDescription>
            {ticketId
              ? "A ordem ficará vinculada ao protocolo e ao titular deste atendimento."
              : "Registre o serviço e seu endereço de atendimento."}
          </DialogDescription>
        </DialogHeader>
        <QueryBoundary
          loading={staff.isLoading || reasons.isLoading || subscriber.isLoading}
          error={staff.error || reasons.error || subscriber.error}
          retry={() =>
            Promise.all([staff.mutate(), reasons.mutate(), subscriber.mutate()])
          }
        >
          <MutationForm
            submit="Abrir ordem de serviço"
            onCancel={onClose}
            onSubmit={async () => {
              const order = await api<{ id: string; number: number }>(
                "/work-orders",
                {
                  body: {
                    ...form,
                    ...who,
                    contract_id: who.contract_id || null,
                    assignee_id: form.assignee_id || null,
                    scheduled_for: form.scheduled_for
                      ? new Date(form.scheduled_for).toISOString()
                      : null,
                    ticket_id: ticketId ?? null,
                    reason_id: form.reason_id || null,
                    estimated_minutes: Number(form.estimated_minutes),
                    address_text:
                      form.address_origin === "manual"
                        ? form.address_text
                        : null,
                  },
                },
              );
              await onDone(order);
            }}
          >
            {!subscriberId && (
              <SubscriberPicker value={who} onChange={setWho} />
            )}
            {subscriberId && !contractId && (
              <FormField label="Contrato vinculado (opcional)">
                <select
                  className="commercial-select"
                  value={who.contract_id}
                  onChange={(e) =>
                    setWho({ ...who, contract_id: e.target.value })
                  }
                >
                  <option value="">Sem contrato específico</option>
                  {subscriber.data?.contracts.map((contract) => (
                    <option key={contract.id} value={contract.id}>
                      {contract.plan_name} · {contract.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </FormField>
            )}
            <div className="erp-columns">
              <FormField label="Tipo de serviço">
                <select
                  className="commercial-select"
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                >
                  {Object.entries(orderKinds).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Responsável pela OS">
                <select
                  className="commercial-select"
                  value={form.assignee_id}
                  onChange={(e) =>
                    setForm({ ...form, assignee_id: e.target.value })
                  }
                >
                  <option value="">Não atribuído</option>
                  {staff.data?.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Agendar serviço">
                <Input
                  type="datetime-local"
                  value={form.scheduled_for}
                  onChange={(e) =>
                    setForm({ ...form, scheduled_for: e.target.value })
                  }
                />
              </FormField>
            </div>
            <div className="erp-columns">
              <FormField label="Motivo do serviço">
                <select
                  className="commercial-select"
                  value={form.reason_id}
                  onChange={(e) =>
                    setForm({ ...form, reason_id: e.target.value })
                  }
                >
                  <option value="">Não definido</option>
                  {reasons.data?.map((reason) => (
                    <option key={reason.id} value={reason.id}>
                      {reason.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Origem do endereço">
                <select
                  className="commercial-select"
                  value={form.address_origin}
                  onChange={(e) =>
                    setForm({ ...form, address_origin: e.target.value })
                  }
                >
                  <option value="subscriber">
                    Endereço cadastral do titular
                  </option>
                  <option value="contract" disabled={!who.contract_id}>
                    Instalação do contrato
                  </option>
                  <option value="manual">Informar outro endereço</option>
                </select>
              </FormField>
              <FormField label="Duração estimada (minutos)">
                <Input
                  type="number"
                  required
                  min={5}
                  max={1440}
                  value={form.estimated_minutes}
                  onChange={(e) =>
                    setForm({ ...form, estimated_minutes: e.target.value })
                  }
                />
              </FormField>
            </div>
            {form.address_origin === "manual" && (
              <FormField label="Endereço completo do serviço">
                <Input
                  required
                  minLength={5}
                  maxLength={300}
                  value={form.address_text}
                  onChange={(e) =>
                    setForm({ ...form, address_text: e.target.value })
                  }
                />
              </FormField>
            )}
            <FormField label="Descrição do serviço">
              <Textarea
                required
                maxLength={2000}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </FormField>
          </MutationForm>
        </QueryBoundary>
      </DialogContent>
    </Dialog>
  );
}
