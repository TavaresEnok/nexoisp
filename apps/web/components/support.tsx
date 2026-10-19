"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "@/platform/navigation/react";
import { useQueryState } from "@/lib/use-query-state";
import {
  Search,
  ArrowUpRight,
  Headphones,
  Clock3,
  ShieldAlert,
  MessageCircle,
  ListFilter,
  Download,
  UserRound,
  ArrowRight,
  Info,
  CircleCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useWorkspace } from "@/features/workspace/context";
import {
  Panel,
  PageHeading,
  Status,
  PersonAvatar,
  SourceFooter,
  DemoNotice,
} from "@/components/workspace-ui";
import { exportCsv, date } from "@/lib/format";
import type { Ticket } from "@/lib/types";
import { EmptyState, ContextCallout } from "@/components/workspace-feedback";
import { cn } from "@/lib/utils";
import styles from "./operations.module.css";
import { QueryBoundary } from "@/features/shared/feedback";
import { selectTickets } from "@/application/selectors/operations";

export function Support() {
  const { data, openSubscriber } = useWorkspace();
  return <TicketQueue tickets={data.tickets} openSubscriber={openSubscriber} />;
}
type TicketDisplay = Omit<Ticket, "wait">;
export function TicketQueue({ tickets, openSubscriber, operational = false, actions, controls, onOpen, onExport, pagination, loading, error, total, embedded = false }: { tickets: TicketDisplay[]; openSubscriber: (id: string) => void; operational?: boolean; actions?: ReactNode; controls?: ReactNode; onOpen?: (ticket: TicketDisplay) => void; onExport?: () => void; pagination?: ReactNode; loading?: boolean; error?: unknown; total?: number; embedded?: boolean }) {
  const params = useSearchParams();
  const [filter, setFilter] = useQueryState("situacao", operational ? params.get("filtro") === "aguardando" ? "Aguardando o provedor" : "Pendentes" : params.get("filtro") === "aguardando" ? "Aguardando" : "Todos", operational ? ["Pendentes", "Todos", "Aguardando o provedor", "Aguardando o assinante", "Encerrado"] : ["Todos", "Em risco", ...tickets.map(t => t.status)], { resetPage: operational });
  const [query, setQuery] = useQueryState("busca", "", undefined, { resetPage: operational });
  const [selected, setSelected] = useState<TicketDisplay | null>(null);
  const [rules, setRules] = useState(false);
  const rows = operational ? tickets : selectTickets(tickets, filter, query);
  const openTicket = (ticket: TicketDisplay) => onOpen ? onOpen(ticket) : setSelected(ticket);
  const stats = [
    { label: operational ? "Na consulta" : "Na amostra", value: total ?? tickets.length, icon: Headphones },
    {
      label: operational ? "Provedor · nesta página" : "Aguardando",
      value: tickets.filter((t) => t.status === (operational ? "Aguardando o provedor" : "Aguardando")).length,
      icon: Clock3,
    },
    {
      label: operational ? "Assinante · nesta página" : "Em atendimento",
      value: tickets.filter((t) => t.status === (operational ? "Aguardando o assinante" : "Em atendimento")).length,
      icon: MessageCircle,
    },
    {
      label: operational ? "Prazo estourado · página" : "SLA em risco",
      value: tickets.filter((t) => t.sla === (operational ? "Estourado" : "Em risco")).length,
      icon: ShieldAlert,
    },
  ];
  return (
    <>
      {!embedded && <><PageHeading
        title="Atendimentos"
        description="Uma fila organizada. Um assinante compreendido. Uma resolução melhor."
        actions={
          <>
            {actions}{!operational && <Button variant="outline" onClick={() => setRules(true)}>
              <ListFilter data-icon="inline-start" />
              Critérios da fila
            </Button>}
            <Button
              variant="outline"
              onClick={onExport ?? (() =>
                exportCsv(
                  "nexo-atendimentos-demonstrativos",
                  [
                    "Chamado",
                    "Assinante",
                    "Assunto",
                    "Status",
                    "Prioridade",
                    "SLA",
                  ],
                  rows.map((t) => [
                    t.code,
                    t.name,
                    t.subject,
                    t.status,
                    t.priority,
                    t.sla,
                  ]),
                )
              )}
            >
              <Download data-icon="inline-start" />
              Exportar fila
            </Button>
          </>
        }
      />
      <div className="subscriber-summary">
        {stats.map((s) => (
          <div key={s.label}>
            <span className="summary-icon">
              <s.icon size={19} />
            </span>
            <span>
              <strong>{s.value.toString().padStart(2, "0")}</strong>
              <small>{s.label}</small>
            </span>
          </div>
        ))}
      </div>
      </>}<Panel
        title="Nenhuma conversa fica para trás"
        description={operational ? "Consulta paginada, ordenada por atualização; indicadores de situação são desta página." : `${tickets.length} chamados da amostra demonstrativa · ordenados por abertura`}
        action={<>{embedded && actions}<Badge variant="outline">{operational ? "Protocolos do ERP" : "WhatsApp e telefone · cenário"}</Badge></>}
        className={cn("list-panel", styles.supportPanel)}
      >
        {!embedded && <div className={cn("list-toolbar", styles.supportToolbar)}>
          <Tabs value={filter} onValueChange={(v) => setFilter(String(v))}>
            <TabsList variant="line">
              {(operational ? ["Pendentes", "Todos", "Aguardando o provedor", "Aguardando o assinante", "Encerrado"] : ["Todos", "Aguardando", "Em atendimento", "Em risco", "Resolvido"]).map((s) => (
                <TabsTrigger key={s} value={s}>
                  {s === "Resolvido" ? "Resolvidos" : s}
                  {!operational && <span className={styles.filterCount}>{tickets.filter((ticket) => s === "Todos" || (s === "Em risco" ? ticket.sla === (operational ? "Estourado" : "Em risco") : ticket.status === s)).length}</span>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="search-field">
            <Search size={15} />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nome, assunto ou chamado…"
              aria-label="Buscar atendimentos"
            />
          </div>
        </div>
        }{controls}<QueryBoundary loading={loading} error={error}><Table>
          <TableHeader>
            <TableRow>
              <TableHead>Chamado / assunto</TableHead>
              <TableHead>Assinante</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Prioridade</TableHead>
              <TableHead>Responsável</TableHead>
              <TableHead>SLA</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((t) => (
              <TableRow key={t.id} className={styles.supportRow} data-sla={t.sla} data-status={t.status}>
                <TableCell>
                  <button
                    className="ticket-subject"
                    onClick={() => openTicket(t)}
                  >
                    <span className="mono subtle">
                      #{t.code}
                      <span className="ticket-channel">{t.channel}</span>
                    </span>
                    <strong>{t.subject}</strong>
                  </button>
                </TableCell>
                <TableCell>
                  <button
                    className="table-person"
                    onClick={() => openSubscriber(t.subscriberId)}
                  >
                    <PersonAvatar name={t.name} small />
                    <span>
                      <strong>{t.name}</strong>
                      <small>{t.category}</small>
                    </span>
                  </button>
                </TableCell>
                <TableCell>
                  <Status value={t.status} />
                </TableCell>
                <TableCell>
                  <Status value={t.priority} dot={false} />
                </TableCell>
                <TableCell className="subtle">
                  {t.agent === "Não atribuído" ? (
                    <span className="unassigned">Não atribuído</span>
                  ) : (
                    t.agent
                  )}
                </TableCell>
                <TableCell>
                  <Status value={t.sla} />
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Ver chamado ${t.code}`}
                    onClick={() => openTicket(t)}
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
            icon={CircleCheck}
            title="Nenhum chamado por aqui."
            description={operational ? "Ajuste a busca e a situação para consultar os protocolos." : "Ajuste os filtros para explorar a fila demonstrativa."}
          >
            <Button
              variant="outline"
              onClick={() => {
                setFilter("Todos");
                setQuery("");
              }}
            >
              Ver todos
            </Button>
          </EmptyState>
        )}
        <div className="table-total">
          <span aria-live="polite">{rows.length} chamados na seleção</span>
          <span>
            Contexto compartilhado entre atendimento, financeiro e rede.
          </span>
        </div>
        </QueryBoundary>{pagination}
      </Panel>
      {!operational && <><DemoNotice>
        A fila é uma amostra de 12 chamados. O panorama mostra 24 chamados no
        cenário completo. Não há envio real de mensagens.
      </DemoNotice>
      <SourceFooter sample="Fila demonstrativa" /></>}
      <TicketDetails ticket={selected} onClose={() => setSelected(null)} openSubscriber={openSubscriber} />
      <Dialog open={rules} onOpenChange={setRules}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uma fila com critérios claros</DialogTitle>
            <DialogDescription>
              Como ler este cenário de atendimento.
            </DialogDescription>
          </DialogHeader>
          <div className="help-feature">
            <ShieldAlert />
            <div>
              <strong>SLA em risco</strong>
              <p>
                Sinaliza um chamado que requer atenção imediata. Não é um
                cronômetro em tempo real.
              </p>
            </div>
          </div>
          <div className="help-feature">
            <UserRound />
            <div>
              <strong>Responsabilidade explícita</strong>
              <p>
                Os chamados sem responsável continuam identificados como não
                atribuídos.
              </p>
            </div>
          </div>
          <div className="help-feature">
            <Headphones />
            <div>
              <strong>Contexto antes da ação</strong>
              <p>
                Abra o assinante a partir de qualquer chamado para entender
                contrato, conexão e financeiro.
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function TicketDetails({ticket:selected,onClose,openSubscriber,operational=false,children,isOpen,loading,error}:{ticket:TicketDisplay|null;onClose:()=>void;openSubscriber:(id:string)=>void;operational?:boolean;children?:ReactNode;isOpen?:boolean;loading?:boolean;error?:unknown}) {
 return (      <Sheet
        open={isOpen ?? !!selected}
        onOpenChange={(open) => !open && onClose()}
      >
        <SheetContent className="ticket-sheet">
          {!selected && <SheetHeader><SheetTitle>Atendimento</SheetTitle><SheetDescription>Consulta ao protocolo do provedor.</SheetDescription></SheetHeader>}<QueryBoundary loading={loading} error={error}>{selected && (
            <>
              <SheetHeader>
                <p className="eyebrow">
                  ATENDIMENTO <span className="mono">#{selected.code}</span>
                </p>
                <SheetTitle>{selected.subject}</SheetTitle>
                <SheetDescription>
                  {selected.category} · {selected.channel} · {operational ? date(selected.opened) : "17 out. 2026"}
                </SheetDescription>
                <div className="subscriber-statuses">
                  <Status value={selected.status} />
                  <Status value={selected.sla} />
                </div>
              </SheetHeader>
              <div className="sheet-content-body">
                <button
                  className="ticket-subscriber-card"
                  onClick={() => {
                    const id = selected.subscriberId;
                    onClose();
                    openSubscriber(id);
                  }}
                >
                  <PersonAvatar name={selected.name} />
                  <span>
                    <strong>{selected.name}</strong>
                    <small>Contrato, faturas e conexão no mesmo lugar</small>
                  </span>
                  <ArrowUpRight size={18} />
                </button>
                <section className="detail-section">
                  <h3>Antes de responder</h3>
                  <dl className="detail-grid">
                    <div>
                      <dt>Responsável</dt>
                      <dd>{selected.agent}</dd>
                    </div>
                    <div>
                      <dt>Prioridade</dt>
                      <dd>
                        <Status value={selected.priority} />
                      </dd>
                    </div>
                    <div>
                      <dt>{operational ? "Abertura" : "Entrada no cenário"}</dt>
                      <dd>{operational ? date(selected.opened) : selected.opened.slice(11, 16)}</dd>
                    </div>
                    <div>
                      <dt>Categoria</dt>
                      <dd>{selected.category}</dd>
                    </div>
                  </dl>
                </section>
                {!operational && selected.priority === "Alta" && (
                  <ContextCallout
                    icon={ShieldAlert}
                    title="Possível causa compartilhada."
                  >
                    <p>
                      Há um incidente óptico no POP Norte. Consulte a conexão e
                      evite tratar um evento de rede como falha isolada.
                    </p>
                    <button
                      onClick={() => {
                        const id = selected.subscriberId;
                        onClose();
                        openSubscriber(id);
                      }}
                    >
                      Consultar conexão do assinante
                      <ArrowRight size={14} />
                    </button>
                  </ContextCallout>
                )}
                {operational ? children : <>
                <section className="detail-section">
                  <h3>Roteiro de resolução</h3>
                  <ol className="resolution-steps">
                    <li>
                      <span>1</span>
                      <div>
                        <strong>Entender o contexto</strong>
                        <p>
                          Confira o histórico do assinante e o estado do
                          contrato.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>2</span>
                      <div>
                        <strong>Verificar causas relacionadas</strong>
                        <p>
                          Analise faturas e alertas de rede antes de intervir.
                        </p>
                      </div>
                    </li>
                    <li>
                      <span>3</span>
                      <div>
                        <strong>Registrar e acompanhar</strong>
                        <p>
                          Em produção, a interação deve manter responsável,
                          prazo e trilha de auditoria.
                        </p>
                      </div>
                    </li>
                  </ol>
                </section>
                <p className="demo-notice">
                  <Info size={14} />
                  Demonstração de consulta. Nenhuma conversa real foi carregada.
                </p>
                </>}
              </div>
            </>
          )}</QueryBoundary>
        </SheetContent>
      </Sheet>);
}
