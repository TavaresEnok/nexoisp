import useSWR from "swr";
import { useNavigate } from "react-router-dom";
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
import { FormField } from "@/features/shared/form";
import { QueryBoundary } from "@/features/shared/feedback";
import { useSession } from "@/features/session/provider";
import { can } from "@/features/session/model";
import { useQueryState } from "@/lib/use-query-state";
import { api } from "@/platform/erp-client";
import { searchSchema } from "./models";
export function OperationalSearch() {
  const { me } = useSession();
  const navigate = useNavigate();
  const [query, setQuery] = useQueryState("q", "");
  const result = useSWR(
    query.trim().length >= 2 ? ["erp-search", query.trim()] : null,
    async ([, q]) =>
      searchSchema.parse(await api(`/search?q=${encodeURIComponent(q)}`)),
  );
  const network = can(me, "network:read");
  const finance = can(me, "finance:read");
  return (
    <>
      <PageHeading
        title="Busca"
        description="Localize assinantes e contratos por cadastro, login, IP, MAC, ONU ou número de OS."
      />
      <Panel
        title="Busca unificada"
        description="Até cinquenta resultados por consulta. Refine o termo para encontrar outros registros."
      >
        <FormField label="Buscar no provedor">
          <Input
            value={query}
            maxLength={80}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Digite pelo menos dois caracteres"
          />
        </FormField>
        {query.trim().length < 2 ? (
          <p className="profile-footnote">
            Informe pelo menos dois caracteres para consultar.
          </p>
        ) : (
          <QueryBoundary
            loading={result.isLoading}
            error={result.error}
            retry={() => result.mutate()}
          >
            {result.data?.results.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Assinante</TableHead>
                    <TableHead>Contrato</TableHead>
                    {network && (
                      <>
                        <TableHead>Acesso</TableHead>
                        <TableHead>Rede</TableHead>
                      </>
                    )}
                    {finance && <TableHead>Financeiro</TableHead>}
                    <TableHead>Encontrado por</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.data.results.map((row) => (
                    <TableRow key={row.contract_id ?? row.subscriber_id}>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            navigate(`/assinantes?ficha=${row.subscriber_id}`)
                          }
                        >
                          {row.subscriber_name}
                        </Button>
                        <small className="table-subline">
                          {row.document || "Documento não informado"}
                        </small>
                      </TableCell>
                      <TableCell>
                        {row.contract_id ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                navigate(
                                  `/contratos?contrato=${row.contract_id}`,
                                )
                              }
                            >
                              {row.plan_name || "Abrir contrato"}
                            </Button>
                            {row.contract_status === "ended" && (
                              <Badge variant="outline">Encerrado</Badge>
                            )}
                          </>
                        ) : (
                          <span>Sem contrato</span>
                        )}
                      </TableCell>
                      {network && (
                        <>
                          <TableCell>
                            {row.pppoe_username || "Não provisionado"}
                            {row.desired_policy === "suspended" && (
                              <Badge variant="warning">Suspenso</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {row.online == null
                              ? "Não observada"
                              : row.online
                                ? "Online"
                                : "Offline"}
                            <small className="table-subline">
                              {row.ip || "IP não informado"}
                            </small>
                          </TableCell>
                        </>
                      )}
                      {finance && (
                        <TableCell>
                          {row.overdue == null ? (
                            "Não informado"
                          ) : row.overdue > 0 ? (
                            <Badge variant="warning">
                              {row.overdue} vencida(s)
                            </Badge>
                          ) : (
                            "Sem fatura vencida"
                          )}
                        </TableCell>
                      )}
                      <TableCell>
                        {[...new Set(row.matched)].join(", ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="profile-footnote">Nenhum resultado encontrado.</p>
            )}
          </QueryBoundary>
        )}
      </Panel>
    </>
  );
}
