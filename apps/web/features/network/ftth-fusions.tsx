import { useState } from "react";
import useSWR from "swr";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { FormField, MutationForm } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import {
  cablePageSchema,
  fusionListSchema,
  fusionSchema,
  type Fusion,
} from "./ftth-design-models";
import { useCableRefresh } from "./ftth-otdr";

const destination = (f: Fusion) =>
  f.b_port != null
    ? `Porta ${f.b_port} da caixa`
    : `${f.b_cable_name} · fibra ${f.b_fiber}`;

export function BoxFusions({ boxId, ports }: { boxId: string; ports: number }) {
  const { me } = useSession();
  const write = can(me, "network:write");
  const result = useSWR(["erp-ftth-fusions", boxId], async () =>
    fusionListSchema.parse(await api(`/ftth/boxes/${boxId}/fusions`)),
  );
  const refresh = useCableRefresh();
  const [creating, setCreating] = useState(false);
  return (
    <ProfileSection
      title="Fusões da caixa"
      caption="Registro fibra a fibra; cada fibra só pode ser fundida uma vez nesta caixa. O cadastro não comprova a continuidade óptica."
      action={
        write && (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            Registrar fusão
          </Button>
        )
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data?.items.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                {["Origem", "Destino", "Perda", "Observação", "Ação"].map(
                  (label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    {f.a_cable_name} · fibra {f.a_fiber}
                  </TableCell>
                  <TableCell>{destination(f)}</TableCell>
                  <TableCell>
                    {f.loss_db == null
                      ? "Não medida"
                      : `${f.loss_db.toLocaleString("pt-BR")} dB`}
                  </TableCell>
                  <TableCell>{f.notes || "—"}</TableCell>
                  <TableCell>
                    {write && (
                      <ActionButton
                        danger
                        label={`Remover fusão ${f.a_cable_name} fibra ${f.a_fiber}`}
                        confirm={`Remover a fusão de ${f.a_cable_name} · fibra ${f.a_fiber} com ${destination(f)}?`}
                        onClick={async () => {
                          await api(`/ftth/fusions/${f.id}`, {
                            method: "DELETE",
                          });
                          await Promise.all([result.mutate(), refresh()]);
                        }}
                      >
                        Remover
                      </ActionButton>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="profile-footnote">
            Nenhuma fusão registrada nesta caixa.
          </p>
        )}
      </QueryBoundary>
      {creating && (
        <FusionEditor
          boxId={boxId}
          ports={ports}
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await Promise.all([result.mutate(), refresh()]);
          }}
        />
      )}
    </ProfileSection>
  );
}

function CablePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (id: string, fibers: number) => void;
}) {
  const [query, setQuery] = useState("");
  const cables = useSWR(["erp-ftth-cable-pick", query.trim()], async ([, q]) =>
    cablePageSchema.parse(
      await api(
        `/ftth/cables?status=active&limit=20${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      ),
    ),
  );
  return (
    <>
      <FormField label={`Buscar ${label.toLowerCase()}`}>
        <Input
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </FormField>
      <FormField label={label}>
        <select
          className="commercial-select"
          required
          value={value}
          onChange={(e) => {
            const cable = cables.data?.items.find(
              (c) => c.id === e.target.value,
            );
            onChange(e.target.value, cable?.fiber_count ?? 0);
          }}
        >
          <option value="">Selecione</option>
          {(cables.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.fiber_count} fibras · {c.pop_name}
            </option>
          ))}
        </select>
      </FormField>
      {cables.error && (
        <QueryBoundary error={cables.error} retry={() => cables.mutate()}>
          {null}
        </QueryBoundary>
      )}
    </>
  );
}

function FusionEditor({
  boxId,
  ports,
  onClose,
  onDone,
}: {
  boxId: string;
  ports: number;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [a, setA] = useState({ id: "", fibers: 0 });
  const [b, setB] = useState({ id: "", fibers: 0 });
  const [target, setTarget] = useState<"fiber" | "port">("fiber");
  const [values, setValues] = useState({
    a_fiber: "1",
    b_fiber: "1",
    b_port: "1",
    loss: "",
    notes: "",
  });
  const set = (key: keyof typeof values) => (value: string) =>
    setValues((previous) => ({ ...previous, [key]: value }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="erp-editor">
        <DialogHeader>
          <DialogTitle>Registrar fusão</DialogTitle>
          <DialogDescription>
            Ligue a fibra de um cabo a outra fibra ou a uma porta desta caixa. O
            servidor confere faixa de fibras, POP e duplicidade.
          </DialogDescription>
        </DialogHeader>
        <MutationForm
          onCancel={onClose}
          onSubmit={async () => {
            const integer = (value: string, max: number, label: string) => {
              const n = Number(value);
              if (!Number.isInteger(n) || n < 1 || (max && n > max))
                throw new Error(
                  `Informe ${label} entre 1 e ${max || "o limite"}.`,
                );
              return n;
            };
            if (!a.id) throw new Error("Selecione o cabo de origem.");
            if (target === "fiber" && !b.id)
              throw new Error("Selecione o cabo de destino.");
            const loss = values.loss.trim()
              ? Number(values.loss.replace(",", "."))
              : null;
            if (
              loss !== null &&
              (!Number.isFinite(loss) || loss < -1 || loss > 5)
            )
              throw new Error("A perda medida deve ficar entre -1 e 5 dB.");
            fusionSchema.parse(
              await api(`/ftth/boxes/${boxId}/fusions`, {
                body: {
                  a_cable_id: a.id,
                  a_fiber: integer(
                    values.a_fiber,
                    a.fibers,
                    "a fibra de origem",
                  ),
                  ...(target === "fiber"
                    ? {
                        b_cable_id: b.id,
                        b_fiber: integer(
                          values.b_fiber,
                          b.fibers,
                          "a fibra de destino",
                        ),
                      }
                    : { b_port: integer(values.b_port, ports, "a porta") }),
                  loss_db: loss,
                  notes: values.notes.trim(),
                },
              }),
            );
            await onDone();
          }}
        >
          <div className="erp-columns">
            <CablePicker
              label="Cabo de origem"
              value={a.id}
              onChange={(id, fibers) => setA({ id, fibers })}
            />
            <FormField label="Fibra de origem">
              <Input
                type="number"
                min={1}
                max={a.fibers || 288}
                required
                value={values.a_fiber}
                onChange={(e) => set("a_fiber")(e.target.value)}
              />
            </FormField>
            <FormField label="Destino da fusão">
              <select
                className="commercial-select"
                value={target}
                onChange={(e) => setTarget(e.target.value as "fiber" | "port")}
              >
                <option value="fiber">Fibra de outro cabo</option>
                <option value="port">Porta da caixa</option>
              </select>
            </FormField>
            {target === "fiber" ? (
              <>
                <CablePicker
                  label="Cabo de destino"
                  value={b.id}
                  onChange={(id, fibers) => setB({ id, fibers })}
                />
                <FormField label="Fibra de destino">
                  <Input
                    type="number"
                    min={1}
                    max={b.fibers || 288}
                    required
                    value={values.b_fiber}
                    onChange={(e) => set("b_fiber")(e.target.value)}
                  />
                </FormField>
              </>
            ) : (
              <FormField label="Porta de destino">
                <Input
                  type="number"
                  min={1}
                  max={ports}
                  required
                  value={values.b_port}
                  onChange={(e) => set("b_port")(e.target.value)}
                />
              </FormField>
            )}
            <FormField label="Perda medida (dB)" hint="Opcional, de -1 a 5 dB.">
              <Input
                inputMode="decimal"
                value={values.loss}
                onChange={(e) => set("loss")(e.target.value)}
              />
            </FormField>
            <FormField label="Observação da fusão">
              <Input
                maxLength={200}
                value={values.notes}
                onChange={(e) => set("notes")(e.target.value)}
              />
            </FormField>
          </div>
        </MutationForm>
      </DialogContent>
    </Dialog>
  );
}
