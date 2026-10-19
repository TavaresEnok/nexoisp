"use client";

import { useMemo, useState } from "react";
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
import { useWorkspace } from "@/components/workspace-provider";
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
    <>
      <PageHeading
        title="Assinantes"
        description="Contrato, financeiro e conexão. Todo o contexto em uma única ficha."
        actions={
          <Button variant="outline" onClick={exportRows}>
            <Download data-icon="inline-start" />
            Exportar amostra
          </Button>
        }
      />
      <div className="subscriber-summary">
        <div>
          <span className="summary-icon">
            <Users size={19} />
          </span>
          <span>
            <strong>{data.subscribers.length}</strong>
            <small>assinantes na amostra</small>
          </span>
        </div>
        <div>
          <span className="summary-icon">
            <Check size={19} />
          </span>
          <span>
            <strong>
              {data.subscribers.filter((s) => s.status === "Ativo").length}
            </strong>
            <small>contratos ativos</small>
          </span>
        </div>
        <div>
          <span className="summary-icon">
            <Wifi size={19} />
          </span>
          <span>
            <strong>
              {data.subscribers.filter((s) => s.connection === "Online").length}
            </strong>
            <small>conexões online</small>
          </span>
        </div>
        <div>
          <span className="summary-icon warning-summary">
            <CreditCard size={19} />
          </span>
          <span>
            <strong>
              {data.subscribers.filter((s) => s.status === "Suspenso").length}
            </strong>
            <small>contratos suspensos</small>
          </span>
        </div>
      </div>
      <Panel
        title="Uma base. Todas as conexões."
        description="Amostra de assinantes do workspace demonstrativo"
        action={<Badge variant="outline">{rows.length} registros</Badge>}
        className="list-panel"
      >
        <div className="list-toolbar">
          <Tabs
            value={status}
            onValueChange={(v) => {
              setStatus(String(v));
              setPage(0);
            }}
          >
            <TabsList variant="line">
              {["Todos", "Ativo", "Suspenso", "Em instalação"].map((s) => (
                <TabsTrigger key={s} value={s}>
                  {s === "Ativo"
                    ? "Ativos"
                    : s === "Suspenso"
                      ? "Suspensos"
                      : s}
                  <span className="tab-count">{s === "Todos" ? data.subscribers.length : data.subscribers.filter(subscriber => subscriber.status === s).length}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="table-tools">
            <InputGroup className="subscriber-search">
              <InputGroupInput
                value={query}
                onChange={(e) => changeQuery(e.target.value)}
                placeholder="Nome, código ou bairro…"
                aria-label="Buscar assinantes"
              />
              <InputGroupAddon><Search /></InputGroupAddon>
            </InputGroup>
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
                  {[
                    "Todas",
                    "Online",
                    "Offline",
                    "Bloqueado",
                    "Não provisionado",
                  ].map((c) => (
                    <DropdownMenuItem
                      key={c}
                      onClick={() => {
                        setConnection(c);
                        setPage(0);
                      }}
                    >
                      {connection === c && <Check />}
                      {c}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ActiveFilters count={rows.length} onClear={() => { setQuery(""); setStatus("Todos"); setConnection("Todas"); setPage(0); }} filters={[
          ...(query.trim() ? [{ label: `Busca: ${query.trim()}`, onRemove: () => changeQuery("") }] : []),
          ...(status !== "Todos" ? [{ label: `Contrato: ${status}`, onRemove: () => { setStatus("Todos"); setPage(0); } }] : []),
          ...(connection !== "Todas" ? [{ label: `Conexão: ${connection}`, onRemove: () => { setConnection("Todas"); setPage(0); } }] : []),
        ]} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="checkbox-column">#</TableHead>
              <TableHead aria-sort={sortAsc ? "ascending" : "descending"}>
                <button
                  className="table-sort"
                  onClick={() => setSortAsc(!sortAsc)}
                >
                  Assinante
                  <ArrowUpDown size={13} />
                </button>
              </TableHead>
              <TableHead>Plano contratado</TableHead>
              <TableHead>Status do contrato</TableHead>
              <TableHead>Conexão</TableHead>
              <TableHead>Localidade</TableHead>
              <TableHead className="text-right">Mensalidade</TableHead>
              <TableHead>
                <span className="sr-only">Abrir ficha</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(currentPage * 8, currentPage * 8 + 8).map((s) => (
              <TableRow key={s.id}>
                <TableCell className="mono subtle">{s.code}</TableCell>
                <TableCell>
                  <button
                    className="table-person"
                    onClick={() => openSubscriber(s.id)}
                  >
                    <PersonAvatar name={s.name} />
                    <span>
                      <strong>{s.name}</strong>
                      <small>{s.email}</small>
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
                <TableCell>
                  <Status value={s.connection} />
                </TableCell>
                <TableCell className="subtle">{s.neighborhood}</TableCell>
                <TableCell className="text-right mono">
                  {money(s.price)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => openSubscriber(s.id)}
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
            title="Nenhuma conexão por aqui."
            description="Tente outro nome ou remova os filtros da busca."
          >
            <Button
              variant="outline"
              onClick={() => {
                setQuery("");
                setStatus("Todos");
                setConnection("Todas");
              }}
            >
              Limpar filtros
            </Button>
          </EmptyState>
        )}
        <div className="pagination">
          <span>
            {rows.length
              ? `${currentPage * 8 + 1}–${Math.min(currentPage * 8 + 8, rows.length)} de ${rows.length} assinantes`
              : "Nenhum assinante encontrado"}
          </span>
          <div>
            <span>
              Página {currentPage + 1} de {pages}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Página anterior"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Próxima página"
              disabled={currentPage === pages - 1}
              onClick={() => setPage(currentPage + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </Panel>
      <DemoNotice>
        Amostra fictícia de 24 assinantes. Os indicadores do panorama
        representam um cenário de provedor com 8.247 assinantes ativos.
      </DemoNotice>
      <SourceFooter sample="24 assinantes fictícios" />
    </>
  );
}
