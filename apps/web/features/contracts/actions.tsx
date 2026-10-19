import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MutationForm, FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { money, date } from "@/lib/format";
import type { ContractDetail, ErpPlan } from "./models";
export type TerminationQuote = {
  within_loyalty: boolean;
  penalty_cents: number;
  remaining_months: number;
  open_invoices: number;
  open_invoices_cents: number;
  loyalty_until: string | null;
  penalty_model?: string;
  penalty_unit_cents?: number;
};
export function ContractActions({
  contract,
  refresh,
}: {
  contract: ContractDetail;
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  const [modal, setModal] = useState<"change" | "credit" | "end" | null>(null);
  const done = async () => {
    setModal(null);
    await refresh();
  };
  const writable = contract.status === "active" && can(me, "contracts:write");
  if (!writable) return null;
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setModal("change")}>
        Trocar plano ou vencimento
      </Button>
      {can(me, "finance:write") && (
        <Button variant="outline" size="sm" onClick={() => setModal("credit")}>
          {contract.credit_restricted_at
            ? "Retirar restrição de crédito"
            : "Restrição de crédito"}
        </Button>
      )}
      <Button variant="destructive" size="sm" onClick={() => setModal("end")}>
        Encerrar contrato
      </Button>
      {modal && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setModal(null);
          }}
        >
          <DialogContent className="erp-editor">
            <DialogHeader>
              <DialogTitle>
                {modal === "change"
                  ? "Trocar plano ou vencimento"
                  : modal === "credit"
                    ? "Restrição de crédito"
                    : "Encerrar contrato"}
              </DialogTitle>
              <DialogDescription>
                {contract.subscriber_name} · {contract.plan_name}
              </DialogDescription>
            </DialogHeader>
            {modal === "change" ? (
              <ChangePlan
                contract={contract}
                onDone={done}
                onCancel={() => setModal(null)}
              />
            ) : modal === "credit" ? (
              <Credit
                contract={contract}
                onDone={done}
                onCancel={() => setModal(null)}
              />
            ) : (
              <EndContract
                contract={contract}
                onDone={done}
                onCancel={() => setModal(null)}
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
type Props = {
  contract: ContractDetail;
  onDone: () => Promise<void>;
  onCancel: () => void;
};
function ChangePlan({ contract, onDone, onCancel }: Props) {
  const plans = useSWR("erp-plans-for-contract", () =>
    api<ErpPlan[]>("/plans"),
  );
  const [form, setForm] = useState({
    plan_id: contract.plan_id,
    due_day: String(contract.due_day),
  });
  return (
    <QueryBoundary
      loading={plans.isLoading}
      error={plans.error}
      retry={() => plans.mutate()}
    >
      <MutationForm
        onCancel={onCancel}
        onSubmit={async () => {
          await api(`/contracts/${contract.id}`, {
            method: "PATCH",
            body: { plan_id: form.plan_id, due_day: Number(form.due_day) },
          });
          await onDone();
        }}
      >
        <FormField label="Novo plano">
          <select
            className="commercial-select"
            required
            value={form.plan_id}
            onChange={(e) => setForm({ ...form, plan_id: e.target.value })}
          >
            {plans.data
              ?.filter((plan) => plan.active || plan.id === contract.plan_id)
              .map((plan) => (
                <option value={plan.id} key={plan.id}>
                  {plan.name} · v{plan.version} ·{" "}
                  {money(plan.price_cents / 100)}
                </option>
              ))}
          </select>
        </FormField>
        <FormField label="Dia de vencimento">
          <Input
            type="number"
            min={1}
            max={28}
            required
            value={form.due_day}
            onChange={(e) => setForm({ ...form, due_day: e.target.value })}
          />
        </FormField>
        <p className="profile-footnote">
          A troca utiliza a versão atual do plano e fica registrada no histórico
          deste contrato.
        </p>
      </MutationForm>
    </QueryBoundary>
  );
}
function Credit({ contract, onDone, onCancel }: Props) {
  const [note, setNote] = useState("");
  return (
    <MutationForm
      submit="Confirmar restrição"
      onCancel={onCancel}
      onSubmit={async () => {
        await api(`/contracts/${contract.id}/credit-restriction`, {
          method: "PUT",
          body: { restricted: !contract.credit_restricted_at, note },
        });
        await onDone();
      }}
    >
      <p className="profile-footnote">
        A restrição é uma informação comercial. Seu registro não bloqueia o
        acesso automaticamente.
      </p>
      <FormField label="Motivo">
        <Input
          minLength={3}
          maxLength={300}
          required
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </FormField>
    </MutationForm>
  );
}
function EndContract({ contract, onDone, onCancel }: Props) {
  const quote = useSWR(["erp-termination-quote", contract.id], ([, id]) =>
    api<TerminationQuote>(`/contracts/${id}/termination-quote`),
  );
  const reasons = useSWR("erp-end-reasons", () =>
    api<{ id: string; name: string }[]>("/catalogs?kind=end_reason"),
  );
  const [form, setForm] = useState({
    reason: "",
    note: "",
    penalty: "charge",
    waive: "",
  });
  const [confirm, setConfirm] = useState(false);
  const fine = Boolean(
    quote.data?.within_loyalty && quote.data.penalty_cents > 0,
  );
  const submit = async () => {
    await api(`/contracts/${contract.id}`, {
      method: "PATCH",
      body: {
        end: true,
        end_reason_id: form.reason || null,
        end_note: form.note || null,
        ...(fine
          ? {
              penalty: form.penalty,
              ...(form.penalty === "waive"
                ? { penalty_waive_reason: form.waive }
                : {}),
            }
          : {}),
      },
    });
    await onDone();
  };
  return (
    <QueryBoundary
      loading={quote.isLoading || reasons.isLoading}
      error={quote.error || reasons.error}
      retry={() => Promise.all([quote.mutate(), reasons.mutate()])}
    >
      <MutationForm
        submit="Revisar encerramento"
        onCancel={onCancel}
        onSubmit={async () => setConfirm(true)}
      >
        <p className="profile-footnote">
          O encerramento é definitivo. As faturas existentes continuam
          registradas.
        </p>
        <FormField label="Motivo do encerramento">
          <select
            className="commercial-select"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          >
            <option value="">Não informar</option>
            {reasons.data?.map((reason) => (
              <option value={reason.id} key={reason.id}>
                {reason.name}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Observação">
          <Input
            maxLength={300}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </FormField>
        {quote.data && (
          <p>
            {quote.data.open_invoices} fatura(s) em aberto ·{" "}
            {money(quote.data.open_invoices_cents / 100)}
          </p>
        )}
        {fine && (
          <>
            <p>
              Fidelidade até {date(quote.data!.loyalty_until!)} · multa de{" "}
              {money(quote.data!.penalty_cents / 100)}.
            </p>
            <FormField label="Tratamento da multa">
              <select
                className="commercial-select"
                value={form.penalty}
                onChange={(e) => setForm({ ...form, penalty: e.target.value })}
              >
                <option value="charge">Cobrar e gerar fatura</option>
                <option value="waive">Dispensar com justificativa</option>
              </select>
            </FormField>
            {form.penalty === "waive" && (
              <FormField label="Motivo da dispensa">
                <Input
                  minLength={5}
                  maxLength={200}
                  required
                  value={form.waive}
                  onChange={(e) => setForm({ ...form, waive: e.target.value })}
                />
              </FormField>
            )}
          </>
        )}
      </MutationForm>
      {confirm && (
        <Dialog open onOpenChange={setConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirmar encerramento</DialogTitle>
              <DialogDescription>
                Encerrar definitivamente o contrato de{" "}
                {contract.subscriber_name}?{" "}
                {fine
                  ? form.penalty === "charge"
                    ? `Será gerada uma fatura de ${money(quote.data!.penalty_cents / 100)} de multa.`
                    : "A multa será dispensada com a justificativa informada."
                  : "Não há multa de fidelidade na cotação atual."}
              </DialogDescription>
            </DialogHeader>
            <MutationForm
              submit="Encerrar definitivamente"
              onCancel={() => setConfirm(false)}
              onSubmit={submit}
            >
              <p className="profile-footnote">
                O servidor confere novamente as condições ao aplicar a
                alteração.
              </p>
            </MutationForm>
          </DialogContent>
        </Dialog>
      )}
    </QueryBoundary>
  );
}
