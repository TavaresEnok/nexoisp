"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { useQueryState } from "@/lib/use-query-state";
import { selectSubscribers } from "@/application/selectors/subscribers";
import {
  Search,
  Download,
  ArrowUpDown,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Users,
  SlidersHorizontal,
  Signal,
  Wifi,
  CreditCard,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useWorkspace } from "@/features/workspace/context";
import {
  Panel,
  PageHeading,
  Status,
  PersonAvatar,
  SourceFooter,
  DemoNotice,
  ActiveFilters,
} from "@/components/workspace-ui";
import { exportCsv, money } from "@/lib/format";
import { EmptyState } from "@/components/workspace-feedback";

export type SubscriberListRow = {
  id: string;
  code: string;
  name: string;
  contact: string;
  plan: string;
  status: string;
  connection: string;
  locality: string;
  monthly: number | null;
};
export type SubscriberSummaryItem = { icon: LucideIcon; value: ReactNode; label: string; warning?: boolean };
export type SubscriberDirectoryViewProps = {
  description: string;
  actions: ReactNode;
  before?: ReactNode;
  summary: SubscriberSummaryItem[];
  panelDescription: string;
  badge: ReactNode;
  tabs: { value: string; label: string; count?: number }[];
  status: string;
  onStatus: (value: string) => void;
  query: string;
  onQuery: (value: string) => void;
  searchPlaceholder: string;
  connection?: { value: string; options: string[]; onChange: (value: string) => void };
  filters: { label: string; onRemove: () => void }[];
  filteredCount: number;
  onClearFilters: () => void;
  sortAsc: boolean;
  onToggleSort: () => void;
  columns: { connection: string; connectionStatus?: boolean; monthly: string };
  rows: SubscriberListRow[];
  onOpen: (id: string) => void;
  empty: { title: string; description: string };
  pagination: { start: number; end: number; total: number; page: number; pages: number; onPage: (page: number) => void; pageSize?: { value: number; options: number[]; onChange: (value: number) => void } };
  boundary?: (content: ReactNode) => ReactNode;
  footer?: ReactNode;
};

