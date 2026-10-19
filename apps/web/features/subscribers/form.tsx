import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { MutationForm, FormField } from "@/features/shared/form";
import { saveSubscriber } from "@/data/erp/subscribers";
import {
  subscriberInput,
  type SubscriberRecord,
  type SubscriberInput,
} from "./model";
export function SubscriberForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: SubscriberRecord;
  onDone: (id: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(() => subscriberInput(initial));
  const field = (
    key: keyof SubscriberInput,
    label: string,
    props: React.ComponentProps<typeof Input> = {},
  ) => (
    <FormField label={label}>
      <Input
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: event.target.value })}
        {...props}
      />
    </FormField>
  );
  return (
    <MutationForm
      onCancel={onCancel}
      onSubmit={async () => {
        const saved = await saveSubscriber(form, initial?.id);
        await onDone(saved.id);
      }}
    >
      {field("name", "Nome / Razão social", {
        required: true,
        autoFocus: true,
      })}
      <div className="erp-columns">
        {field("document", "CPF/CNPJ")}
        {field("phone", "Telefone")}
      </div>
      {field("email", "E-mail", { type: "email" })}
      <div className="erp-columns">
        {field("birth_date", "Nascimento / abertura", { type: "date" })}
        {field("rg", "RG")}
        {field("rg_issuer", "Órgão emissor", { maxLength: 20 })}
      </div>
      <div className="erp-columns">
        {field("mother_name", "Nome da mãe")}
        {field("trade_name", "Nome fantasia")}
      </div>
      <div className="erp-columns">
        {field("address_street", "Logradouro")}
        {field("address_number", "Número")}
        {field("address_zip", "CEP")}
      </div>
      <div className="erp-columns">
        {field("address_district", "Bairro")}
        {field("address_city", "Cidade")}
        {field("address_state", "UF", { maxLength: 2 })}
      </div>
      <FormField label="Observações">
        <Textarea
          value={form.notes}
          onChange={(event) => setForm({ ...form, notes: event.target.value })}
        />
      </FormField>
      {initial && (
        <FormField label="Situação do cadastro">
          <select
            className="commercial-select"
            value={form.status}
            onChange={(event) =>
              setForm({ ...form, status: event.target.value })
            }
          >
            <option value="active">Ativo</option>
            <option value="inactive">Inativo</option>
          </select>
        </FormField>
      )}
    </MutationForm>
  );
}
export function SubscriberEditor({
  initial,
  onDone,
  onClose,
}: {
  initial?: SubscriberRecord;
  onDone: (id: string) => Promise<void> | void;
  onClose: () => void;
}) {
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
            {initial ? "Editar assinante" : "Novo assinante"}
          </DialogTitle>
          <DialogDescription>Dados cadastrais do titular.</DialogDescription>
        </DialogHeader>
        <SubscriberForm initial={initial} onDone={onDone} onCancel={onClose} />
      </DialogContent>
    </Dialog>
  );
}
