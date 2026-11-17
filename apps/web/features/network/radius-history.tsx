import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { ProfileSection } from "@/components/subscriber-profile-sections";
import { QueryBoundary } from "@/features/shared/feedback";
import { api, download } from "@/platform/erp-client";
import { stamp } from "./models";

const decimal = z.string().regex(/^\d+$/);
const sessionSchema = z.object({
  id: decimal,
  nas_device_id: z.string().nullable(),
  nas_ip: z.string().nullable(),
  username: z.string(),
  session_id: z.string(),
  started_at: z.string(),
  stopped_at: z.string().nullable(),
  seen_at: z.string(),
  state: z.enum(["open", "closed"]),
  session_seconds: decimal,
  bytes_in: decimal,
  bytes_out: decimal,
  framed_ip: z.string().nullable(),
  ipv6_address: z.string().nullable(),
  ipv6_prefix: z.string().nullable(),
  delegated_ipv6_prefix: z.string().nullable(),
  terminate_cause: z.string().nullable(),
  nas_port: z.string().nullable().optional(),
  called_station: z.string().nullable().optional(),
  port_interface: z.string().nullable().optional(),
  port_vlan: z.number().nullable().optional(),
  port_inner_vlan: z.number().nullable().optional(),
});
const historySchema = z.object({
  items: z.array(sessionSchema),
  next_before: decimal.nullable(),
  live_connection_proof: z.literal(false),
});
export function RadiusAccountingHistory() {
  const [username, setUsername] = useState("");
  const [nas, setNas] = useState("");
  const [state, setState] = useState("");
  const [filter, setFilter] = useState("");
  const [before, setBefore] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const query = new URLSearchParams(filter);
  if (before) query.set("before", before);
  const path = `/radius/accounting/sessions?${query.toString()}`;
  const result = useSWR(["erp-radius-history", path], async () =>
    historySchema.parse(await api(path)),
  );
  return (
    <ProfileSection
      title="Histórico de sessões RADIUS"
      caption="Gerações de accounting registradas; até 100 registros por página."
    >
      <form
        className="erp-inline-actions"
        onSubmit={(event) => {
          event.preventDefault();
          const q = new URLSearchParams();
          if (username) q.set("username", username);
          if (nas.trim()) q.set("nas", nas.trim());
          if (state) q.set("state", state);
          setBefore(null);
          setFilter(q.toString());
        }}
      >
        <Input
          aria-label="Usuário RADIUS exato"
          placeholder="Usuário RADIUS exato"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          maxLength={253}
        />
        <Input
          aria-label="Identificador do NAS"
          placeholder="UUID do NAS (opcional)"
          value={nas}
          onChange={(e) => setNas(e.target.value)}
        />
        <select
          className="commercial-select"
          aria-label="Situação no accounting"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="">Todas as situações</option>
          <option value="open">Sem encerramento registrado</option>
          <option value="closed">Encerradas</option>
        </select>
        <Button type="submit" variant="outline">
          Consultar histórico
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void result.mutate();
          }}
        >
          Atualizar histórico
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!result.data || !!result.error || exporting}
          onClick={async () => {
            setExporting(true);
            try {
              await download(
                `${path}&format=csv`,
                "radius-accounting-page.csv",
              );
            } catch (error) {
              toast.error(
                error instanceof Error
                  ? error.message
                  : "Falha ao exportar histórico",
              );
            } finally {
              setExporting(false);
            }
          }}
        >
          Exportar esta página CSV
        </Button>
      </form>
      <QueryBoundary
        loading={result.isLoading}
        error={result.error}
        retry={() => result.mutate()}
      >
        {result.data?.items.length === 0 && (
          <p className="profile-footnote">
            Nenhuma sessão para os filtros informados.
          </p>
        )}
        {!!result.data?.items.length && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {[
                    "Usuário",
                    "IP",
                    "Início",
                    "Último pacote",
                    "Fim",
                    "Duração",
                    "Baixou / enviou",
                    "Causa",
                  ].map((label) => (
                    <TableHead key={label}>{label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.items.map((item) => (
                  <TableRow
                    key={item.id}
                    title={`Sessão ${item.session_id} · NAS ${item.nas_ip ?? "não registrado"}`}
                  >
                    <TableCell className="mono">{item.username}</TableCell>
                    <TableCell className="mono">
                      {item.framed_ip ?? "—"}
                    </TableCell>
                    <TableCell>{stamp(item.started_at)}</TableCell>
                    <TableCell>{stamp(item.seen_at)}</TableCell>
                    <TableCell>
                      {item.stopped_at ? stamp(item.stopped_at) : "Aberta"}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {duration(item.session_seconds)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {bytes(item.bytes_out)} / {bytes(item.bytes_in)}
                    </TableCell>
                    <TableCell>{item.terminate_cause ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </QueryBoundary>
      {result.data?.next_before && !result.error && (
        <Button
          variant="outline"
          onClick={() => setBefore(result.data!.next_before)}
        >
          Sessões mais antigas
        </Button>
      )}
      {before && (
        <Button variant="outline" onClick={() => setBefore(null)}>
          Voltar às sessões recentes
        </Button>
      )}
    </ProfileSection>
  );
}

function duration(value: unknown) {
  const total = Number(value);
  if (!Number.isFinite(total) || total <= 0) return "—";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`;
}
function bytes(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(n) / Math.log(1024)),
  );
  return `${(n / 1024 ** i).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} ${units[i]}`;
}
