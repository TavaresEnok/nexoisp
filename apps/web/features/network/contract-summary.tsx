// Resumo técnico no topo da aba Acesso do contrato: conexão, sinal, OLT/PON e caixa numa linha.
import useSWR from "swr";
import { z } from "zod";
import { Link } from "react-router-dom";
import { Status } from "@/components/workspace-ui";
import { useSession } from "@/features/session/provider";
import { hasModule } from "@/features/session/model";
import { api } from "@/platform/erp-client";
import {
  boxHref,
  conditionLabels,
  Dbm,
  oltHref,
  onuCondition,
  useNoc,
  useOnus,
  useSessions,
} from "./kit";

const ftthSchema = z.object({
  drop: z
    .object({ box_id: z.string(), box_name: z.string(), port: z.number() })
    .passthrough()
    .nullable(),
});

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export function ContractNetworkSummary({ id }: { id: string }) {
  const { me } = useSession();
  const olt = hasModule(me, "olt");
  const ftth = hasModule(me, "ftth");
  const sessions = useSessions();
  const onus = useOnus(olt);
  const noc = useNoc(hasModule(me, "noc"));
  const fiber = useSWR(ftth ? ["erp-contract-ftth", id] : null, async () =>
    ftthSchema.parse(await api(`/contracts/${id}/ftth`)),
  );
  const session = sessions.data?.find((s) => s.contract_id === id);
  const onu = onus.data?.find(
    (n) => n.contract_id === id && n.desired_state === "authorized",
  );
  const rxMin = noc.data?.settings.onu_rx_min_dbm ?? null;
  const drop = fiber.data?.drop;
  if (!sessions.data) return null;
  return (
    <dl className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4">
      <Cell label="Conexão">
        <span className="flex flex-wrap items-center gap-2">
          <Status value={session ? "Online" : "Offline"} />
          {session && (
            <span className="mono text-xs text-muted-foreground">
              {session.ip} · {session.uptime}
            </span>
          )}
        </span>
      </Cell>
      {olt && (
        <Cell label="Sinal da ONU">
          {onu ? (
            <Link
              to={`/rede/onus?onu=${onu.id}`}
              className="flex flex-wrap items-center gap-2 hover:underline"
            >
              <Dbm value={onu.observed_rx_dbm} min={rxMin} />
              <span className="text-xs text-muted-foreground">
                {conditionLabels[onuCondition(onu, rxMin)]}
              </span>
            </Link>
          ) : (
            <span className="text-muted-foreground">Sem ONU</span>
          )}
        </Cell>
      )}
      {olt && (
        <Cell label="OLT · PON">
          {onu ? (
            <Link
              className="hover:underline"
              to={oltHref(onu.device_id, onu.pon_port)}
            >
              {onu.device_name} · {onu.pon_port}
            </Link>
          ) : session?.nas ? (
            <span>{session.nas}</span>
          ) : (
            "—"
          )}
        </Cell>
      )}
      {ftth && (
        <Cell label="Caixa · porta">
          {drop ? (
            <Link className="hover:underline" to={boxHref(drop.box_id)}>
              {drop.box_name} · {drop.port}
            </Link>
          ) : (
            <span className="text-muted-foreground">Não registrada</span>
          )}
        </Cell>
      )}
    </dl>
  );
}