export function Subscribers() {
  const { data, openSubscriber } = useWorkspace();
  const [query, setQuery] = useQueryState("busca", "");
  const [status, setStatus] = useQueryState("situacao", "Todos", ["Todos", ...data.subscribers.map(s => s.status)]);
  const [connection, setConnection] = useQueryState("conexao", "Todas", ["Todas", ...data.subscribers.map(s => s.connection)]);
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => selectSubscribers(data.subscribers, { status, connection, query, sortAsc }), [data.subscribers, status, connection, query, sortAsc]);
  const pages = Math.max(1, Math.ceil(rows.length / 8));
  const currentPage = Math.min(page, pages - 1);
  const changeQuery = (value: string) => {
    setQuery(value);
    setPage(0);
  };
  const exportRows = () =>
    exportCsv(
      "nexo-assinantes-demonstrativos",
      [
        "Código",
        "Assinante",
        "Plano",
        "Mensalidade",
        "Contrato",
        "Conexão",
        "Bairro",
      ],
      rows.map((s) => [
        s.code,
        s.name,
        s.plan,
        s.price,
        s.status,
        s.connection,
        s.neighborhood,
      ]),
    );
  return (
    <SubscriberDirectoryView
      description="Contrato, financeiro e conexão. Todo o contexto em uma única ficha."
      actions={
        <Button variant="outline" onClick={exportRows}>
          <Download data-icon="inline-start" />
          Exportar amostra
        </Button>
      }
      summary={[
        { icon: Users, value: data.subscribers.length, label: "assinantes na amostra" },
        { icon: Check, value: data.subscribers.filter((s) => s.status === "Ativo").length, label: "contratos ativos" },
        { icon: Wifi, value: data.subscribers.filter((s) => s.connection === "Online").length, label: "conexões online" },
        { icon: CreditCard, value: data.subscribers.filter((s) => s.status === "Suspenso").length, label: "contratos suspensos", warning: true },
      ]}
      panelDescription="Amostra de assinantes do workspace demonstrativo"
      badge={`${rows.length} registros`}
      tabs={["Todos", "Ativo", "Suspenso", "Em instalação"].map((s) => ({
        value: s,
        label: s === "Ativo" ? "Ativos" : s === "Suspenso" ? "Suspensos" : s,
        count: s === "Todos" ? data.subscribers.length : data.subscribers.filter(subscriber => subscriber.status === s).length,
      }))}
      status={status}
      onStatus={(v) => {
        setStatus(v);
        setPage(0);
      }}
      query={query}
      onQuery={changeQuery}
      searchPlaceholder="Nome, código ou bairro…"
      connection={{
        value: connection,
        options: ["Todas", "Online", "Offline", "Bloqueado", "Não provisionado"],
        onChange: (c) => {
          setConnection(c);
          setPage(0);
        },
      }}
      filters={[
        ...(query.trim() ? [{ label: `Busca: ${query.trim()}`, onRemove: () => changeQuery("") }] : []),
        ...(status !== "Todos" ? [{ label: `Contrato: ${status}`, onRemove: () => { setStatus("Todos"); setPage(0); } }] : []),
        ...(connection !== "Todas" ? [{ label: `Conexão: ${connection}`, onRemove: () => { setConnection("Todas"); setPage(0); } }] : []),
      ]}
      filteredCount={rows.length}
      onClearFilters={() => { setQuery(""); setStatus("Todos"); setConnection("Todas"); setPage(0); }}
      sortAsc={sortAsc}
      onToggleSort={() => setSortAsc(!sortAsc)}
      columns={{ connection: "Conexão", monthly: "Mensalidade" }}
      rows={rows.slice(currentPage * 8, currentPage * 8 + 8).map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        contact: s.email,
        plan: s.plan,
        status: s.status,
        connection: s.connection,
        locality: s.neighborhood,
        monthly: s.price,
      }))}
      onOpen={openSubscriber}
      empty={{ title: "Nenhuma conexão por aqui.", description: "Tente outro nome ou remova os filtros da busca." }}
      pagination={{
        start: rows.length ? currentPage * 8 + 1 : 0,
        end: Math.min(currentPage * 8 + 8, rows.length),
        total: rows.length,
        page: currentPage,
        pages,
        onPage: setPage,
      }}
      footer={
        <>
          <DemoNotice>
            Amostra fictícia de 24 assinantes. Os indicadores do panorama
            representam um cenário de provedor com 8.247 assinantes ativos.
          </DemoNotice>
          <SourceFooter sample="24 assinantes fictícios" />
        </>
      }
    />
  );
}

