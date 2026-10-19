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
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { MutationForm, FormField } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { decimalToCents, type ErpPlan } from "@/features/contracts/models";
import { api } from "@/platform/erp-client";
import { date, money } from "@/lib/format";
export type PlanDialogKind =
  | "new"
  | "version"
  | "history"
  | "dunning"
  | "loyalty"
  | "network";
const titles: Record<PlanDialogKind, string> = {
  new: "Novo plano",
  version: "Nova versão do plano",
  history: "Histórico de versões",
  dunning: "Degraus de cobrança",
  loyalty: "Fidelidade do plano",
  network: "Parâmetros de rede",
};
export function PlanDialog({
  kind,
  plan,
  onClose,
  onDone,
}: {
  kind: PlanDialogKind;
  plan?: ErpPlan;
  onClose: () => void;
  onDone: () => Promise<void>;
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
          <DialogTitle>{titles[kind]}</DialogTitle>
          <DialogDescription>
            {plan?.name ?? "Cadastre a oferta e seu perfil de acesso."}
          </DialogDescription>
        </DialogHeader>
        {kind === "new" || kind === "version" ? (
          <PlanForm
            plan={kind === "version" ? plan : undefined}
            onCancel={onClose}
            onDone={onDone}
          />
        ) : (
          plan &&
          (kind === "history" ? (
            <Versions plan={plan} />
          ) : kind === "dunning" ? (
            <Dunning plan={plan} onCancel={onClose} onDone={onDone} />
          ) : kind === "loyalty" ? (
            <Loyalty plan={plan} onCancel={onClose} onDone={onDone} />
          ) : (
            <Network plan={plan} onCancel={onClose} onDone={onDone} />
          ))
        )}
      </DialogContent>
    </Dialog>
  );
}
type Callbacks = { onDone: () => Promise<void>; onCancel: () => void };
function PlanForm({ plan, onDone, onCancel }: { plan?: ErpPlan } & Callbacks) {
  const [form, setForm] = useState({
    name: plan?.name ?? "",
    price: plan ? (plan.price_cents / 100).toFixed(2).replace(".", ",") : "",
    down: plan ? String(plan.down_kbps / 1000) : "",
    up: plan ? String(plan.up_kbps / 1000) : "",
    profile: plan?.profile_name ?? "",
  });
  const field = (key: keyof typeof form, label: string, type = "text") => (
    <FormField label={label}>
      <Input
        value={form[key]}
        type={type}
        min={type === "number" ? 1 : undefined}
        required
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </FormField>
  );
  return (
    <MutationForm
      submit={plan ? "Criar nova versão" : "Salvar plano"}
      onCancel={onCancel}
      onSubmit={async () => {
        await api(plan ? `/plans/${plan.id}/versions` : "/plans", {
          body: {
            ...(!plan ? { name: form.name } : {}),
            price_cents: decimalToCents(form.price),
            down_kbps: Math.round(Number(form.down) * 1000),
            up_kbps: Math.round(Number(form.up) * 1000),
            profile_name: form.profile,
          },
        });
        await onDone();
      }}
    >
      {plan ? (
        <p className="profile-footnote">
          Os contratos atuais preservam a versão v{plan.version} e o preço de{" "}
          {money(plan.price_cents / 100)}. A alteração cria uma nova versão.
        </p>
      ) : (
        field("name", "Nome do plano")
      )}
      <div className="erp-columns">
        {field("price", "Mensalidade (R$)")}
        {field("down", "Download (Mbps)", "number")}
        {field("up", "Upload (Mbps)", "number")}
      </div>
      {field("profile", "Perfil de velocidade no NAS")}
    </MutationForm>
  );
}
function Versions({ plan }: { plan: ErpPlan }) {
  const versions = useSWR(["erp-plan-versions", plan.id], ([, id]) =>
    api<
      {
        id: string;
        version: number;
        price_cents: number;
        down_kbps: number;
        up_kbps: number;
        profile_name: string;
        valid_from: string;
        contracts: number;
      }[]
    >(`/plans/${id}/versions`),
  );
  return (
    <QueryBoundary
      loading={versions.isLoading}
      error={versions.error}
      retry={() => versions.mutate()}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Versão</TableHead>
            <TableHead>Mensalidade</TableHead>
            <TableHead>Banda</TableHead>
            <TableHead>Perfil</TableHead>
            <TableHead>Desde</TableHead>
            <TableHead>Contratos</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {versions.data?.map((version) => (
            <TableRow key={version.id}>
              <TableCell>v{version.version}</TableCell>
              <TableCell>{money(version.price_cents / 100)}</TableCell>
              <TableCell>
                {version.down_kbps / 1000} / {version.up_kbps / 1000} Mbps
              </TableCell>
              <TableCell>{version.profile_name}</TableCell>
              <TableCell>{date(version.valid_from)}</TableCell>
              <TableCell>{version.contracts}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </QueryBoundary>
  );
}
function Dunning({ plan, onDone, onCancel }: { plan: ErpPlan } & Callbacks) {
  const [form, setForm] = useState({
    warn: String(plan.warn_after_days ?? ""),
    reduce: String(plan.reduce_after_days ?? ""),
    block: String(plan.block_after_days ?? ""),
    profile: plan.reduced_profile ?? "",
  });
  const numeric = (value: string) => (value === "" ? null : Number(value));
  return (
    <MutationForm
      onCancel={onCancel}
      onSubmit={async () => {
        await api(`/plans/${plan.id}/dunning`, {
          method: "PUT",
          body: {
            warn_after_days: numeric(form.warn),
            reduce_after_days: numeric(form.reduce),
            block_after_days: numeric(form.block),
            reduced_profile: form.profile || null,
          },
        });
        await onDone();
      }}
    >
      <p className="profile-footnote">
        Dias após o vencimento. Campos vazios herdam a política do provedor. A
        automação depende da política e dos jobs habilitados.
      </p>
      <div className="erp-columns">
        {(
          [
            ["warn", "Avisar (dias)"],
            ["reduce", "Reduzir (dias)"],
            ["block", "Bloquear (dias)"],
          ] as const
        ).map(([key, label]) => (
          <FormField key={key} label={label}>
            <Input
              type="number"
              min={0}
              max={365}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </FormField>
        ))}
      </div>
      <FormField label="Perfil de velocidade reduzida">
        <Input
          value={form.profile}
          required={form.reduce !== ""}
          pattern="[A-Za-z0-9_.-]{1,60}"
          onChange={(e) => setForm({ ...form, profile: e.target.value })}
        />
      </FormField>
    </MutationForm>
  );
}
function Loyalty({ plan, onDone, onCancel }: { plan: ErpPlan } & Callbacks) {
  const [form, setForm] = useState({
    months: String(plan.loyalty_months ?? ""),
    model: plan.penalty_model ?? "fixed",
    price:
      plan.penalty_cents == null
        ? ""
        : (plan.penalty_cents / 100).toFixed(2).replace(".", ","),
  });
  return (
    <MutationForm
      onCancel={onCancel}
      onSubmit={async () => {
        await api(`/plans/${plan.id}/loyalty`, {
          method: "PUT",
          body:
            form.months === ""
              ? { months: null }
              : {
                  months: Number(form.months),
                  penalty_model: form.model,
                  penalty_cents: decimalToCents(form.price),
                },
        });
        await onDone();
      }}
    >
      <p className="profile-footnote">
        Aplica-se a contratos novos. Deixe os meses vazios para remover a
        fidelidade padrão.
      </p>
      <div className="erp-columns">
        <FormField label="Meses de fidelidade">
          <Input
            type="number"
            min={1}
            max={60}
            value={form.months}
            onChange={(e) => setForm({ ...form, months: e.target.value })}
          />
        </FormField>
        <FormField label="Modelo da multa">
          <select
            className="commercial-select"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          >
            <option value="fixed">Valor único</option>
            <option value="monthly">Por mês restante</option>
          </select>
        </FormField>
        <FormField label="Valor da multa (R$)">
          <Input
            value={form.price}
            required={form.months !== ""}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
          />
        </FormField>
      </div>
    </MutationForm>
  );
}
function Network({ plan, onDone, onCancel }: { plan: ErpPlan } & Callbacks) {
  const { me } = useSession();
  const [form, setForm] = useState({
    rate_limit: plan.rate_limit ?? "",
    address_pool: plan.address_pool ?? "",
  });
  const [saved, setSaved] = useState<{ accounts_to_reapply: number } | null>(
    null,
  );
  const [result, setResult] = useState<{
    requested: number;
    refused: number;
    errors: string[];
  } | null>(null);
  return saved ? (
    <div className="erp-stack">
      <p>
        Parâmetros salvos. {saved.accounts_to_reapply} conta(s) precisam de
        reaplicação para receber a alteração.
      </p>
      {can(me, "network:operate") && (
        <ActionButton
          disabled={Boolean(result)}
          confirm="Solicitar a reaplicação das contas vinculadas a este plano? A execução será acompanhada pelas operações de rede."
          onClick={async () => {
            setResult(
              await api(`/plans/${plan.id}/reapply`, { method: "POST" }),
            );
          }}
        >
          Reaplicar contas
        </ActionButton>
      )}
      {result && (
        <p role="status">
          {result.requested} operação(ões) solicitada(s); {result.refused}{" "}
          recusada(s). {result.errors.join("; ")}
        </p>
      )}
      <ActionButton onClick={onDone}>Concluir</ActionButton>
    </div>
  ) : (
    <MutationForm
      onCancel={onCancel}
      onSubmit={async () => {
        setSaved(
          await api(`/plans/${plan.id}/network`, {
            method: "PUT",
            body: {
              rate_limit: form.rate_limit || null,
              address_pool: form.address_pool || null,
            },
          }),
        );
      }}
    >
      <FormField label="Rate limit">
        <Input
          value={form.rate_limit}
          onChange={(e) => setForm({ ...form, rate_limit: e.target.value })}
        />
      </FormField>
      <FormField label="Pool IPv4">
        <Input
          value={form.address_pool}
          onChange={(e) => setForm({ ...form, address_pool: e.target.value })}
        />
      </FormField>
      <p className="profile-footnote">
        Salvar não reaplica automaticamente as contas existentes.
      </p>
    </MutationForm>
  );
}
