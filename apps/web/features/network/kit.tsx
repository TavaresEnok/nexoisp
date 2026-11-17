// Peças comuns da área Rede: consultas compartilhadas, leitura de sinal e situação.
// Todas as páginas da área usam as mesmas chaves SWR, então o mesmo dado não é buscado duas vezes.
import type { ReactNode } from "react";
import useSWR from "swr";
import { z } from "zod";
import { Link, useNavigate } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Status } from "@/components/workspace-ui";
import { cn } from "@/lib/utils";
import { api } from "@/platform/erp-client";
import { onuSchema, discoverySchema } from "./onus";
import { overviewSchema } from "./noc";

export type Onu = z.infer<typeof onuSchema>;
export type Discovery = z.infer<typeof discoverySchema>;

export function useOnus(enabled = true) {
  return useSWR(
    enabled ? "erp-onus" : null,
    async () => z.array(onuSchema).parse(await api("/onus")),
    { refreshInterval: 10000 },
  );
}
export function useDiscoveries(enabled = true) {
  return useSWR(
    enabled ? "erp-discoveries" : null,
    async () => z.array(discoverySchema).parse(await api("/olt/discoveries")),
    { refreshInterval: 10000 },
  );
}
export function useNoc(enabled = true) {
  return useSWR(
    enabled ? "erp-noc" : null,
    async () => overviewSchema.parse(await api("/noc/overview")),
    { refreshInterval: 10000 },
  );
}
const sessionSchema = z.object({
  contract_id: z.string().nullable(),
  subscriber_name: z.string().nullable(),
  login: z.string().nullable(),
  ip: z.string().nullable(),
  nas: z.string().nullable(),
  pop: z.string().nullable(),
  uptime: z.string().nullable(),
});
export type OnlineSession = z.infer<typeof sessionSchema>;
// Sessões abertas no accounting; a lista completa é pequena o bastante para indexar por contrato.
export function useSessions(enabled = true) {
  return useSWR(
    enabled ? "erp-network-sessions" : null,
    async () =>
      z
        .object({ rows: z.array(sessionSchema) })
        .parse(await api("/network/online?q=")).rows,
    { refreshInterval: 15000 },
  );
}

/** Situação de uma ONU como o técnico lê: online, offline, sinal fraco, sem leitura ou fora da OLT. */
export type OnuCondition =
  | "online"
  | "weak"
  | "offline"
  | "unread"
  | "absent"
  | "removed";
export function onuCondition(onu: Onu, rxMin: number | null): OnuCondition {
  if (onu.desired_state !== "authorized") return "removed";
  if (!onu.observed_at) return "unread";
  if (onu.observed_state !== "authorized") return "absent";
  if (onu.observed_online === false) return "offline";
  if (
    rxMin != null &&
    onu.observed_rx_dbm != null &&
    onu.observed_rx_dbm < rxMin
  )
    return "weak";
  return onu.observed_online ? "online" : "unread";
}
export const conditionLabels: Record<OnuCondition, string> = {
  online: "Online",
  weak: "Sinal fraco",
  offline: "Offline",
  unread: "Sem leitura",
  absent: "Fora da OLT",
  removed: "Desautorizada",
};
export function OnuConditionBadge({ value }: { value: OnuCondition }) {
  return (
    <Status
      value={
        value === "online"
          ? "Online"
          : value === "offline" || value === "absent"
            ? "Offline"
            : conditionLabels[value]
      }
    />
  );
}

export function formatDbm(value: number | null | undefined) {
  return value == null
    ? "—"
    : `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dBm`;
}
/** Potência óptica: abaixo do limiar do provedor fica em destaque, sem caixa colorida. */
export function Dbm({
  value,
  min,
  className,
}: {
  value: number | null | undefined;
  min: number | null;
  className?: string;
}) {
  const weak = value != null && min != null && value < min;
  return (
    <span
      className={cn(
        "mono tabular-nums whitespace-nowrap",
        weak && "font-semibold text-destructive",
        value == null && "text-muted-foreground",
        className,
      )}
      title={weak ? `Abaixo de ${min} dBm` : undefined}
    >
      {formatDbm(value)}
    </span>
  );
}

/** Barra de ocupação em preto sobre cinza: usada em portas de caixa e ONUs por PON. */
export function Meter({
  value,
  total,
  label,
}: {
  value: number;
  total: number;
  label?: ReactNode;
}) {
  const ratio = total > 0 ? Math.min(1, value / total) : 0;
  return (
    <div className="flex min-w-[110px] items-center gap-2">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
      >
        <div
          className="h-full rounded-full bg-foreground"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {label ?? `${value}/${total}`}
      </span>
    </div>
  );
}

/** Abas de página ligadas à URL: a aba escolhida sobrevive ao recarregar e pode ser compartilhada. */
export function PageTabs({
  value,
  tabs,
}: {
  value: string;
  tabs: { value: string; label: string; href: string; count?: number }[];
}) {
  const navigate = useNavigate();
  return (
    <Tabs
      className="view-tabs"
      value={value}
      onValueChange={(next) => {
        const tab = tabs.find((t) => t.value === next);
        if (tab) navigate(tab.href);
      }}
    >
      <TabsList variant="line">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
            {tab.count != null && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {tab.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** Indicador clicável do topo das páginas da área. */
export function Kpi({
  label,
  value,
  detail,
  href,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <div className="metric-heading">
        <span>{label}</span>
      </div>
      <div className="metric-main">
        <strong>{value}</strong>
      </div>
      {detail && <p>{detail}</p>}
    </>
  );
  return href ? (
    <Link className="metric-card" to={href}>
      {body}
    </Link>
  ) : (
    <div className="metric-card">{body}</div>
  );
}

export const oltHref = (deviceId: string, pon?: string | null) =>
  `/rede/olts/${deviceId}${pon ? `?pon=${encodeURIComponent(pon)}` : ""}`;
export const boxHref = (boxId: string) => `/rede/caixas/${boxId}`;
export const contractHref = (contractId: string) =>
  `/contratos?contrato=${contractId}`;

export function ago(value: string | null | undefined) {
  if (!value) return "—";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 90) return "agora";
  if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.round(seconds / 3600)} h`;
  return new Date(value).toLocaleDateString("pt-BR");
}