export function SubscriberDirectoryView({
  description,
  actions,
  before,
  summary,
  panelDescription,
  badge,
  tabs,
  status,
  onStatus,
  query,
  onQuery,
  searchPlaceholder,
  connection,
  filters,
  filteredCount,
  onClearFilters,
  sortAsc,
  onToggleSort,
  columns,
  rows,
  onOpen,
  empty,
  pagination,
  boundary = (content) => content,
  footer,
}: SubscriberDirectoryViewProps) {
  return (
    <>
      <PageHeading
        title="Assinantes"
        description={description}
        actions={actions}
      />
      {before}
      <div className="subscriber-summary">
        {summary.map(({ icon: Icon, value, label, warning }) => (
          <div key={label}>
            <span className={warning ? "summary-icon warning-summary" : "summary-icon"}>
              <Icon size={19} />
            </span>
            <span>
              <strong>{value}</strong>
              <small>{label}</small>
            </span>
          </div>
        ))}
      </div>
      <Panel
        title="Uma base. Todas as conexões."
        description={panelDescription}
        action={<Badge variant="outline">{badge}</Badge>}
        className="list-panel"
      >
        <div className="list-toolbar">
          <Tabs
            value={status}
            onValueChange={(v) => onStatus(String(v))}
          >
            <TabsList variant="line">
              {tabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value}>
                  {tab.label}
                  {tab.count !== undefined && <span className="tab-count">{tab.count}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="table-tools">
            <InputGroup className="subscriber-search">
              <InputGroupInput
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label="Buscar assinantes"
              />
              <InputGroupAddon><Search /></InputGroupAddon>
            </InputGroup>
            {connection && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label="Filtrar conexão"
                    />
                  }
                >
                  <SlidersHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Estado da conexão</DropdownMenuLabel>
                    {connection.options.map((c) => (
                      <DropdownMenuItem
                        key={c}
                        onClick={() => connection.onChange(c)}
                      >
                        {connection.value === c && <Check />}
                        {c}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <ActiveFilters count={filteredCount} onClear={onClearFilters} filters={filters} />
        {boundary(
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="checkbox-column">#</TableHead>
                  <TableHead aria-sort={sortAsc ? "ascending" : "descending"}>
                    <button
                      className="table-sort"
                      onClick={onToggleSort}
                    >
                      Assinante
                      <ArrowUpDown size={13} />
                    </button>
                  </TableHead>
                  <TableHead>Plano contratado</TableHead>
                  <TableHead>Status do contrato</TableHead>
                  <TableHead>{columns.connection}</TableHead>
                  <TableHead>Localidade</TableHead>
                  <TableHead className="text-right">{columns.monthly}</TableHead>
                  <TableHead>
                    <span className="sr-only">Abrir ficha</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="mono subtle">{s.code}</TableCell>
                    <TableCell>
                      <button
                        className="table-person"
                        onClick={() => onOpen(s.id)}
                      >
                        <PersonAvatar name={s.name} />
                        <span>
                          <strong>{s.name}</strong>
                          <small>{s.contact}</small>
                        </span>
                      </button>
                    </TableCell>
                    <TableCell>
                      <span className="plan-cell">
                        <Signal size={14} />
                        {s.plan}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Status value={s.status} />
                    </TableCell>
                    <TableCell className={columns.connectionStatus === false ? "subtle" : undefined}>
                      {columns.connectionStatus === false ? s.connection : <Status value={s.connection} />}
                    </TableCell>
                    <TableCell className="subtle">{s.locality}</TableCell>
                    <TableCell className="text-right mono">
                      {s.monthly === null ? "—" : money(s.monthly)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onOpen(s.id)}
                        aria-label={`Abrir ficha de ${s.name}`}
                      >
                        <ArrowUpRight />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length === 0 && (
              <EmptyState
                icon={Search}
                title={empty.title}
                description={empty.description}
              >
                <Button
                  variant="outline"
                  onClick={onClearFilters}
                >
                  Limpar filtros
                </Button>
              </EmptyState>
            )}
          </>,
        )}
        <div className="pagination">
          <span>
            {pagination.total
              ? `${pagination.start}–${pagination.end} de ${pagination.total} assinantes`
              : "Nenhum assinante encontrado"}
          </span>
          <div>
            {pagination.pageSize && (
              <select
                className="commercial-select"
                aria-label="Assinantes por página"
                value={pagination.pageSize.value}
                onChange={(e) => pagination.pageSize?.onChange(Number(e.target.value))}
              >
                {pagination.pageSize.options.map((size) => (
                  <option key={size} value={size}>{size} por página</option>
                ))}
              </select>
            )}
            <span>
              Página {pagination.page + 1} de {pagination.pages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Página anterior"
              disabled={pagination.page === 0}
              onClick={() => pagination.onPage(pagination.page - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Próxima página"
              disabled={pagination.page >= pagination.pages - 1}
              onClick={() => pagination.onPage(pagination.page + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </Panel>
      {footer}
    </>
  );
}
