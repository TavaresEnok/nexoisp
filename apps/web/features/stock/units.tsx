import { useState } from "react";
import useSWR from "swr";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FormField, MutationForm } from "@/features/shared/form";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import {
  stockUnitSchema,
  unitLabels,
  unitEventSchema,
  useStockRefresh,
  type StockItem,
  type StockUnit,
} from "./models";

export function StockUnits({ item }: { item: StockItem }) {
  const { me } = useSession();
  const writable = can(me, "stock:write");
  const navigate = useNavigate();
  const refresh = useStockRefresh();
  const result = useSWR(["erp-stock-units", item.id], async ([, id]) =>
    z.array(stockUnitSchema).parse(await api(`/stock/items/${id}/units`)),
  );
  const staff = useSWR(
    writable && can(me, "os:read") ? "erp-staff" : null,
    () => api<{ id: string; name: string }[]>("/staff"),
  );
  const [serials, setSerials] = useState("");
  const [history, setHistory] = useState<StockUnit | null>(null);
  const [editor, setEditor] = useState<{
    type: "transfer" | "writeoff";
    unit: StockUnit;
  } | null>(null);
  const status = async (unit: StockUnit, value: string) => {
    await api(`/stock/units/${unit.id}/status`, { body: { status: value } });
    await refresh();
  };
  return (
    <div className="erp-stack">
      {writable && (
        <MutationForm
          submit="Receber lote de unidades"
          onSubmit={async () => {
            const values = serials.split(/[\s,;]+/).filter(Boolean);
            if (!values.length)
              throw new Error("Informe ao menos um número de série.");
            await api(`/stock/items/${item.id}/units`, {
              body: { serials: values },
            });
            setSerials("");
            await refresh();
          }}
        >
          <FormField
            label="Números de série para entrada"
            hint="Até 500 unidades por lote. Separe por linha, espaço, vírgula ou ponto e vírgula."
          >
            <Textarea
              required
              value={serials}
              onChange={(event) => setSerials(event.target.value)}
            />
          </FormField>
        </MutationForm>
      )}
      <p className="profile-footnote">
        Até 2.000 unidades retornadas pelo servidor. O saldo inclui as unidades
        com técnico e com defeito; unidades instaladas e baixadas saem do saldo.
      </p>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data?.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                {[
                  "Número de série",
                  "Situação",
                  "Localização / vínculo",
                  "Ações",
                ].map((label) => (
                  <TableHead key={label}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.map((unit) => (
                <TableRow key={unit.id}>
                  <TableCell className="mono">{unit.serial}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        unit.status === "defective"
                          ? "warning"
                          : unit.status === "written_off"
                            ? "destructive"
                            : "outline"
                      }
                    >
                      {unitLabels[unit.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {unit.status === "with_tech" ? (
                      unit.holder_name || "Técnico não informado"
                    ) : unit.status === "installed" ? (
                      <>
                        <span>
                          {unit.subscriber_name ?? "Titular não informado"} ·{" "}
                          {unit.contract_mode === "comodato"
                            ? "Comodato"
                            : unit.contract_mode === "sale"
                              ? "Venda"
                              : "Modalidade não informada"}
                        </span>
                        {unit.contract_id && can(me, "contracts:read") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              navigate(
                                `/contratos?contrato=${unit.contract_id}`,
                              )
                            }
                          >
                            Abrir contrato
                          </Button>
                        )}
                        {unit.work_order_id && can(me, "os:read") && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              navigate(
                                `/ordens-de-servico?ordem=${unit.work_order_id}`,
                              )
                            }
                          >
                            Abrir OS {unit.work_order_number}
                          </Button>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="erp-inline-actions">
                      {writable && (
                        <>
                          {["in_stock", "with_tech"].includes(unit.status) &&
                            can(me, "os:read") && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  setEditor({ type: "transfer", unit })
                                }
                              >
                                Distribuir unidade
                              </Button>
                            )}
                          {unit.status === "installed" && (
                            <ActionButton
                              confirm={`Registrar a retirada de ${unit.serial} do assinante e devolver ao almoxarifado?`}
                              onClick={() => status(unit, "in_stock")}
                            >
                              Registrar retirada
                            </ActionButton>
                          )}
                          {["in_stock", "with_tech", "installed"].includes(
                            unit.status,
                          ) && (
                            <ActionButton
                              onClick={() => status(unit, "defective")}
                            >
                              Marcar defeito
                            </ActionButton>
                          )}
                          {unit.status === "defective" && (
                            <ActionButton
                              onClick={() => status(unit, "in_stock")}
                            >
                              Registrar conserto
                            </ActionButton>
                          )}
                          {unit.status !== "written_off" && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() =>
                                setEditor({ type: "writeoff", unit })
                              }
                            >
                              Baixar unidade
                            </Button>
                          )}
                        </>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setHistory(unit)}
                      >
                        Histórico da unidade
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="profile-footnote">Nenhuma unidade recebida.</p>
        )}
      </QueryBoundary>
      {history && (
        <UnitHistory unit={history} onClose={() => setHistory(null)} />
      )}
      {editor && (
        <RecordEditor
          title={
            editor.type === "transfer" ? "Distribuir unidade" : "Baixar unidade"
          }
          description={
            editor.type === "transfer"
              ? `Destino de ${editor.unit.serial}.`
              : `${editor.unit.serial} sairá do saldo e não poderá voltar ao estoque. Informe o motivo.`
          }
          initial={
            editor.type === "transfer"
              ? { holder_id: editor.unit.holder_id ?? "" }
              : { note: "" }
          }
          loading={editor.type === "transfer" && staff.isLoading}
          error={editor.type === "transfer" ? staff.error : undefined}
          retry={() => staff.mutate()}
          fields={
            editor.type === "transfer"
              ? [
                  {
                    key: "holder_id",
                    label: "Destino da unidade",
                    type: "select",
                    options: [
                      { value: "", label: "Almoxarifado" },
                      ...(staff.data ?? []).map((user) => ({
                        value: user.id,
                        label: user.name,
                      })),
                    ],
                  },
                ]
              : [
                  {
                    key: "note",
                    label: "Motivo da baixa",
                    type: "textarea",
                    required: true,
                    maxLength: 300,
                  },
                ]
          }
          onClose={() => setEditor(null)}
          onSubmit={async (values) => {
            await api(
              `/stock/units/${editor.unit.id}/${editor.type === "transfer" ? "transfer" : "status"}`,
              {
                body:
                  editor.type === "transfer"
                    ? { holder_id: values.holder_id || null }
                    : { status: "written_off", note: values.note },
              },
            );
            await refresh();
            setEditor(null);
          }}
        />
      )}
    </div>
  );
}

function UnitHistory({
  unit,
  onClose,
}: {
  unit: StockUnit;
  onClose: () => void;
}) {
  const result = useSWR(["erp-stock-events", unit.id], async ([, id]) =>
    z.array(unitEventSchema).parse(await api(`/stock/units/${id}/events`)),
  );
  const labels: Record<string, string> = {
    received: "Entrada",
    to_tech: "Entregue ao técnico",
    to_stock: "Voltou ao almoxarifado",
    installed: "Instalada",
    returned: "Retirada do assinante",
    defective: "Marcada com defeito",
    written_off: "Baixada",
  };
  return (
    <ProfileSection
      title={`Histórico · ${unit.serial}`}
      action={
        <Button variant="ghost" size="sm" onClick={onClose}>
          Fechar histórico
        </Button>
      }
    >
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        <div className="profile-recent">
          {result.data?.map((event, index) => (
            <div key={index}>
              <span className="timeline-dot" />
              <div>
                <strong>{labels[event.event] ?? event.event}</strong>
                <p>
                  {String(event.detail.to ?? "")}
                  {event.detail.work_order
                    ? ` · OS ${event.detail.work_order}`
                    : ""}
                  {event.detail.note ? ` · ${event.detail.note}` : ""}
                </p>
                <small>
                  {new Date(event.at).toLocaleString("pt-BR")} ·{" "}
                  {event.actor_name ?? "Sistema"}
                </small>
              </div>
            </div>
          ))}
        </div>
        {result.data?.length === 0 && (
          <p className="profile-footnote">Nenhum evento registrado.</p>
        )}
      </QueryBoundary>
    </ProfileSection>
  );
}
