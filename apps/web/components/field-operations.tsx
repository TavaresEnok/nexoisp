"use client";

import { useState } from "react";
import { useSearchParams } from "@/platform/navigation/react";
import { useQueryState } from "@/lib/use-query-state";
import {
  Wrench,
  CalendarDays,
  MapPin,
  Clock3,
  ArrowUpRight,
  Download,
  ChevronRight,
  UserRound,
  CircleCheck,
  Columns3,
  List,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Panel,
  PageHeading,
  Status,
  PersonAvatar,
  SourceFooter,
  DemoNotice,
} from "@/components/workspace-ui";
import { useWorkspace } from "@/components/workspace-provider";
import { exportCsv, scenarioDate, normalize } from "@/lib/format";
import { ServiceOrderDetails } from "@/components/service-order-details";
import { InputGroup, InputGroupInput, InputGroupAddon } from "@/components/ui/input-group";
import type { WorkOrder } from "@/lib/types";
import { EmptyState } from "@/components/workspace-feedback";
import { FieldOrderBoard } from "@/components/field-order-board";
import { cn } from "@/lib/utils";
import styles from "./operations.module.css";
import { selectOrders } from "@/application/selectors/operations";
import { fieldOrderViews } from "@/domain/view-states";

export function FieldOperations() {
  const { data, openSubscriber } = useWorkspace();
  const params = useSearchParams();
  const [filter, setFilter] = useQueryState("situacao", params.get("filtro") === "atrasadas" ? "Atrasada" : "Todas", ["Todas", ...data.orders.map(o => o.status)]);
  const [query, setQuery] = useQueryState("busca", "");
  const [view, setView] = useQueryState("visualizacao", "board", fieldOrderViews);
  const [technician, setTechnician] = useQueryState("tecnico", "Todos", ["Todos", ...data.orders.map(o => o.technician)]);
  const [selected, setSelected] = useState<WorkOrder | null>(null);
  const rows = selectOrders(data.orders, filter, technician, query);
  const technicians = [...new Set(data.orders.map((o) => o.technician))];
  const completed = data.orders.filter((o) => o.status === "Concluída").length;
  const resetFilters = () => {
    setQuery("");
    setFilter("Todas");
    setTechnician("Todos");
  };
  return (
    <>
      <PageHeading
        title="Ordens de serviço"
        description="Agenda, contexto e execução alinhados para a próxima visita."
        actions={
          <Button
            variant="outline"
            onClick={() =>
              exportCsv(
                "nexo-agenda-demonstrativa",
                [
                  "OS",
                  "Horário",
                  "Serviço",
                  "Assinante fictício",
                  "Bairro",
                  "Técnico",
                  "Status",
                ],
                rows.map((o) => [
                  o.code,
                  o.time,
                  o.type,
                  o.name,
                  o.neighborhood,
                  o.technician,
                  o.status,
                ]),
              )
            }
          >
            <Download data-icon="inline-start" />
            Exportar agenda
          </Button>
        }
      />
      <div className={cn("field-top-strip", styles.overview)}>
        <div>
          <CalendarDays size={19} />
          <span>
            <strong>{scenarioDate(data.snapshot.asOf, "weekday")}</strong>
            <small>Agenda demonstrativa · 2026</small>
          </span>
        </div>
        <div>
          <span className="live-dot" />
          {data.orders.length} visitas programadas
        </div>
        <div className={styles.completion}>
          <span><CircleCheck size={14} />{completed}/{data.orders.length} concluídas</span>
          <progress value={completed} max={data.orders.length || 1} aria-label="Conclusão das visitas da agenda" />
        </div>
        <div className="text-danger">
          <Clock3 size={16} />
          {data.orders.filter((o) => o.status === "Atrasada").length} atrasadas
        </div>
      </div>
      <div className={styles.layout}>
        <Panel
          title="Agendamentos e ordens de serviço"
          description="A mesma agenda, organizada para acompanhar cada visita."
          action={<Badge variant="outline">17 OUT</Badge>}
          className={cn("field-agenda", styles.agendaPanel)}
        >
          <Tabs value={view} onValueChange={(value) => setView(String(value))} className={styles.views}>
            <div className={styles.toolbar}>
              <TabsList aria-label="Visualização das ordens de serviço">
                <TabsTrigger value="board"><Columns3 data-icon="inline-start" />Quadro de OS</TabsTrigger>
                <TabsTrigger value="agenda"><List data-icon="inline-start" />Agenda</TabsTrigger>
              </TabsList>
              <div className={styles.agendaSearch}><InputGroup><InputGroupInput aria-label="Buscar ordens de serviço" placeholder="Buscar OS, assinante ou técnico…" value={query} onChange={event => setQuery(event.target.value)} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup></div>
              <span className={styles.selection} aria-live="polite">{rows.length} OS · {technician === "Todos" ? "Todos os técnicos" : technician}</span>
            </div>
            <div className={styles.filters}>
          <Tabs value={filter} onValueChange={(v) => setFilter(String(v))}>
            <TabsList variant="line">
              {[
                "Todas",
                "Agendada",
                "Em execução",
                "Atrasada",
                "Concluída",
              ].map((v) => (
                <TabsTrigger key={v} value={v}>
                  {v === "Agendada"
                    ? "Agendadas"
                    : v === "Atrasada"
                      ? "Atrasadas"
                      : v === "Concluída"
                        ? "Concluídas"
                        : v}
                  <span className={styles.filterCount}>{data.orders.filter((order) => (v === "Todas" || order.status === v) && (technician === "Todos" || order.technician === technician) && normalize(`${order.name} ${order.code} ${order.type} ${order.technician} ${order.neighborhood}`).includes(normalize(query.trim()))).length}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
            </div>
            <TabsContent value="board"><FieldOrderBoard orders={rows} onSelect={setSelected} onReset={resetFilters} /></TabsContent>
            <TabsContent value="agenda">
          <div className="field-orders">
            {rows.map((o) => (
              <button
                className="field-order"
                key={o.id}
                onClick={() => setSelected(o)}
              >
                <div className="field-order-time">
                  <strong>{o.time}</strong>
                  <small>{o.duration} min</small>
                  <span />
                </div>
                <div className="field-order-main">
                  <div>
                    <span className="mono subtle">OS #{o.code}</span>
                    <Status value={o.status} />
                  </div>
                  <h3>{o.type}</h3>
                  <p>
                    {o.name}
                    <span>·</span>
                    <MapPin size={12} />
                    {o.neighborhood}
                  </p>
                  <div className="field-order-tech">
                    <PersonAvatar name={o.technician} small />
                    {o.technician}
                  </div>
                </div>
                <ArrowUpRight size={17} />
              </button>
            ))}
            {rows.length === 0 && (
              <EmptyState
                icon={CalendarDays}
                title="Nenhuma visita nesta seleção."
                description="Troque o técnico ou o status para consultar a agenda."
              >
                <Button
                  variant="outline"
                  onClick={resetFilters}
                >
                  Ver agenda completa
                </Button>
              </EmptyState>
            )}
          </div>
            </TabsContent>
          </Tabs>
        </Panel>
        <div className="field-sidebar">
          <Panel
            title="Quem está em campo"
            description="Distribuição das visitas por técnico"
          >
            <button
              className={cn("technician-row", technician === "Todos" && "technician-selected")}
              aria-pressed={technician === "Todos"}
              onClick={() => setTechnician("Todos")}
            >
              <span className="summary-icon">
                <UserRound size={18} />
              </span>
              <span>
                <strong>Todos os técnicos</strong>
                <small>{data.orders.length} visitas na agenda</small>
              </span>
              <ChevronRight size={15} />
            </button>
            {technicians.map((t) => {
              const all = data.orders.filter((o) => o.technician === t);
              const done = all.filter((o) => o.status === "Concluída").length;
              return (
                <button
                  className={cn("technician-row", technician === t && "technician-selected")}
                  aria-pressed={technician === t}
                  key={t}
                  onClick={() => setTechnician(t)}
                >
                  <PersonAvatar name={t} />
                  <span>
                    <strong>{t}</strong>
                    <small>
                      {done} de {all.length} visitas concluídas
                    </small>
                    <span className="technician-progress">
                      <i style={{ width: `${(done / all.length) * 100}%` }} />
                    </span>
                  </span>
                  <ChevronRight size={15} />
                </button>
              );
            })}
          </Panel>
          <section className="field-context-card">
            <span className="summary-icon">
              <Wrench size={22} />
            </span>
            <h3>Chegue com contexto.</h3>
            <p>
              O técnico e o atendimento olham para a mesma história. Abra a OS
              para consultar assinante, conexão e observações da visita.
            </p>
            <span>
              <CircleCheck size={14} />
              Sem troca de abas. Sem informação perdida.
            </span>
          </section>
        </div>
      </div>
      <DemoNotice>
        Visitas e técnicos fictícios. A agenda não utiliza geolocalização e não
        representa deslocamentos em tempo real.
      </DemoNotice>
      <SourceFooter sample="8 ordens de serviço fictícias" />
      <Dialog
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <DialogContent className={cn("order-dialog", styles.dialog, styles.orderDetailsDialog)}>
          <DialogHeader>
            <p className="eyebrow">
              ORDEM DE SERVIÇO <span className="mono">#{selected?.code}</span>
            </p>
            <DialogTitle>{selected?.type}</DialogTitle>
            <DialogDescription>
              Agenda de {scenarioDate(data.snapshot.asOf, "full")} · demonstração
            </DialogDescription>
          </DialogHeader>
          {selected && <ServiceOrderDetails
            key={selected.id}
            order={selected}
            subscriber={data.subscribers.find(subscriber => subscriber.id === selected.subscriberId)}
            provider={data.snapshot.provider}
            reference={data.snapshot.asOf}
            onOpenSubscriber={() => { const id = selected.subscriberId; setSelected(null); openSubscriber(id); }}
          />}
        </DialogContent>
      </Dialog>
    </>
  );
}
