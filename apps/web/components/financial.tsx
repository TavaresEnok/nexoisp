"use client";

import { useState } from "react";
import { useSearchParams } from "@/platform/navigation/react";
import { useQueryState } from "@/lib/use-query-state";
import {
  Search,
  Download,
  ArrowUpRight,
  CircleDollarSign,
  ArrowDownLeft,
  Clock3,
  TriangleAlert,
  FileText,
  ShieldCheck,
  Info,
  ArrowRight,
  CheckCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useWorkspace } from "@/components/workspace-provider";
import {
  Panel,
  PageHeading,
  Trend,
  SourceFooter,
  Status,
  PersonAvatar,
  DemoNotice,
} from "@/components/workspace-ui";
import { RevenueChart } from "@/components/revenue-chart";
import { money, date, scenarioDate, exportCsv } from "@/lib/format";
import { revenueTrend } from "@/lib/overview";
import type { Invoice } from "@/lib/types";
import { selectInvoices } from "@/application/selectors/financial";
import { EmptyState, ContextCallout } from "@/components/workspace-feedback";

export function Financial() {
  const { data, openSubscriber } = useWorkspace();
  const { snapshot: s } = data;
  const params = useSearchParams();
  const initialFilter = params.get("filtro");
  const [status, setStatus] = useQueryState("situacao", initialFilter === "vencidas" ? "Vencida" : initialFilter === "conciliacao" ? "Em conciliação" : "Todas", ["Todas", ...data.invoices.map(i => i.status)]);
  const [query, setQuery] = useQueryState("busca", "");
  const [selected, setSelected] = useState<Invoice | null>(null);
  const { rows: filtered, total } = selectInvoices(data.invoices, status, query);
  const exportRows = () =>
    exportCsv(
      "nexo-faturas-demonstrativas",
      [
        "Fatura",
        "Assinante fictício",
        "Competência",
        "Vencimento",
        "Valor",
        "Status",
        "Método",
      ],
      filtered.map((i) => [
        i.code,
        i.name,
        i.reference,
        i.due,
        i.amount,
        i.status,
        i.method,
      ]),
    );
  const receivedTrend = revenueTrend(s.series);
  return (
    <>
      <PageHeading
        title="Faturas"
        description="Do recebimento à conciliação, sem perder de vista quem está do outro lado."
        actions={
          <Button variant="outline" onClick={exportRows}>
            <Download data-icon="inline-start" />
            Exportar faturas
          </Button>
        }
      />
      <div className="metrics-grid financial-metrics">
        {[
          {
            title: "Faturamento da competência",
            value: money(s.billed),
            icon: CircleDollarSign,
            detail: "Contratos do cenário · out. 2026",
            trend: "",
          },
          {
            title: "Recebido no mês",
            value: money(s.received),
            icon: ArrowDownLeft,
            detail: `Movimentações até ${scenarioDate(s.asOf)}${receivedTrend ? " · vs. mês anterior" : ""}`,
            trend: receivedTrend?.label ?? "",
            down: receivedTrend?.down,
          },
          {
            title: "A receber",
            value: money(s.billed - s.received - s.overdue),
            icon: Clock3,
            detail: `${s.openInvoices} faturas em aberto no cenário`,
            trend: "",
          },
          {
            title: "Vencido e não pago",
            value: money(s.overdue),
            icon: TriangleAlert,
            detail: "Não inclui pagamentos em conciliação",
            trend: "",
          },
        ].map((m) => (
          <div className="metric-card" key={m.title}>
            <div className="metric-heading">
              <span>{m.title}</span>
              <m.icon size={17} />
            </div>
            <div className="metric-main">
              <strong>{m.value.replace(",00", "")}</strong>
              {m.trend && <Trend down={"down" in m && !!m.down}>{m.trend}</Trend>}
            </div>
            <p>{m.detail}</p>
          </div>
        ))}
      </div>
      <div className="financial-top-grid">
        <Panel
          title="Recebimentos em perspectiva"
          description={`Acumulado em R$ mil · até ${scenarioDate(s.asOf)}`}
          action={<Badge variant="outline">Outubro de 2026</Badge>}
        >
          <RevenueChart data={s.series} />
        </Panel>
        <Panel
          title="Uma baixa com confiança"
          description="Conciliação antes da confirmação"
          className="reconciliation-summary"
        >
          <span className="reconciliation-icon">
            <CheckCheck size={30} />
          </span>
          <strong>{s.reconciliation.toString().padStart(2, "0")}</strong>
          <p>pagamentos aguardam análise no cenário operacional</p>
          <small>Os detalhes abaixo mostram a amostra de faturas.</small>
          <Button variant="outline" onClick={() => setStatus("Em conciliação")}>
            Revisar correspondências
            <ArrowRight data-icon="inline-end" />
          </Button>
        </Panel>
      </div>
      <Panel
        title="Cada fatura, no seu lugar"
        description="Registros vinculados à amostra demonstrativa de assinantes"
        action={<Badge variant="secondary">{money(total)} na seleção</Badge>}
        className="list-panel"
      >
        <div className="list-toolbar">
          <Tabs value={status} onValueChange={(v) => setStatus(String(v))}>
            <TabsList>
              {["Todas", "Em aberto", "Vencida", "Em conciliação", "Paga"].map(
                (v) => (
                  <TabsTrigger key={v} value={v}>
                    {v === "Vencida" ? "Vencidas" : v === "Paga" ? "Pagas" : v}
                  </TabsTrigger>
                ),
              )}
            </TabsList>
          </Tabs>
          <div className="search-field">
            <Search size={15} />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Assinante ou fatura…"
              aria-label="Buscar faturas"
            />
          </div>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fatura</TableHead>
              <TableHead>Assinante</TableHead>
              <TableHead>Vencimento</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pagamento</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead>
                <span className="sr-only">Ver detalhes</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((i) => (
              <TableRow key={i.id}>
                <TableCell>
                  <button
                    className="code-link mono"
                    onClick={() => setSelected(i)}
                  >
                    {i.code}
                  </button>
                  <small className="table-subline">Out. 2026</small>
                </TableCell>
                <TableCell>
                  <button
                    className="table-person"
                    onClick={() => openSubscriber(i.subscriberId)}
                  >
                    <PersonAvatar name={i.name} small />
                    <span>
                      <strong>{i.name}</strong>
                      <small>Ver ficha do assinante</small>
                    </span>
                  </button>
                </TableCell>
                <TableCell className="subtle">
                  {date(i.due).replace(" de 2026", "")}
                </TableCell>
                <TableCell>
                  <Status value={i.status} />
                </TableCell>
                <TableCell className="subtle">{i.method}</TableCell>
                <TableCell className="text-right mono">
                  {money(i.amount)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setSelected(i)}
                    aria-label={`Ver fatura ${i.code}`}
                  >
                    <ArrowUpRight />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {filtered.length === 0 && (
          <EmptyState
            icon={FileText}
            title="Nenhuma fatura nesta seleção."
            description="Tente outro filtro ou procure um assinante."
          >
            <Button
              variant="outline"
              onClick={() => {
                setStatus("Todas");
                setQuery("");
              }}
            >
              Limpar filtros
            </Button>
          </EmptyState>
        )}
        <div className="table-total">
          <span>{filtered.length} faturas da amostra</span>
          <span>
            Total selecionado <strong className="mono">{money(total)}</strong>
          </span>
        </div>
      </Panel>
      <DemoNotice>
        Totais superiores: cenário operacional. Tabela e exportação: amostra de
        24 faturas fictícias. Nenhuma transação bancária é executada.
      </DemoNotice>
      <SourceFooter sample="Financeiro demonstrativo" />
      <Dialog
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className="invoice-dialog">
          <DialogHeader>
            <div className="eyebrow">DETALHES DA FATURA</div>
            <DialogTitle>{selected?.code}</DialogTitle>
            <DialogDescription>
              Documento demonstrativo. Não é uma cobrança válida.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <div className="invoice-amount">
                <strong>{money(selected.amount)}</strong>
                <Status value={selected.status} />
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>Assinante</dt>
                  <dd>{selected.name}</dd>
                </div>
                <div>
                  <dt>Competência</dt>
                  <dd>{selected.reference}</dd>
                </div>
                <div>
                  <dt>Vencimento</dt>
                  <dd>{date(selected.due)}</dd>
                </div>
                <div>
                  <dt>Método</dt>
                  <dd>{selected.method}</dd>
                </div>
              </dl>
              {selected.status === "Em conciliação" && (
                <ContextCallout
                  icon={ShieldCheck}
                  title="Correspondência não é confirmação."
                >
                  <p>
                    Revise titular, valor e referência no extrato antes de dar
                    baixa. O cenário não possui integração bancária.
                  </p>
                </ContextCallout>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  const id = selected.subscriberId;
                  setSelected(null);
                  openSubscriber(id);
                }}
              >
                Ver contexto do assinante
                <ArrowUpRight data-icon="inline-end" />
              </Button>
              <p className="demo-notice">
                <Info size={13} />
                Somente leitura · sem emissão, cobrança ou baixa real
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
