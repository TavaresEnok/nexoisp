import { useState } from "react";
import useSWR from "swr";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ProfileSection,
  ProfileFacts,
} from "@/components/subscriber-profile-sections";
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
      <p className="profile-footnote">
        Cada registro representa uma geração, inclusive quando o identificador
        externo se repete. Sem encerramento registrado não comprova conexão
        ativa. O CSV consulta a página novamente e pode refletir pacotes
        recebidos após a exibição; percorra as páginas para consultar o
        restante. O histórico está sujeito à retenção configurada e não
        substitui arquivo regulatório.
      </p>
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
        {result.data?.items.map((item) => (
          <div key={item.id} className="border-t py-4">
            <ProfileFacts
              items={[
                ["Geração / sessão", `${item.id} · ${item.session_id}`],
                ["Usuário", item.username],
                [
                  "NAS",
                  `${item.nas_device_id ?? "Identidade não comprovada"} · ${item.nas_ip ?? "Origem não registrada"}`,
                ],
                ["Início", stamp(item.started_at)],
                ["Último pacote recebido", stamp(item.seen_at)],
                [
                  "Encerramento",
                  item.stopped_at
                    ? stamp(item.stopped_at)
                    : "Sem encerramento registrado",
                ],
                ["Duração informada (segundos)", item.session_seconds],
                ["Enviado pelo assinante (bytes)", item.bytes_in],
                ["Recebido pelo assinante (bytes)", item.bytes_out],
                ["IPv4", item.framed_ip ?? "Não informado"],
                ["Endereço IPv6", item.ipv6_address ?? "Não informado"],
                ["Prefixo IPv6", item.ipv6_prefix ?? "Não informado"],
                [
                  "Prefixo delegado IPv6",
                  item.delegated_ipv6_prefix ?? "Não informado",
                ],
                [
                  "Causa de encerramento",
                  item.terminate_cause ?? "Não informada",
                ],
              ]}
            />
          </div>
        ))}
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
