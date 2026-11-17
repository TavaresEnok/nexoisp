// Ficha lateral de uma ONU: tudo o que o técnico precisa para decidir sem sair da tela onde está.
import useSWR, { useSWRConfig } from "swr";
import { z } from "zod";
import { Link, useNavigate } from "react-router-dom";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import { actionLabels, operationLabels, operationSchema } from "./models";
import {
  ago,
  boxHref,
  contractHref,
  Dbm,
  oltHref,
  onuCondition,
  OnuConditionBadge,
  useSessions,
  type Onu,
} from "./kit";

const ftthSchema = z.object({
  drop: z
    .object({
      box_id: z.string(),
      box_name: z.string(),
      port: z.number(),
    })
    .passthrough()
    .nullable(),
});

export function useOnuRefresh() {
  const { mutate } = useSWRConfig();
  return () =>
    mutate(
      (key) =>
        key === "erp-onus" ||
        key === "erp-discoveries" ||
        key === "erp-noc" ||
        (Array.isArray(key) &&
          [
            "erp-contract-onu",
            "erp-contract-onu-ops",
            "erp-operations",
            "erp-operation",
            "erp-diagnosis",
          ].includes(key[0])),
    );
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-t py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export function OnuSheet({
  onu,
  rxMin,
  onClose,
}: {
  onu: Onu;
  rxMin: number | null;
  onClose: () => void;
}) {
  const { me } = useSession();
  const navigate = useNavigate();
  const refresh = useOnuRefresh();
  const operate = can(me, "network:operate");
  const ftth = useSWR(["erp-contract-ftth", onu.contract_id], async () =>
    ftthSchema.parse(await api(`/contracts/${onu.contract_id}/ftth`)),
  );
  const history = useSWR(["erp-contract-onu-ops", onu.contract_id], async () =>
    z
      .object({ operations: z.array(operationSchema) })
      .passthrough()
      .parse(await api(`/contracts/${onu.contract_id}/onu`)),
  );
  const sessions = useSessions();
  const session = sessions.data?.find((s) => s.contract_id === onu.contract_id);
  const condition = onuCondition(onu, rxMin);
  const detail = onu.observed_detail;
  const drop = ftth.data?.drop;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="ticket-sheet">
        <SheetHeader>
          <p className="eyebrow">ONU</p>
          <SheetTitle>{onu.subscriber_name}</SheetTitle>
          <SheetDescription className="mono">{onu.serial}</SheetDescription>
          <div>
            <OnuConditionBadge value={condition} />
          </div>
        </SheetHeader>
        <div className="sheet-content-body erp-stack">
          <dl className="grid grid-cols-2 gap-x-6">
            <Fact label="Sinal recebido (RX)">
              <Dbm value={onu.observed_rx_dbm} min={rxMin} />
            </Fact>
            <Fact label="Sinal enviado (TX)">
              <Dbm value={onu.observed_tx_dbm} min={null} />
            </Fact>
            <Fact label="OLT · PON">
              <Link
                className="text-link"
                to={oltHref(onu.device_id, onu.pon_port)}
              >
                {onu.device_name} · {onu.pon_port}
              </Link>
            </Fact>
            <Fact label="Caixa · porta">
              {drop ? (
                <Link className="text-link" to={boxHref(drop.box_id)}>
                  {drop.box_name} · {drop.port}
                </Link>
              ) : (
                <span className="text-muted-foreground">Não registrada</span>
              )}
            </Fact>
            <Fact label="Sessão PPPoE">
              {session ? (
                <span className="mono">
                  {session.ip} · {session.uptime}
                </span>
              ) : (
                <span className="text-muted-foreground">Sem sessão aberta</span>
              )}
            </Fact>
            <Fact label="Distância da OLT">
              {detail?.distance_m
                ? `${(detail.distance_m / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} km`
                : "—"}
            </Fact>
            <Fact label="Perfil · VLAN">
              {onu.line_profile}
              {onu.service_profile ? ` / ${onu.service_profile}` : ""} · VLAN{" "}
              {onu.service_vlan}
            </Fact>
            <Fact label="Última queda">
              {detail?.last_down_cause && detail.last_down_cause !== "-"
                ? detail.last_down_cause
                : "—"}
            </Fact>
            <Fact label="Leitura da OLT">{ago(onu.observed_at)}</Fact>
            <Fact label="Agente">
              {onu.agent_online ? "Online" : "Offline"}
              {onu.agent_name ? ` · ${onu.agent_name}` : ""}
            </Fact>
          </dl>
          {onu.drift && (
            <p role="alert" className="text-sm">
              A leitura da OLT diverge do que foi pedido.
            </p>
          )}
          <div className="erp-inline-actions">
            <Button onClick={() => navigate(contractHref(onu.contract_id))}>
              Abrir contrato
            </Button>
            {operate && onu.desired_state === "authorized" && (
              <>
                <ActionButton
                  disabled={onu.observed_online !== true}
                  confirm="Reiniciar a ONU? O cliente fica sem conexão por cerca de um minuto."
                  onClick={async () => {
                    await api(`/onus/${onu.id}/reboot`, {
                      body: { reason: "reinício da ONU pela OLT" },
                    });
                    await refresh();
                  }}
                >
                  Reiniciar ONU
                </ActionButton>
                <ActionButton
                  onClick={async () => {
                    await api(`/onus/${onu.id}/authorize`, {
                      body: { reason: "reaplicar autorização" },
                    });
                    await refresh();
                  }}
                >
                  Reaplicar autorização
                </ActionButton>
                <ActionButton
                  danger
                  confirm="Desautorizar a ONU na OLT? O cliente fica sem internet."
                  onClick={async () => {
                    await api(`/onus/${onu.id}/deauthorize`, {
                      body: { reason: "desautorização manual" },
                    });
                    await refresh();
                  }}
                >
                  Desautorizar
                </ActionButton>
              </>
            )}
          </div>
          {!!history.data?.operations.length && (
            <section className="flex flex-col">
              <h3 className="mb-2 text-sm font-medium">Últimas operações</h3>
              {history.data.operations.slice(0, 6).map((op) => (
                <Link
                  key={op.id}
                  to={`?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(window.location.search)), operacao: op.id })}`}
                  className="flex items-center justify-between gap-3 border-t py-2 text-sm hover:bg-muted/50"
                >
                  <span>{actionLabels[op.action] ?? op.action}</span>
                  <span className="text-xs text-muted-foreground">
                    {operationLabels[op.status] ?? op.status} ·{" "}
                    {ago(op.created_at)}
                  </span>
                </Link>
              ))}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
