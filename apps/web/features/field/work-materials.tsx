import { useEffect, useState } from "react";
import useSWR from "swr";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from "@/components/ui/table";
import { FormField, MutationForm } from "@/features/shared/form";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can, sessionScope } from "@/features/session/model";
import { ApiError } from "@/data/erp/http";
import { api } from "@/platform/erp-client";
import {
  acquireMaterialIntent,
  materialIntentKey,
  readMaterialIntent,
  settleMaterialIntent,
  type MaterialIntent,
} from "./material-intent";
import type { OrderDetail } from "./models";
type Item = {
  id: string;
  name: string;
  unit: string;
  serialized: boolean;
  active: boolean;
  balance: number;
};
type Unit = {
  id: string;
  serial: string;
  item_name: string;
  status: string;
  holder_name: string | null;
};
export function WorkMaterials({
  order,
  refresh,
}: {
  order: OrderDetail;
  refresh: () => Promise<void>;
}) {
  const { me } = useSession();
  if (!me) return null;
  return (
    <WorkMaterialsScoped
      key={`${sessionScope(me)}:${order.id}`}
      order={order}
      refresh={refresh}
      scope={sessionScope(me)}
      me={me}
    />
  );
}
function WorkMaterialsScoped({
  order,
  refresh,
  scope,
  me,
}: {
  order: OrderDetail;
  refresh: () => Promise<void>;
  scope: string;
  me: NonNullable<ReturnType<typeof useSession>["me"]>;
}) {
  const key = materialIntentKey(scope, order.id);
  const [pending, setPending] = useState<MaterialIntent | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    try {
      const intent = readMaterialIntent(window.localStorage, key);
      setPending(intent);
      if (intent) setForm({ item_id: intent.item_id, qty: String(intent.qty) });
    } catch {
      setStorageError(
        "Não foi possível acessar a intenção guardada. O lançamento não será enviado.",
      );
    }
    setLoaded(true);
  }, [key]);
  const writable =
    can(me, "os:write") && !["done", "canceled"].includes(order.status);
  const items = useSWR(
    writable && can(me, "stock:read") ? "erp-stock-items" : null,
    () => api<Item[]>("/stock/items"),
  );
  const [form, setForm] = useState({ item_id: "", qty: "1" });
  const [serial, setSerial] = useState("");
  const units = useSWR(
    writable && can(me, "stock:read") && serial.trim().length >= 3
      ? ["erp-unit-search", serial.trim()]
      : null,
    ([, serial]) =>
      api<Unit[]>(`/stock/units?serial=${encodeURIComponent(serial)}`),
  );
  const available =
    units.data
      ?.filter((unit) => ["in_stock", "with_tech"].includes(unit.status))
      .slice(0, 5) ?? [];
  return (
    <ProfileSection title="Materiais e equipamentos">
      <div className="erp-stack">
        {order.materials.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Material</TableHead>
                <TableHead>Quantidade</TableHead>
                <TableHead>Registrado por</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.materials.map((material) => (
                <TableRow key={material.id}>
                  <TableCell>{material.item_name}</TableCell>
                  <TableCell>
                    {material.qty} {material.unit}
                  </TableCell>
                  <TableCell>{material.created_by_name ?? "Equipe"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="profile-footnote">
            Nenhum material registrado nesta OS.
          </p>
        )}
        {(writable || (pending && can(me, "os:write"))) &&
          can(me, "stock:read") && (
            <>
              <QueryBoundary
                loading={items.isLoading}
                error={items.error}
                retry={() => items.mutate()}
              >
                <MutationForm
                  submit={
                    pending
                      ? "Confirmar lançamento pendente"
                      : "Lançar material"
                  }
                  onSubmit={async () => {
                    if (!loaded || storageError)
                      throw new Error(
                        "Armazenamento indisponível; lançamento não enviado.",
                      );
                    let intent = pending;
                    if (!intent) {
                      const qty = Number(form.qty);
                      if (
                        !form.item_id ||
                        !Number.isInteger(qty) ||
                        qty === 0 ||
                        Math.abs(qty) > 10000
                      )
                        throw new Error(
                          "Informe material e quantidade inteira entre -10000 e 10000, diferente de zero.",
                        );
                      const proposed = {
                        intention_id: crypto.randomUUID(),
                        item_id: form.item_id,
                        qty,
                      };
                      try {
                        intent = await acquireMaterialIntent(
                          window.localStorage,
                          navigator.locks,
                          key,
                          () => proposed,
                        );
                      } catch {
                        throw new Error(
                          "Não foi possível guardar e coordenar a intenção; lançamento não enviado.",
                        );
                      }
                      setPending(intent);
                      if (intent.intention_id !== proposed.intention_id) {
                        setForm({
                          item_id: intent.item_id,
                          qty: String(intent.qty),
                        });
                        throw new Error(
                          "Há um lançamento pendente; confirme-o antes de continuar.",
                        );
                      }
                    }
                    try {
                      await api(`/work-orders/${order.id}/materials`, {
                        body: intent,
                      });
                    } catch (error) {
                      if (
                        error instanceof ApiError &&
                        (error.status === 400 ||
                          (error.status === 409 &&
                            error.message.startsWith("saldo insuficiente")))
                      ) {
                        const current = await settleMaterialIntent(
                          window.localStorage,
                          navigator.locks,
                          key,
                          intent.intention_id,
                        );
                        setPending(current);
                        if (current)
                          setForm({
                            item_id: current.item_id,
                            qty: String(current.qty),
                          });
                      }
                      throw error;
                    }
                    const current = await settleMaterialIntent(
                      window.localStorage,
                      navigator.locks,
                      key,
                      intent.intention_id,
                    );
                    setPending(current);
                    setForm(
                      current
                        ? { item_id: current.item_id, qty: String(current.qty) }
                        : { item_id: "", qty: "1" },
                    );
                    await Promise.all([items.mutate(), refresh()]);
                  }}
                >
                  <div className="erp-columns">
                    {storageError && <p role="alert">{storageError}</p>}
                    {pending && (
                      <p>
                        Resultado pendente: confirme este lançamento antes de
                        registrar outro.
                      </p>
                    )}
                    <FormField label="Material do estoque">
                      <select
                        className="commercial-select"
                        required
                        disabled={!loaded || !!storageError || !!pending}
                        value={form.item_id}
                        onChange={(e) =>
                          setForm({ ...form, item_id: e.target.value })
                        }
                      >
                        <option value="">Selecione um material</option>
                        {items.data
                          ?.filter((item) => item.active && !item.serialized)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · saldo {item.balance} {item.unit}
                            </option>
                          ))}
                      </select>
                    </FormField>
                    <FormField
                      label="Quantidade de material"
                      hint="Uma quantidade negativa registra devolução ao estoque."
                    >
                      <Input
                        required
                        disabled={!loaded || !!storageError || !!pending}
                        type="number"
                        step={1}
                        value={form.qty}
                        onChange={(e) =>
                          setForm({ ...form, qty: e.target.value })
                        }
                      />
                    </FormField>
                  </div>
                </MutationForm>
              </QueryBoundary>
              {writable && (
                <>
                  <FormField
                    label="Buscar equipamento por série"
                    hint="Digite ao menos três caracteres. A instalação usa a modalidade comodato."
                  >
                    <Input
                      value={serial}
                      onChange={(e) => setSerial(e.target.value)}
                    />
                  </FormField>
                  <QueryBoundary
                    loading={units.isLoading}
                    error={units.error}
                    retry={() => units.mutate()}
                  >
                    {available.map((unit) => (
                      <div className="erp-contract-card" key={unit.id}>
                        <strong>
                          {unit.serial} · {unit.item_name}
                        </strong>
                        <p>
                          {unit.holder_name
                            ? `Com ${unit.holder_name}`
                            : "No almoxarifado"}
                        </p>
                        <ActionButton
                          onClick={async () => {
                            await api(`/work-orders/${order.id}/units`, {
                              body: { unit_id: unit.id },
                            });
                            setSerial("");
                            await refresh();
                          }}
                        >
                          Instalar equipamento
                        </ActionButton>
                      </div>
                    ))}
                    {units.data &&
                      serial.trim().length >= 3 &&
                      !available.length && (
                        <p className="profile-footnote">
                          Nenhuma unidade disponível com essa série.
                        </p>
                      )}
                  </QueryBoundary>
                </>
              )}
            </>
          )}
      </div>
    </ProfileSection>
  );
}
