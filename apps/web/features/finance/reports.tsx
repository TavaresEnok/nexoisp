import { AgingFilters, type AgingFilterValues } from "./aging-filters";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import useSWR from "swr";
import { Link } from "react-router-dom";
import { PageHeading, Panel } from "@/components/workspace-ui";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import { FormField } from "@/features/shared/form";
import { useQueryState } from "@/lib/use-query-state";
import { ActionButton } from "@/features/shared/action";
import { QueryBoundary } from "@/features/shared/feedback";
import { api, download } from "@/platform/erp-client";
import { money } from "@/lib/format";
type Bucket = { faixa: string; faturas: number; cents: number };
type Group = { grupo: string; pagamentos: number; cents: number };
type ContractRow = {
  contract_id: string;
  subscriber_name: string;
  plan_name: string;
  price_cents: number;
  due_day: number;
  faturas: number;
  cents: number;
  dias_atraso: number;
};
type Report = {
  rows: (Bucket | ContractRow)[];
  total: { faturas: number; cents: number };
  total_cents: number;
  by_plan: Group[];
  by_method: Group[];
};
export function CollectionReports() {
  const [tab, setTab] = useQueryState("aba", "aging", [
    "aging",
    "receipts",
    "without",
    "cancel",
  ]);
  const [from, setFrom] = useState(
    new Date(Date.now() - 30 * 86400000).toLocaleDateString("en-CA"),
  );
  const [to, setTo] = useState(new Date().toLocaleDateString("en-CA"));
  const [days, setDays] = useState("90");
  const [aging, setAging] = useState<AgingFilterValues>({
    plan_id: "",
    pop_id: "",
    tag: "",
  });
  const agingQuery = new URLSearchParams(
    Object.entries(aging).filter(([, value]) => value),
  );
  const path =
    tab === "aging"
      ? `/finance/reports/aging?${agingQuery}`
      : tab === "receipts"
        ? `/finance/reports/receipts?${new URLSearchParams({ from, to })}`
        : tab === "without"
          ? "/finance/reports/without-invoice"
          : `/finance/reports/to-cancel?days=${encodeURIComponent(days)}`;
  const result = useSWR(["erp-finance-report", path], ([, path]) =>
    api<Report>(path),
  );
  return (
    <>
      <PageHeading
        title="Relatórios de cobrança"
        description="Carteira, recebimentos e pendências calculados pelo servidor."
        actions={
          <>
            <Button
              variant="outline"
              render={<Link to="/relatorios/indicacoes" />}
            >
              Indicações
            </Button>
            <ActionButton
              onClick={() =>
                download(
                  `${path}${path.includes("?") ? "&" : "?"}format=csv`,
                  `${tab}.csv`,
                )
              }
            >
              Exportar relatório CSV
            </ActionButton>
          </>
        }
      />
      <Panel title="Acompanhamento da carteira" className="list-panel">
        <div className="commercial-toolbar">
          <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
            <TabsList variant="line" aria-label="Relatórios de cobrança">
              {Object.entries({
                aging: "Carteira por atraso",
                receipts: "Recebido",
                without: "Contratos sem fatura",
                cancel: "Candidatos a cancelar",
              }).map(([value, label]) => (
                <TabsTrigger key={value} value={value}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="commercial-detail-body">
          {tab === "aging" && (
            <AgingFilters values={aging} onChange={setAging} />
          )}
          {tab === "receipts" && (
            <div className="erp-columns">
              <FormField label="Recebimentos desde">
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </FormField>
              <FormField label="Recebimentos até">
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </FormField>
            </div>
          )}
          {tab === "cancel" && (
            <>
              <FormField label="Atraso superior a (dias)">
                <Input
                  type="number"
                  min={1}
                  max={730}
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </FormField>
              <p className="profile-footnote">
                Lista de candidatos; nenhuma ação de cancelamento é executada
                pelo relatório.
              </p>
            </>
          )}
          <QueryBoundary
            loading={result.isLoading}
            error={result.error}
            retry={() => result.mutate()}
          >
            {result.data &&
              (tab === "aging" ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Faixa</TableHead>
                      <TableHead>Faturas</TableHead>
                      <TableHead>Valor em aberto</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(result.data.rows as Bucket[]).map((row) => (
                      <TableRow key={row.faixa}>
                        <TableCell>{row.faixa}</TableCell>
                        <TableCell>{row.faturas}</TableCell>
                        <TableCell>{money(row.cents / 100)}</TableCell>
                      </TableRow>
                    ))}
                    <TableRow>
                      <TableCell>Total</TableCell>
                      <TableCell>{result.data.total.faturas}</TableCell>
                      <TableCell>
                        {money(result.data.total.cents / 100)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              ) : tab === "receipts" ? (
                <>
                  <p>
                    Total recebido, líquido de estornos:{" "}
                    <strong>{money(result.data.total_cents / 100)}</strong>
                  </p>
                  <div className="profile-two-columns">
                    <ReceiptGroups
                      title="Por plano"
                      rows={result.data.by_plan}
                    />
                    <ReceiptGroups
                      title="Por forma de pagamento"
                      rows={result.data.by_method}
                    />
                  </div>
                </>
              ) : (
                <>
                  {tab === "without" && (
                    <p className="profile-footnote">
                      Contratos vigentes sem fatura não cancelada com vencimento
                      no mês corrente.
                    </p>
                  )}
                  {result.data.rows.length ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Assinante</TableHead>
                          <TableHead>Plano</TableHead>
                          {tab === "without" ? (
                            <>
                              <TableHead>Mensalidade</TableHead>
                              <TableHead>Dia de vencimento</TableHead>
                            </>
                          ) : (
                            <>
                              <TableHead>Faturas</TableHead>
                              <TableHead>Valor</TableHead>
                              <TableHead>Dias em atraso</TableHead>
                            </>
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(result.data.rows as ContractRow[]).map((row) => (
                          <TableRow key={row.contract_id}>
                            <TableCell>
                              <Link
                                className="profile-text-action"
                                to={`/contratos/${row.contract_id}`}
                              >
                                {row.subscriber_name}
                              </Link>
                            </TableCell>
                            <TableCell>{row.plan_name}</TableCell>
                            {tab === "without" ? (
                              <>
                                <TableCell>
                                  {money(row.price_cents / 100)}
                                </TableCell>
                                <TableCell>{row.due_day}</TableCell>
                              </>
                            ) : (
                              <>
                                <TableCell>{row.faturas}</TableCell>
                                <TableCell>{money(row.cents / 100)}</TableCell>
                                <TableCell>{row.dias_atraso}</TableCell>
                              </>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <p className="profile-footnote">
                      Nenhum contrato nesta seleção.
                    </p>
                  )}
                </>
              ))}
          </QueryBoundary>
        </div>
      </Panel>
    </>
  );
}
function ReceiptGroups({ title, rows }: { title: string; rows: Group[] }) {
  return (
    <Panel title={title}>
      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Grupo</TableHead>
              <TableHead>Pagamentos</TableHead>
              <TableHead>Recebido</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.grupo}>
                <TableCell>{row.grupo}</TableCell>
                <TableCell>{row.pagamentos}</TableCell>
                <TableCell>{money(row.cents / 100)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="profile-footnote">Sem recebimentos neste período.</p>
      )}
    </Panel>
  );
}
