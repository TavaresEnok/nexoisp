import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MutationForm } from "@/features/shared/form";
import {
  SubscriberPicker,
  type SubscriberChoice,
} from "@/features/shared/subscriber-picker";
import { api } from "@/platform/erp-client";

export function ConvertToExistingSubscriber({
  leadId,
  onClose,
  onDone,
}: {
  leadId: string;
  onClose: () => void;
  onDone: (id: string) => Promise<void>;
}) {
  const [choice, setChoice] = useState<SubscriberChoice>({
    subscriber_id: "",
    contract_id: "",
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
          <DialogTitle>Vincular prospecto a assinante existente</DialogTitle>
          <DialogDescription>
            A conversão registra a oportunidade como ganha e preserva o cadastro
            já existente do titular.
          </DialogDescription>
        </DialogHeader>
        <MutationForm
          submit="Confirmar vínculo"
          onCancel={onClose}
          onSubmit={async () => {
            const result = await api<{ subscriber_id: string }>(
              `/leads/${leadId}/convert`,
              { body: { subscriber_id: choice.subscriber_id } },
            );
            await onDone(result.subscriber_id);
          }}
        >
          <SubscriberPicker
            includeContracts={false}
            value={choice}
            onChange={setChoice}
          />
        </MutationForm>
      </DialogContent>
    </Dialog>
  );
}
