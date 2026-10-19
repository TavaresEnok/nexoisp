import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { copyText } from "@/platform/browser";
import { z } from "zod";
export const scopeLabels: Record<string, string> = {
  "subscribers:read": "Ler assinantes",
  "contracts:read": "Ler contratos",
  "invoices:read": "Ler faturas",
  "tickets:write": "Abrir atendimento",
  "work_orders:read": "Ler ordens de serviço",
  "work_orders:write": "Abrir ordem de serviço",
};
export const eventLabels: Record<string, string> = {
  "invoice.paid": "Fatura paga",
  "access.suspend_requested": "Suspensão solicitada",
  "access.resume_requested": "Reativação solicitada",
  "access.suspended": "Suspensão confirmada",
  "access.resumed": "Reativação confirmada",
  "access.change_failed": "Alteração de acesso falhou",
  "ticket.created": "Atendimento aberto",
  "work_order.created": "OS aberta",
  "work_order.status_changed": "Situação de OS alterada",
  "sla.breached": "SLA vencido",
  "survey.answered": "Pesquisa respondida",
};
export const integrationCatalog = z.object({
  scopes: z.array(z.string()),
  events: z.array(z.string()),
});
export function SecretOnce({
  label,
  value,
  onClose,
}: {
  label: string;
  value: string;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>
            Guarde agora em um local seguro. O servidor não permite consultar
            este segredo novamente.
          </DialogDescription>
        </DialogHeader>
        <FormField label={label}>
          <Input
            readOnly
            value={value}
            onFocus={(event) => event.target.select()}
          />
        </FormField>
        <div className="erp-inline-actions">
          <ActionButton onClick={() => copyText(value)}>
            Copiar segredo
          </ActionButton>
          <Button onClick={onClose}>Já guardei o segredo</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
