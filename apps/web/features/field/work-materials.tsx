import { useState } from "react";
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
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
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
        {writable && can(me, "stock:read") && (
          <>
            <QueryBoundary
              loading={items.isLoading}
              error={items.error}
              retry={() => items.mutate()}
            >
              <MutationForm
                submit="Lançar material"
                onSubmit={async () => {
                  await api(`/work-orders/${order.id}/materials`, {
                    body: { item_id: form.item_id, qty: Number(form.qty) },
                  });
                  setForm({ item_id: "", qty: "1" });
                  await Promise.all([items.mutate(), refresh()]);
                }}
              >
                <div className="erp-columns">
                  <FormField label="Material do estoque">
                    <select
                      className="commercial-select"
                      required
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
              {units.data && serial.trim().length >= 3 && !available.length && (
                <p className="profile-footnote">
                  Nenhuma unidade disponível com essa série.
                </p>
              )}
            </QueryBoundary>
          </>
        )}
      </div>
    </ProfileSection>
  );
}
