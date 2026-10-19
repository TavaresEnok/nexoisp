import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  NetworkOnlineView,
  type OnlineIdentity,
} from "@/components/network-online";
import { Button } from "@/components/ui/button";
import { QueryBoundary } from "@/features/shared/feedback";
import { RecordEditor } from "@/features/shared/record-editor";
import { ActionButton } from "@/features/shared/action";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { useQueryState } from "@/lib/use-query-state";
import { api, download } from "@/platform/erp-client";
import { stamp } from "./models";
export const onlineSchema = z.object({
  total: z.number(),
  rows: z.array(
    z.object({
      resource_id: z.string().uuid(),
      contract_id: z.string().uuid(),
      subscriber_name: z.string(),
      login: z.string(),
      ip: z.string().nullable(),
      mac: z.string().nullable(),
      uptime: z.string().nullable(),
      nas: z.string(),
      pop: z.string().nullable(),
      desired_policy: z.string(),
      observed_at: z.string().nullable(),
    }),
  ),
});
const bulkSchema = z.object({
  requested: z.number(),
  refused: z.number(),
  results: z.array(
    z
      .object({
        resource_id: z.string(),
        ok: z.boolean(),
        error: z.string().optional(),
      })
      .passthrough(),
  ),
});
export function OnlineConnections() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [search, setSearch] = useQueryState("busca", "", undefined, {
    resetPage: true,
  });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [disconnect, setDisconnect] = useState<string[] | null>(null);
  const [report, setReport] = useState<z.infer<typeof bulkSchema> | null>(null);
  const path = `/network/online?q=${encodeURIComponent(search)}`;
  const result = useSWR(
    ["erp-online", search],
    async () => onlineSchema.parse(await api(path)),
    { refreshInterval: 15000 },
  );
  const data = result.data;
  const rows: OnlineIdentity[] = (data?.rows ?? []).map((row) => ({
    id: row.resource_id,
    name: row.subscriber_name,
    contract: row.contract_id,
    pop: row.pop || "POP não informado",
    nas: row.nas,
    plan: "Não informado",
    access: {
      login: row.login,
      ip: row.ip ?? undefined,
      mac: row.mac ?? undefined,
      uptime: row.uptime ?? undefined,
    },
  }));
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / 8) - 1));
  const visible = rows.slice(current * 8, (current + 1) * 8);
  const operate = can(me, "network:operate");
  const toggle = (id: string, value: boolean) =>
    setSelected((previous) =>
      value
        ? previous.includes(id)
          ? previous
          : [...previous, id].slice(0, 200)
        : previous.filter((item) => item !== id),
    );
  const open = (id: string) => {
    const row = rows.find((row) => row.id === id);
    if (row) navigate(`/contratos?contrato=${row.contract}`);
  };
  const metrics = [
    {
      label: "Clientes conectados",
      value: String(data?.total ?? 0),
      note: "Acessos retornados nesta consulta",
      online: true,
    },
    {
      label: "POPs com clientes online",
      value: String(
        new Set(data?.rows.map((row) => row.pop).filter(Boolean)).size,
      ),
      note: "POPs informados nesta consulta",
    },
    {
      label: "Concentradores NAS",
      value: String(new Set(data?.rows.map((row) => row.nas)).size),
      note: "Concentradores nesta consulta",
    },
    {
      label: "Dual-Stack IPv6",
      value: "—",
      note: "Sem informação de IPv6 nesta consulta",
    },
  ];
  return (
    <>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {data && (
          <NetworkOnlineView
            rows={rows}
            visible={visible}
            metrics={metrics}
            connectedCount={data.total}
            search={search}
            searchPlaceholder="Filtrar por cliente, IP ou login…"
            setSearch={(value) => {
              setSearch(value);
              setPage(0);
              setSelected([]);
              setReport(null);
            }}
            clear={() => {
              setSearch("");
              setPage(0);
              setSelected([]);
            }}
            current={current}
            pages={Math.max(1, Math.ceil(rows.length / 8))}
            onPage={setPage}
            onExport={() =>
              void download(`${path}&format=csv`, "usuarios-online.csv").catch(
                (error) => toast.error(error.message),
              )
            }
            openSubscriber={open}
            source={`Última observação na consulta · ${stamp(
              data.rows
                .map((row) => row.observed_at)
                .filter((value): value is string => Boolean(value))
                .sort()
                .at(-1) ?? null,
            )}`}
            sourceNote="Atualização a cada 15 segundos. Até 5.000 acessos; tráfego, plano e IPv6 não são retornados por esta consulta."
            actions={
              <div className="erp-inline-actions">
                <ActionButton
                  onClick={async () => {
                    await result.mutate();
                  }}
                >
                  Atualizar conexões
                </ActionButton>
                {operate && (
                  <Button
                    size="sm"
                    disabled={!selected.length}
                    onClick={() => setDisconnect(selected)}
                  >
                    Desconectar selecionados ({selected.length}/200)
                  </Button>
                )}
              </div>
            }
            selectionHeader={
              operate ? (
                <input
                  type="checkbox"
                  aria-label="Selecionar acessos desta página"
                  checked={
                    visible.length > 0 &&
                    visible.every((row) => selected.includes(row.id))
                  }
                  onChange={(event) =>
                    visible.forEach((row) =>
                      toggle(row.id, event.target.checked),
                    )
                  }
                />
              ) : undefined
            }
            selectionCell={
              operate
                ? (row) => (
                    <input
                      type="checkbox"
                      aria-label={`Selecionar acesso de ${row.name}`}
                      checked={selected.includes(row.id)}
                      onChange={(event) => toggle(row.id, event.target.checked)}
                    />
                  )
                : undefined
            }
            rowAction={(row) => (
              <div className="erp-inline-actions">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => open(row.id)}
                >
                  Contrato
                </Button>
                {operate && (
                  <Button
                    variant="outline"
                    size="xs"
                    aria-label={`Desconectar ${row.name}`}
                    onClick={() => setDisconnect([row.id])}
                  >
                    Desconectar
                  </Button>
                )}
              </div>
            )}
            filterBar={
              <>
                {data.total >= 5000 && (
                  <p role="status" className="profile-footnote">
                    Limite de 5.000 acessos atingido. Refine a busca para
                    consultar outros registros.
                  </p>
                )}
                {selected.length > 0 && (
                  <p className="profile-footnote">
                    {selected.length} acesso(s) selecionado(s), inclusive em
                    outras páginas desta consulta.
                  </p>
                )}
                {report && (
                  <div role="status">
                    <p>
                      {report.requested} desconexão(ões) solicitada(s) ·{" "}
                      {report.refused} recusada(s).
                      {report.requested > 0
                        ? " As solicitações aceitas aguardam a execução na rede."
                        : " Nenhuma desconexão foi solicitada."}
                    </p>
                    {report.results
                      .filter((item) => !item.ok)
                      .map((item) => (
                        <p key={item.resource_id}>
                          {rows.find((row) => row.id === item.resource_id)
                            ?.name ?? item.resource_id}
                          : {item.error || "Recusada"}
                        </p>
                      ))}
                  </div>
                )}
              </>
            }
          />
        )}
      </QueryBoundary>
      {disconnect && (
        <RecordEditor
          title="Desconectar acessos"
          description={`${disconnect.length} acesso(s). Os assinantes poderão reconectar em seguida. Informe o motivo para a auditoria.`}
          initial={{ reason: "" }}
          fields={[
            {
              key: "reason",
              label: "Motivo da desconexão",
              required: true,
              maxLength: 200,
            },
          ]}
          submit="Solicitar desconexão"
          onClose={() => setDisconnect(null)}
          onSubmit={async (values) => {
            if (values.reason.trim().length < 5)
              throw new Error(
                "Informe um motivo com pelo menos cinco caracteres.",
              );
            const response = bulkSchema.parse(
              await api("/network/disconnect", {
                body: {
                  resource_ids: disconnect,
                  reason: values.reason.trim(),
                },
              }),
            );
            setReport(response);
            setSelected((previous) =>
              previous.filter(
                (id) =>
                  !response.results.some(
                    (item) => item.ok && item.resource_id === id,
                  ),
              ),
            );
            setDisconnect(null);
            await result.mutate();
          }}
        />
      )}
    </>
  );
}
