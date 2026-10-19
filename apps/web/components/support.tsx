"use client";

import { useState } from "react";
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
import { useWorkspace } from "@/components/workspace-provider";
import {
  Panel,
  PageHeading,
  Status,
  PersonAvatar,
  SourceFooter,
  DemoNotice,
} from "@/components/workspace-ui";
import { exportCsv } from "@/lib/format";
import type { Ticket } from "@/lib/types";
import { EmptyState, ContextCallout } from "@/components/workspace-feedback";
import { cn } from "@/lib/utils";
import styles from "./operations.module.css";
import { selectTickets } from "@/application/selectors/operations";

export function Support() {
  const { data, openSubscriber } = useWorkspace();
  const params = useSearchParams();
  const [filter, setFilter] = useQueryState("situacao", params.get("filtro") === "aguardando" ? "Aguardando" : "Todos", ["Todos", "Em risco", ...data.tickets.map(t => t.status)]);
  const [query, setQuery] = useQueryState("busca", "");
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [rules, setRules] = useState(false);
  const rows = selectTickets(data.tickets, filter, query);
  const stats = [
    { label: "Na amostra", value: data.tickets.length, icon: Headphones },
    {
      label: "Aguardando",
      value: data.tickets.filter((t) => t.status === "Aguardando").length,
      icon: Clock3,
    },
    {
      label: "Em atendimento",
      value: data.tickets.filter((t) => t.status === "Em atendimento").length,
      icon: MessageCircle,
    },
    {
      label: "SLA em risco",
      value: data.tickets.filter((t) => t.sla === "Em risco").length,
      icon: ShieldAlert,
    },
  ];
  return (
    <>
      <PageHeading
        title="Atendimentos"
        description="Uma fila organizada. Um assinante compreendido. Uma resolução melhor."
        actions={
          <>
            <Button variant="outline" onClick={() => setRules(true)}>
              <ListFilter data-icon="inline-start" />
              Critérios da fila
            </Button>
            <Button
              variant="outline"
              onClick={() =>
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
              }
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
      <Panel
        title="Nenhuma conversa fica para trás"
        description={`${data.tickets.length} chamados da amostra demonstrativa · ordenados por abertura`}
        action={<Badge variant="outline">WhatsApp e telefone · cenário</Badge>}
        className={cn("list-panel", styles.supportPanel)}
      >
        <div className={cn("list-toolbar", styles.supportToolbar)}>
          <Tabs value={filter} onValueChange={(v) => setFilter(String(v))}>
            <TabsList variant="line">
              {[
                "Todos",
                "Aguardando",
                "Em atendimento",
                "Em risco",
                "Resolvido",
              ].map((s) => (
                <TabsTrigger key={s} value={s}>
                  {s === "Resolvido" ? "Resolvidos" : s}
                  <span className={styles.filterCount}>{data.tickets.filter((ticket) => s === "Todos" || (s === "Em risco" ? ticket.sla === "Em risco" : ticket.status === s)).length}</span>
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
        <Table>
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
                    onClick={() => setSelected(t)}
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
                    onClick={() => setSelected(t)}
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
            description="Ajuste os filtros para explorar a fila demonstrativa."
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
      </Panel>
      <DemoNotice>
        A fila é uma amostra de 12 chamados. O panorama mostra 24 chamados no
        cenário completo. Não há envio real de mensagens.
      </DemoNotice>
      <SourceFooter sample="Fila demonstrativa" />
      <Sheet
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent className="ticket-sheet">
          {selected && (
            <>
              <SheetHeader>
                <p className="eyebrow">
                  ATENDIMENTO <span className="mono">#{selected.code}</span>
                </p>
                <SheetTitle>{selected.subject}</SheetTitle>
                <SheetDescription>
                  {selected.category} · {selected.channel} · 17 out. 2026
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
                    setSelected(null);
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
                      <dt>Entrada no cenário</dt>
                      <dd>{selected.opened.slice(11, 16)}</dd>
                    </div>
                    <div>
                      <dt>Categoria</dt>
                      <dd>{selected.category}</dd>
                    </div>
                  </dl>
                </section>
                {selected.priority === "Alta" && (
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
                        setSelected(null);
                        openSubscriber(id);
                      }}
                    >
                      Consultar conexão do assinante
                      <ArrowRight size={14} />
                    </button>
                  </ContextCallout>
                )}
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
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
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
