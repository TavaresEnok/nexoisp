// Rede › Caixa óptica: portas da caixa com o cliente, a ONU e o sinal de cada uma.
import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "@/features/shared/feedback";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { cn } from "@/lib/utils";
import { api } from "@/platform/erp-client";
import {
  boxSchema,
  BoxEditor,
  detailSchema,
  DropEditor,
  useFiberRefresh,
} from "./ftth";
import { BoxFusions } from "./ftth-fusions";
import { OnuSheet } from "./onu-sheet";
import {
  boxHref,
  contractHref,
  Dbm,
  Kpi,
  Meter,
  oltHref,
  onuCondition,
  OnuConditionBadge,
  useNoc,
  useOnus,
  useSessions,
} from "./kit";

export function NetworkBox() {
  const { pathname } = useLocation();
  const id = pathname.replace(/^\/rede\/caixas\/?/, "").split("/")[0];
  const { me } = useSession();
  const navigate = useNavigate();
  const refresh = useFiberRefresh();
  const box = useSWR(id ? ["erp-ftth-box", id] : null, async () =>
    detailSchema.parse(await api(`/ftth/boxes/${id}`)),
  );
  const boxes = useSWR("erp-ftth-boxes", async () =>
    z.array(boxSchema).parse(await api("/ftth/boxes")),
  );
  const onus = useOnus();
  const sessions = useSessions();
  const noc = useNoc();
  const rxMin = noc.data?.settings.onu_rx_min_dbm ?? null;
  const [editing, setEditing] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [onuId, setOnuId] = useState<string | null>(null);
  const write = can(me, "network:write");
  const b = box.data;
  const children = (boxes.data ?? []).filter((x) => x.parent_id === id);
  const byPort = new Map(b?.drops.map((d) => [d.port, d]));
  const onuOf = (contract: string | null) =>
    contract
      ? onus.data?.find(
          (n) => n.contract_id === contract && n.desired_state === "authorized",
        )
      : undefined;
  const sessionOf = (contract: string | null) =>
    contract
      ? sessions.data?.find((s) => s.contract_id === contract)
      : undefined;
  const occupied = b?.drops.length ?? 0;
  const onlineCount = (b?.drops ?? []).filter((d) =>
    sessionOf(d.contract_id),
  ).length;
  const weakCount = (b?.drops ?? []).filter((d) => {
    const n = onuOf(d.contract_id);
    return n && onuCondition(n, rxMin) === "weak";
  }).length;
  const selectedOnu = onus.data?.find((n) => n.id === onuId);
  return (
    <>
      <Link
        to="/rede/ftth"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={14} /> Planta óptica
      </Link>
      <QueryBoundary
        loading={box.isLoading}
        error={box.error}
        retry={() => box.mutate()}
      >
        {b && (
          <>
            <PageHeading
              eyebrow={
                b.kind === "cto"
                  ? "CTO · caixa de terminação"
                  : "CEO · caixa de emenda"
              }
              title={b.name}
              description={b.address || "Sem endereço"}
              actions={
                <>
                  {b.latitude != null && b.longitude != null && (
                    <Button
                      variant="outline"
                      onClick={() => navigate(`/rede/mapa?foco=${b.id}`)}
                    >
                      Ver no mapa
                    </Button>
                  )}
                  {write && (
                    <Button variant="outline" onClick={() => setEditing(true)}>
                      Editar
                    </Button>
                  )}
                  {write && (
                    <ActionButton
                      danger
                      confirm={`Excluir a caixa ${b.name}? O servidor recusa se houver clientes ou caixas ligadas a ela.`}
                      onClick={async () => {
                        await api(`/ftth/boxes/${b.id}`, { method: "DELETE" });
                        await refresh();
                        navigate("/rede/ftth");
                      }}
                    >
                      Excluir
                    </ActionButton>
                  )}
                </>
              }
            />
            <div className="metrics-grid">
              <Kpi
                label="Portas ocupadas"
                value={`${occupied} / ${b.ports}`}
                detail={<Meter value={occupied} total={b.ports} label=" " />}
              />
              <Kpi
                label="Clientes online"
                value={`${onlineCount} / ${b.drops.filter((d) => d.contract_id).length}`}
              />
              <Kpi label="Sinal fraco" value={weakCount} />
              <Kpi
                label="Origem"
                value={
                  <span className="text-base font-medium">
                    {b.device_name
                      ? `${b.device_name} · ${b.pon_port ?? "—"}`
                      : "Sem OLT"}
                  </span>
                }
                detail={
                  b.parent_name
                    ? `Depois de ${b.parent_name}`
                    : "Sem caixa anterior"
                }
                href={
                  b.device_id ? oltHref(b.device_id, b.pon_port) : undefined
                }
              />
            </div>
            <div className="erp-stack">
              <Panel title="Portas" description={b.notes || undefined}>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {Array.from({ length: b.ports }, (_, i) => i + 1).map(
                    (number) => {
                      const drop = byPort.get(number);
                      const n = onuOf(drop?.contract_id ?? null);
                      const s = sessionOf(drop?.contract_id ?? null);
                      const condition = n ? onuCondition(n, rxMin) : null;
                      return (
                        <div
                          key={number}
                          className={cn(
                            "flex min-h-[112px] flex-col gap-2 rounded-lg border p-3",
                            !drop && "border-dashed",
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                              PORTA {number}
                            </span>
                            {condition ? (
                              <OnuConditionBadge value={condition} />
                            ) : drop && !drop.contract_id ? (
                              <span className="text-xs text-muted-foreground">
                                Reservada
                              </span>
                            ) : null}
                          </div>
                          {drop ? (
                            <>
                              {drop.contract_id ? (
                                <Link
                                  className="font-medium hover:underline"
                                  to={contractHref(drop.contract_id)}
                                >
                                  {drop.subscriber_name ?? "Contrato"}
                                </Link>
                              ) : (
                                <span className="text-sm">
                                  {drop.note || "Reserva"}
                                </span>
                              )}
                              <div className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                                {n && (
                                  <Dbm value={n.observed_rx_dbm} min={rxMin} />
                                )}
                                {s?.ip && <span className="mono">{s.ip}</span>}
                              </div>
                              <div className="mt-auto flex gap-1">
                                {n && (
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    aria-label={`ONU da porta ${number}`}
                                    onClick={() => setOnuId(n.id)}
                                  >
                                    ONU
                                  </Button>
                                )}
                                {write && (
                                  <ActionButton
                                    size="xs"
                                    variant="ghost"
                                    label={`Liberar porta ${number}`}
                                    confirm={`Liberar a porta ${number}?`}
                                    onClick={async () => {
                                      await api(`/ftth/drops/${drop.id}`, {
                                        method: "DELETE",
                                      });
                                      await refresh();
                                      await box.mutate();
                                    }}
                                  >
                                    Liberar
                                  </ActionButton>
                                )}
                              </div>
                            </>
                          ) : (
                            <>
                              <span className="text-sm text-muted-foreground">
                                Livre
                              </span>
                              {write && (
                                <Button
                                  size="xs"
                                  variant="outline"
                                  className="mt-auto self-start"
                                  aria-label={`Ligar cliente à porta ${number}`}
                                  onClick={() => setPort(number)}
                                >
                                  Ligar cliente
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      );
                    },
                  )}
                </div>
              </Panel>
              {children.length > 0 && (
                <Panel
                  title="Caixas ligadas a esta"
                  description={`${children.length} caixa(s)`}
                >
                  <div className="flex flex-col">
                    {children.map((child) => (
                      <Link
                        key={child.id}
                        to={boxHref(child.id)}
                        className="flex items-center justify-between gap-4 border-t py-3 text-sm hover:bg-muted/50"
                      >
                        <span className="font-medium">{child.name}</span>
                        <span className="text-muted-foreground">
                          {child.address}
                        </span>
                        <Meter value={child.used} total={child.ports} />
                      </Link>
                    ))}
                  </div>
                </Panel>
              )}
              <BoxFusions boxId={b.id} ports={b.ports} />
            </div>
          </>
        )}
      </QueryBoundary>
      {editing && b && (
        <BoxEditor
          box={b}
          boxes={boxes.data ?? []}
          onClose={() => setEditing(false)}
          onDone={async () => {
            setEditing(false);
            await refresh();
            await box.mutate();
          }}
        />
      )}
      {port !== null && (
        <DropEditor
          boxId={id}
          port={port}
          onClose={() => setPort(null)}
          onDone={async () => {
            setPort(null);
            await refresh();
            await box.mutate();
          }}
        />
      )}
      {selectedOnu && (
        <OnuSheet
          onu={selectedOnu}
          rxMin={rxMin}
          onClose={() => setOnuId(null)}
        />
      )}
    </>
  );
}
