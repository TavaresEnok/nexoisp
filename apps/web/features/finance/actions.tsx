import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MutationForm, FormField } from "@/features/shared/form";
import { RecordEditor } from "@/features/shared/record-editor";
import { decimalToCents } from "@/features/contracts/models";
import { api } from "@/platform/erp-client";
import { money } from "@/lib/format";
import type { InvoiceDetail, Due } from "./models";
export function InvoiceActions({
  invoice,
  due,
  refresh,
}: {
  invoice: InvoiceDetail;
  due: Due;
  refresh: () => Promise<void>;
}) {
  const [action, setAction] = useState<"pay" | "cancel" | "resolve" | null>(
    null,
  );
  const done = async () => {
    setAction(null);
    await refresh();
  };
  return (
    <>
      <div className="erp-inline-actions">
        {["open", "reconciling"].includes(invoice.status) && (
          <Button onClick={() => setAction("pay")}>Baixa manual</Button>
        )}
        {invoice.status === "open" && (
          <Button variant="destructive" onClick={() => setAction("cancel")}>
            Cancelar fatura
          </Button>
        )}
        {invoice.status === "reconciling" && (
          <Button variant="outline" onClick={() => setAction("resolve")}>
            Resolver conciliação
          </Button>
        )}
      </div>
      {action === "pay" && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
        >
          <DialogContent className="erp-editor">
            <DialogHeader>
              <DialogTitle>Baixa manual</DialogTitle>
              <DialogDescription>
                Registre o recebimento conferido. A operação fica na auditoria.
              </DialogDescription>
            </DialogHeader>
            <PaymentForm
              invoice={invoice}
              due={due}
              onDone={done}
              onClose={() => setAction(null)}
            />
          </DialogContent>
        </Dialog>
      )}
      {action === "cancel" && (
        <RecordEditor
          title="Cancelar fatura"
          description="O cancelamento preserva o registro e exige um motivo."
          initial={{ reason: "" }}
          fields={[
            { key: "reason", label: "Motivo do cancelamento", required: true },
          ]}
          onClose={() => setAction(null)}
          submit="Confirmar cancelamento"
          onSubmit={async (values) => {
            await api(`/invoices/${invoice.id}/cancel`, { body: values });
            await done();
          }}
        />
      )}
      {action === "resolve" && (
        <RecordEditor
          title="Resolver conciliação"
          description="Confira valor, titular e origem do recebimento antes de registrar a decisão."
          initial={{ decision: "paid", note: "" }}
          fields={[
            {
              key: "decision",
              label: "Decisão",
              type: "select",
              options: [
                { value: "paid", label: "Considerar paga" },
                { value: "open", label: "Manter em aberto" },
              ],
            },
            { key: "note", label: "Justificativa", required: true },
          ]}
          onClose={() => setAction(null)}
          submit="Registrar decisão"
          onSubmit={async (values) => {
            await api(`/invoices/${invoice.id}/resolve`, { body: values });
            await done();
          }}
        />
      )}
    </>
  );
}
function PaymentForm({
  invoice,
  due,
  onDone,
  onClose,
}: {
  invoice: InvoiceDetail;
  due: Due;
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const brl = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
  const [form, setForm] = useState({
    amount: brl(due.remaining_cents),
    paid_at: new Date().toLocaleDateString("en-CA"),
    method: "dinheiro",
    note: "",
    fees: false,
    partial: false,
    discount: "",
    discount_reason: "",
  });
  const extraFees = Math.max(0, due.fee_if_applied_cents - due.fee_cents);
  return (
    <MutationForm
      submit="Registrar baixa"
      onCancel={onClose}
      onSubmit={async () => {
        await api(`/invoices/${invoice.id}/manual-payment`, {
          body: {
            amount_cents: decimalToCents(form.amount),
            paid_at: form.paid_at,
            method: form.method,
            note: form.note,
            apply_fees: form.fees,
            partial: form.partial,
            ...(form.discount
              ? {
                  discount_cents: decimalToCents(form.discount),
                  discount_reason: form.discount_reason,
                }
              : {}),
          },
        });
        await onDone();
      }}
    >
      <div className="erp-columns">
        <FormField label="Valor recebido (R$)">
          <Input
            required
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
          />
        </FormField>
        <FormField label="Data do recebimento">
          <Input
            required
            type="date"
            value={form.paid_at}
            onChange={(e) => setForm({ ...form, paid_at: e.target.value })}
          />
        </FormField>
        <FormField label="Meio de pagamento">
          <Input
            value={form.method}
            maxLength={40}
            onChange={(e) => setForm({ ...form, method: e.target.value })}
          />
        </FormField>
      </div>
      <FormField label="Observação da baixa">
        <Input
          required
          minLength={3}
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />
      </FormField>
      {extraFees > 0 && (
        <Label className="erp-inline-actions">
          <input
            type="checkbox"
            checked={form.fees}
            onChange={(e) =>
              setForm({
                ...form,
                fees: e.target.checked,
                amount: brl(
                  due.remaining_cents + (e.target.checked ? extraFees : 0),
                ),
              })
            }
          />
          Cobrar multa e juros adicionais de {money(extraFees / 100)}
        </Label>
      )}
      <Label className="erp-inline-actions">
        <input
          type="checkbox"
          checked={form.partial}
          onChange={(e) => setForm({ ...form, partial: e.target.checked })}
        />
        Pagamento parcial
      </Label>
      <div className="erp-columns">
        <FormField label="Desconto na baixa (R$)">
          <Input
            value={form.discount}
            onChange={(e) => setForm({ ...form, discount: e.target.value })}
          />
        </FormField>
        <FormField label="Motivo do desconto">
          <Input
            required={Boolean(form.discount)}
            minLength={3}
            maxLength={200}
            value={form.discount_reason}
            onChange={(e) =>
              setForm({ ...form, discount_reason: e.target.value })
            }
          />
        </FormField>
      </div>
      <p className="profile-footnote">
        O servidor confere saldo, descontos e encargos. A opção de pagamento
        parcial mantém o saldo pendente.
      </p>
    </MutationForm>
  );
}
