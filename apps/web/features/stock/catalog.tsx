import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary, ConnectedNotice } from "@/features/shared/feedback";
import { FormField } from "@/features/shared/form";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { normalize } from "@/lib/format";
import { stockItemSchema, useStockRefresh, type StockItem } from "./models";
import { StockMovements } from "./movements";
import { StockUnits } from "./units";
import { useCreateRequest } from "@/features/shared/create-request";

export function StockCatalog() {
  const { me } = useSession();
  const writable = can(me, "stock:write");
  useCreateRequest("item", () => setModal({ type: "new" }), writable);
  const refresh = useStockRefresh();
  const result = useSWR("erp-stock-items", async () =>
    z.array(stockItemSchema).parse(await api("/stock/items")),
  );
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<{
    type: "new" | "edit" | "moves" | "units";
    id?: string;
  } | null>(null);
  const item = result.data?.find((item) => item.id === modal?.id);
  const rows =
    result.data?.filter((item) =>
      normalize(`${item.name} ${item.sku ?? ""}`).includes(
        normalize(query.trim()),
      ),
    ) ?? [];
  return (
    <>
      <ConnectedNotice demo={me?.demo} />
      <PageHeading
        title="Estoque"
        description="Materiais, saldos e rastreabilidade dos equipamentos do provedor."
        actions={
          writable && (
            <Button onClick={() => setModal({ type: "new" })}>
              Novo item de estoque
            </Button>
          )
        }
      />
      <Panel
        title="Catálogo de materiais"
        description="Saldos calculados pelos movimentos registrados no ERP."
        action={
          <FormField label="Buscar no catálogo de estoque">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Nome ou código"
            />
          </FormField>
        }
      >
        <QueryBoundary
          loading={result.isLoading}
          error={result.error}
          retry={() => result.mutate()}
        >
          {rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "Item / código",
                    "Saldo",
                    "Mínimo",
                    "Situação",
                    "Ações",
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <strong>{item.name}</strong>
                      <p className="profile-footnote">
                        {item.sku || "Sem código"}
                      </p>
                      {item.serialized && (
                        <Badge variant="outline">Por número de série</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.balance} {item.unit}
                      {item.with_tech > 0 && (
                        <p className="profile-footnote">
                          {item.with_tech} com técnico
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.min_qty} {item.unit}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          !item.active
                            ? "secondary"
                            : item.low
                              ? "warning"
                              : "outline"
                        }
                      >
                        {!item.active
                          ? "Inativo"
                          : item.low
                            ? "Abaixo do mínimo"
                            : "Saldo regular"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="erp-inline-actions">
                        {item.serialized && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setModal({ type: "units", id: item.id })
                            }
                          >
                            Unidades
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setModal({ type: "moves", id: item.id })
                          }
                        >
                          Movimentos
                        </Button>
                        {writable && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setModal({ type: "edit", id: item.id })
                              }
                            >
                              Editar item
                            </Button>
                            <ActionButton
                              onClick={async () => {
                                await api(`/stock/items/${item.id}`, {
                                  method: "PATCH",
                                  body: { active: !item.active },
                                });
                                await refresh();
                              }}
                            >
                              {item.active ? "Desativar item" : "Ativar item"}
                            </ActionButton>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="profile-footnote">Nenhum item nesta consulta.</p>
          )}
          <p className="profile-footnote">
            {rows.length} de {result.data?.length ?? 0} itens retornados pelo
            servidor · busca nesta lista.
          </p>
        </QueryBoundary>
      </Panel>
      {modal?.type === "new" && (
        <StockItemEditor onClose={() => setModal(null)} refresh={refresh} />
      )}
      {modal?.type === "edit" && item && (
        <StockItemEditor
          item={item}
          onClose={() => setModal(null)}
          refresh={refresh}
        />
      )}
      {item && (modal?.type === "units" || modal?.type === "moves") && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setModal(null);
          }}
        >
          <DialogContent className="erp-editor">
            <DialogHeader>
              <DialogTitle>
                {modal.type === "units" ? "Unidades" : "Movimentos"} ·{" "}
                {item.name}
              </DialogTitle>
              <DialogDescription>
                Saldo do item: {item.balance} {item.unit}. Registros conectados
                ao ERP.
              </DialogDescription>
            </DialogHeader>
            {modal.type === "units" ? (
              <StockUnits item={item} />
            ) : (
              <StockMovements item={item} />
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function StockItemEditor({
  item,
  onClose,
  refresh,
}: {
  item?: StockItem;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  return (
    <RecordEditor
      title={item ? "Editar item de estoque" : "Novo item de estoque"}
      description="O tipo de controle não pode ser alterado após o primeiro movimento."
      initial={{
        name: item?.name ?? "",
        sku: item?.sku ?? "",
        unit: item?.unit ?? "un",
        min_qty: String(item?.min_qty ?? 0),
        serialized: String(item?.serialized ?? false),
      }}
      fields={[
        { key: "name", label: "Nome do item", required: true, maxLength: 120 },
        { key: "sku", label: "Código do item", maxLength: 60 },
        {
          key: "unit",
          label: "Unidade de medida",
          required: true,
          maxLength: 6,
          hint: "Até seis letras, como un, m ou cx.",
        },
        {
          key: "min_qty",
          label: "Estoque mínimo",
          type: "number",
          required: true,
          min: 0,
          max: 1000000,
        },
        {
          key: "serialized",
          label: "Controle de unidades",
          type: "select",
          options: [
            { value: "false", label: "Por quantidade" },
            { value: "true", label: "Por número de série" },
          ],
        },
      ]}
      onClose={onClose}
      onSubmit={async (values) => {
        await api(item ? `/stock/items/${item.id}` : "/stock/items", {
          method: item ? "PATCH" : "POST",
          body: {
            ...values,
            sku: values.sku || null,
            min_qty: Number(values.min_qty),
            serialized: values.serialized === "true",
          },
        });
        await refresh();
        onClose();
      }}
    />
  );
}
